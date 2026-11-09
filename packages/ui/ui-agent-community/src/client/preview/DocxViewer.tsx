/**
 * .docx preview for the in-panel preview dock.
 *
 * docx-preview walks the OOXML package and paints the document as real DOM — a
 * `.docx-wrapper` holding one `section.docx` per page — so the bytes go straight from
 * the preview RPC to the dock with no canvas or worker involved. This component adds
 * the part docx-preview leaves to the host: the zoom / fit-width toolbar, page framing,
 * and loading / error / empty states.
 *
 * The document's own stylesheets are injected into a private container that is emptied
 * on unmount, so a closed preview leaves no CSS or DOM behind. Styling is inline styles
 * plus DSH theme tokens only; the pages themselves stay black-on-white like any desktop
 * document viewer so dark mode cannot invert the document's own colours.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { renderAsync } from 'docx-preview'
import type { ViewerProps } from './types.ts'

/** Visual gutter between the page and the dock edge, in unzoomed CSS pixels. */
const GUTTER = 16
/** Manual zoom range (the fit-width result is capped separately). */
const MIN_ZOOM = 0.25
const MAX_ZOOM = 3
/** Fit width never enlarges a page past this, so a short document stays readable. */
const FIT_MAX_ZOOM = 1.5
const ZOOM_STEP = 0.1
/** A4 @ 96 dpi — fallback page box for packages that omit `<w:pgSz>` (hand-built .docx). */
const FALLBACK_PAGE_WIDTH = 794
const FALLBACK_PAGE_HEIGHT = 1123
/** 2.54 cm — fallback page margin when the package omits `<w:pgMar>` as well. */
const FALLBACK_PAGE_MARGIN = 96

const DOCX_OPTIONS = {
  inWrapper: true,
  breakPages: true,
  ignoreWidth: false,
  ignoreHeight: false,
  renderHeaders: true,
  renderFooters: true,
  useBase64URL: true,
} as const

type ViewerState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly message: string }

// ── toolbar chrome (inline styles + DSH tokens, matching the dock's own look) ──

const TOOLBAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flex: '0 0 auto',
  padding: '4px 8px',
  borderBottom: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)',
  background: 'var(--dsw-alias-bg-elevated, #ffffff)',
  whiteSpace: 'nowrap',
}

const BUTTON_STYLE: CSSProperties = {
  height: 22,
  minWidth: 24,
  padding: '0 6px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary, #1b2129)',
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: '20px',
  cursor: 'pointer',
}

const BUTTON_ACTIVE_STYLE: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-strong, #b8c0cc)',
  background: 'var(--dsw-alias-bg-secondary, #f2f4f7)',
}

// ── docx-preview post-processing helpers ─────────────────────────────────────

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.trim() === '' ? error.name : error.message
  return String(error)
}

function pagesOf(wrapper: HTMLElement): HTMLElement[] {
  return Array.from(wrapper.querySelectorAll<HTMLElement>('section.docx'))
}

/**
 * Hand-built packages (and some generators) carry no `<w:pgSz>`, so docx-preview emits
 * shrink-wrapped sections instead of page boxes. Give those an A4 page so the preview
 * still reads as a document; packages that do declare a size are left untouched.
 */
function applyPageFallback(page: HTMLElement): void {
  if (page.style.width === '') page.style.setProperty('width', `${FALLBACK_PAGE_WIDTH}px`)
  if (page.style.minHeight === '') page.style.setProperty('min-height', `${FALLBACK_PAGE_HEIGHT}px`)
  // `<w:pgMar>` missing too: keep the text off the page edge instead of at (0, 0).
  if (page.style.paddingLeft === '') page.style.setProperty('padding', `${FALLBACK_PAGE_MARGIN}px`)
}

function decoratePage(page: HTMLElement): void {
  page.style.setProperty('margin', '0 auto 24px')
  page.style.setProperty('background', '#ffffff')
  page.style.setProperty('border', '1px solid var(--dsw-alias-border-secondary, #e4e7eb)')
  page.style.setProperty('box-shadow', '0 2px 10px rgba(15, 23, 42, 0.12)')
}

/** Override docx-preview's gray page-layout background with the dock's own surface. */
function decorateWrapper(wrapper: HTMLElement): void {
  wrapper.style.setProperty('display', 'block')
  wrapper.style.setProperty('padding', `${GUTTER}px`)
  wrapper.style.setProperty('background', 'transparent')
}

/** True when the render produced something worth showing (text, image, table, shape…). */
function hasContent(wrapper: HTMLElement): boolean {
  if (wrapper.querySelectorAll('section.docx').length === 0) return false
  if ((wrapper.textContent ?? '').trim() !== '') return true
  return wrapper.querySelector('img, svg, table, object, canvas') !== null
}

/**
 * docx-preview copies hyperlink relationship targets straight into `<a href>`, so an
 * untrusted package could smuggle in a `javascript:` URL or make a click navigate the
 * whole panel away. Keep web/mail links (opened out-of-panel) and drop everything else.
 */
function hardenLinks(wrapper: HTMLElement): void {
  for (const link of wrapper.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('#')) continue // in-document bookmark
    let protocol = ''
    try {
      protocol = new URL(href, window.location.href).protocol
    } catch {
      link.removeAttribute('href')
      continue
    }
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
    } else {
      link.removeAttribute('href')
    }
  }
}

// ── the viewer ───────────────────────────────────────────────────────────────

export function DocxViewer({ bytes, name }: ViewerProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const styleRef = useRef<HTMLDivElement | null>(null)
  const wrapperRef = useRef<HTMLElement | null>(null)
  const zoomRef = useRef(1)
  /** Whether resizes should re-run the fit (state mirror, read from observers/handlers). */
  const fitRef = useRef(true)
  const [state, setState] = useState<ViewerState>({ kind: 'loading' })
  const [zoom, setZoom] = useState(1)
  const [fitWidth, setFitWidth] = useState(true)

  /** Write the zoom to the document wrapper; CSS `zoom` (not transform) keeps the
   *  scroll extent in sync, which Chromium recomputes from the zoomed layout. */
  const applyZoom = useCallback((value: number): void => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
    const rounded = Math.round(clamped * 100) / 100
    zoomRef.current = rounded
    wrapperRef.current?.style.setProperty('zoom', String(rounded))
    setZoom(rounded)
  }, [])

  /** Scale the widest page (plus its gutters) to the scroll viewport's width. */
  const fitNow = useCallback((): void => {
    const scroll = scrollRef.current
    const wrapper = wrapperRef.current
    if (scroll === null || wrapper === null) return
    const available = scroll.clientWidth
    if (available <= 0) return
    let pageWidth = 0
    // `offsetWidth` stays in unzoomed layout pixels in Chromium, so the page's natural
    // width can be measured again even while a previous zoom is applied.
    for (const page of pagesOf(wrapper)) pageWidth = Math.max(pageWidth, page.offsetWidth)
    if (pageWidth <= 0) return
    applyZoom(Math.min(FIT_MAX_ZOOM, available / (pageWidth + GUTTER * 2)))
    scroll.scrollLeft = 0
  }, [applyZoom])

  // Render (and re-render on new bytes). Everything happens in detached nodes first so
  // the dock never flashes a half-styled page; the containers are emptied on unmount.
  useEffect(() => {
    const bodyHost = bodyRef.current
    const styleHost = styleRef.current
    if (bodyHost === null || styleHost === null) return
    let alive = true
    bodyHost.replaceChildren()
    styleHost.replaceChildren()
    wrapperRef.current = null
    zoomRef.current = 1
    fitRef.current = true
    setFitWidth(true)
    setZoom(1)
    setState({ kind: 'loading' })

    const run = async (): Promise<void> => {
      if (bytes.byteLength === 0) {
        if (alive) setState({ kind: 'empty' })
        return
      }
      const body = document.createElement('div')
      const styles = document.createElement('div')
      try {
        await renderAsync(new Uint8Array(bytes), body, styles, DOCX_OPTIONS)
      } catch (error: unknown) {
        if (alive) setState({ kind: 'error', message: describeError(error) })
        return
      }
      if (!alive) return
      const wrapper = body.firstElementChild
      if (!(wrapper instanceof HTMLElement) || !wrapper.classList.contains('docx-wrapper')) {
        setState({ kind: 'error', message: '文档内容解析失败。' })
        return
      }
      if (!hasContent(wrapper)) {
        setState({ kind: 'empty' })
        return
      }
      decorateWrapper(wrapper)
      const pages = pagesOf(wrapper)
      for (const page of pages) {
        applyPageFallback(page)
        decoratePage(page)
      }
      hardenLinks(wrapper)
      // The document stylesheets live in the private style host; the pages go into the
      // scroll container. Both are cleared on unmount, so the injected CSS disappears
      // with the viewer instead of lingering on the page.
      styleHost.replaceChildren(...Array.from(styles.childNodes))
      bodyHost.replaceChildren(body)
      wrapperRef.current = wrapper
      setState({ kind: 'ready' })
      fitNow()
    }

    void run()
    return () => {
      alive = false
      wrapperRef.current = null
      bodyHost.replaceChildren()
      styleHost.replaceChildren()
    }
  }, [bytes, fitNow])

  // The dock is resizable (and the dock can be hidden then shown): re-fit while the
  // user has not picked a manual zoom. Throttled to one measurement per animation frame.
  useEffect(() => {
    const scroll = scrollRef.current
    if (scroll === null) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (!fitRef.current || frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        fitNow()
      })
    })
    observer.observe(scroll)
    return () => {
      observer.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [fitNow])

  const stepZoom = (direction: -1 | 1): void => {
    fitRef.current = false
    setFitWidth(false)
    // Snap to clean 10% marks so the readout does not show 48% after leaving a 38% fit.
    applyZoom(Math.round((zoomRef.current + direction * ZOOM_STEP) * 10) / 10)
  }

  const resetZoom = (): void => {
    fitRef.current = false
    setFitWidth(false)
    applyZoom(1)
  }

  const enableFit = (): void => {
    fitRef.current = true
    setFitWidth(true)
    fitNow()
  }

  const ready = state.kind === 'ready'
  const buttonState = (active: boolean): CSSProperties => ({
    ...BUTTON_STYLE,
    ...(active ? BUTTON_ACTIVE_STYLE : {}),
    opacity: ready ? 1 : 0.45,
    cursor: ready ? 'pointer' : 'default',
  })
  // Before the first render there is no meaningful scale yet; a dash avoids a fake 100%.
  const zoomPercent = ready ? `${Math.round(zoom * 100)}%` : '—'

  const overlay = state.kind === 'ready'
    ? null
    : (
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: 18,
          textAlign: 'center',
          background: 'var(--dsw-alias-bg-secondary, #f2f4f7)',
        }}
      >
        {state.kind === 'loading' && (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a929c)' }}>正在加载文档…</div>
        )}
        {state.kind === 'empty' && (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #45505d)' }}>文档为空</div>
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a929c)' }}>该文档没有可显示的内容。</div>
          </>
        )}
        {state.kind === 'error' && (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary, #c0392b)' }}>无法预览该文档</div>
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a929c)' }}>文件可能已损坏，或不是有效的 .docx 文件。</div>
            {state.message !== '' && (
              <div
                title={state.message}
                style={{
                  marginTop: 4,
                  maxWidth: 260,
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 3,
                  overflow: 'hidden',
                  fontFamily: 'var(--dsw-font-code, ui-monospace, Menlo, monospace)',
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: 'var(--dsw-alias-label-tertiary, #8a929c)',
                  wordBreak: 'break-word',
                }}
              >
                {state.message}
              </div>
            )}
          </>
        )}
      </div>
    )

  return (
    <div
      role="group"
      aria-label={`${name} 预览`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary, #1b2129)',
        background: 'var(--dsw-alias-bg-secondary, #f2f4f7)',
      }}
    >
      <div role="toolbar" aria-label="文档缩放" style={TOOLBAR_STYLE}>
        <button
          type="button"
          onClick={() => stepZoom(-1)}
          disabled={!ready}
          aria-label="缩小"
          title="缩小"
          style={buttonState(false)}
        >
          −
        </button>
        <button
          type="button"
          onClick={resetZoom}
          disabled={!ready}
          aria-label={ready ? `当前缩放 ${zoomPercent}，点击重置为 100%` : '缩放比例'}
          title="重置为 100%"
          style={{ ...buttonState(false), minWidth: 46, fontVariantNumeric: 'tabular-nums' }}
        >
          {zoomPercent}
        </button>
        <button
          type="button"
          onClick={() => stepZoom(1)}
          disabled={!ready}
          aria-label="放大"
          title="放大"
          style={buttonState(false)}
        >
          +
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={enableFit}
          disabled={!ready}
          aria-pressed={fitWidth}
          aria-label="适应宽度"
          title="缩放至适合当前面板宽度"
          style={buttonState(fitWidth)}
        >
          适应宽度
        </button>
      </div>
      <div
        ref={scrollRef}
        style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}
      >
        {/* docx-preview injects the document's <style> elements here; emptied on unmount. */}
        <div ref={styleRef} style={{ display: 'none' }} aria-hidden="true" />
        <div ref={bodyRef} />
        {overlay}
      </div>
    </div>
  )
}
