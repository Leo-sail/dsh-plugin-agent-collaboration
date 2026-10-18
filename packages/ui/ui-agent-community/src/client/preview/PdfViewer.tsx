/**
 * In-panel PDF viewer: one page at a time, pdf.js inside the client bundle.
 *
 * The dock (and the fallback preview) hands this component the finished file bytes and a
 * name; the component owns its toolbar, its loading/error/empty states and its pdf.js
 * runtime. Styling is inline + theme CSS variables so the viewer follows the dock's theme
 * (including dark mode) without adding a stylesheet, font or dependency.
 *
 * Rendering is deliberately "render offscreen, then swap": each page is drawn into a
 * detached staging canvas and only copied to the visible canvas after pdf.js resolves, so
 * a page/zoom change never shows a blank white rectangle while the new render runs
 * ("no white flash"). Switching preview tabs unmounts the component, which disposes the
 * runtime — the worker is terminated and the object URL revoked there, not on the next open.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  MAX_PDF_SCALE,
  MIN_PDF_SCALE,
  PdfDisposedError,
  PdfRuntime,
  toPdfError,
} from './pdfRuntime.ts'
import type { ViewerProps } from './types.ts'

/**
 * Preset zoom stops, in percent. Presets (rather than a free multiplier) keep the toolbar's
 * percentage readable at a glance and make zoom-in/zoom-out symmetric.
 */
const ZOOM_LEVELS: ReadonlyArray<number> = [25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]

/** Padding around the page inside the scroll area; also excluded from fit-width. */
const PAGE_GUTTER = 12

/** The 320 px dock must fit the whole toolbar without wrapping. */
const TOOLBAR_HEIGHT = 32

const LABEL_PRIMARY = 'var(--dsw-alias-label-primary, #1b2129)'
const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, #4b5563)'
const LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary, #8a929c)'
const BORDER = 'var(--dsw-alias-border-l2, #e4e7eb)'
const BORDER_STRONG = 'var(--dsw-alias-border-l3, #d3d8df)'
const BG_BASE = 'var(--dsw-alias-bg-base, #ffffff)'
const BG_INPUT = 'var(--dsw-alias-bg-layer-1, #ffffff)'
const BG_DOCUMENT = 'var(--dsw-alias-bg-document-preview, #f2f4f7)'
const BG_HOVER = 'var(--dsw-alias-interactive-bg-hover, #f2f4f7)'
const BG_SKELETON = 'var(--dsw-alias-bg-skeleton, #e8eaee)'
const BRAND = 'var(--dsw-alias-state-business-primary, #2f6fed)'
const ERROR = 'var(--dsw-alias-state-error-primary, #c0392b)'
const FOCUS_RING = 'var(--dsw-focus-ring-color, #2f6fed)'
const RADIUS_SM = 'var(--dsw-radius-sm, 6px)'

/** Fit-width may need to shrink a page below the manual zoom floor (big drawings, long plans). */
const MIN_FIT_SCALE = 0.02

type LoadStatus = 'loading' | 'ready' | 'error' | 'empty'
type ZoomMode = 'fit' | 'custom'

/** A failure the viewer can show: Chinese message plus the technical detail behind it. */
interface ViewerFailure {
  readonly message: string
  readonly detail: string
}

/** One in-progress paint, keyed by the effect that started it. */
interface PaintedPage {
  readonly page: number
  readonly scale: number
  readonly pixelRatio: number
}

/** Base size of a page at scale 1 and an available content width -> fit-width scale. */
function fitWidthScale(pageWidth: number, availableWidth: number): number {
  if (!(pageWidth > 0) || !(availableWidth > 0)) return 0
  return clampScale(availableWidth / pageWidth)
}

function clampScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(MAX_PDF_SCALE, Math.max(MIN_FIT_SCALE, value))
}

/** The preset zoom stop after (`1`) or before (`-1`) the current percentage, if any. */
function nextZoomLevel(currentPercent: number, direction: 1 | -1): number | undefined {
  if (direction > 0) return ZOOM_LEVELS.find((level) => level > currentPercent + 0.5)
  for (let index = ZOOM_LEVELS.length - 1; index >= 0; index -= 1) {
    const level = ZOOM_LEVELS[index]!
    if (level < currentPercent - 0.5) return level
  }
  return undefined
}

function pointerStyle(color: string, background = 'transparent'): CSSProperties {
  return {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 24,
    padding: '0 6px',
    boxSizing: 'border-box',
    border: `1px solid ${BORDER_STRONG}`,
    borderRadius: RADIUS_SM,
    background,
    color,
    fontFamily: 'inherit',
    fontSize: 12,
    lineHeight: 1,
    cursor: 'pointer',
  }
}

/** A compact toolbar button; hover/active feedback stays inline instead of a stylesheet. */
function ToolButton({ label, children, onClick, disabled = false, pressed, minWidth = 24, fontSize = 14 }: {
  readonly label: string
  readonly children: ReactNode
  readonly onClick: () => void
  readonly disabled?: boolean | undefined
  /** Set only for toggle buttons so screen readers get a real pressed state. */
  readonly pressed?: boolean | undefined
  readonly minWidth?: number | undefined
  readonly fontSize?: number | undefined
}): ReactElement {
  const [hovered, setHovered] = useState(false)
  const active = pressed === true
  const highlighted = active || (hovered && !disabled)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth,
        height: 24,
        padding: '0 5px',
        boxSizing: 'border-box',
        border: `1px solid ${active ? BORDER_STRONG : 'transparent'}`,
        borderRadius: RADIUS_SM,
        background: highlighted ? BG_HOVER : 'transparent',
        color: disabled ? LABEL_TERTIARY : highlighted ? LABEL_PRIMARY : LABEL_SECONDARY,
        fontFamily: 'inherit',
        fontSize,
        lineHeight: 1,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  )
}

/**
 * The panel's PDF preview.
 *
 * `bytes` is the complete file; the component copies it internally when opening so the prop
 * stays valid across tab switches (pdf.js detaches the buffer it is given).
 */
export function PdfViewer({ bytes, name }: ViewerProps): ReactElement {
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [progress, setProgress] = useState(0)
  const [loadError, setLoadError] = useState<ViewerFailure | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit')
  const [customScale, setCustomScale] = useState(1)
  /** Scale that is actually on screen; 0 means "nothing painted yet". */
  const [paintedScale, setPaintedScale] = useState(0)
  const [containerWidth, setContainerWidth] = useState(0)
  const [renderError, setRenderError] = useState<ViewerFailure | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [renderAttempt, setRenderAttempt] = useState(0)
  const [inputFocused, setInputFocused] = useState(false)
  const [pixelRatio, setPixelRatio] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))

  const runtimeRef = useRef<PdfRuntime | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const stagingCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const paintedRef = useRef<PaintedPage | null>(null)
  const paintJobRef = useRef(0)

  // One runtime per (bytes, retry) pair. Cleanup disposes the worker and revokes its URL;
  // this is the only place that starts pdf.js, so a tab switch can never leak a worker.
  useEffect(() => {
    let cancelled = false
    paintJobRef.current += 1
    paintedRef.current = null
    setStatus('loading')
    setProgress(0)
    setLoadError(null)
    setRenderError(null)
    setNumPages(0)
    setPage(1)
    setPageInput('1')
    setZoomMode('fit')
    setCustomScale(1)
    setPaintedScale(0)

    if (bytes.byteLength === 0) {
      setStatus('empty')
      return undefined
    }

    const runtime = new PdfRuntime(bytes, {
      onProgress: (loaded, total) => {
        if (cancelled) return
        setProgress(total > 0 ? Math.min(1, Math.max(0, loaded / total)) : 0)
      },
    })
    runtimeRef.current = runtime
    runtime.open().then((pdf) => {
      if (cancelled) return
      if (pdf.numPages < 1) {
        setStatus('empty')
        return
      }
      setNumPages(pdf.numPages)
      setStatus('ready')
    }).catch((error: unknown) => {
      if (cancelled || error instanceof PdfDisposedError) return
      const failure = toPdfError(error)
      setLoadError({ message: failure.userMessage, detail: failure.message })
      setStatus('error')
    })

    return () => {
      cancelled = true
      if (runtimeRef.current === runtime) runtimeRef.current = null
      runtime.dispose()
    }
  }, [bytes, loadAttempt])

  // devicePixelRatio changes when the window moves between displays or browser zoom changes;
  // re-paint at the new ratio instead of showing a blurry/oversized canvas.
  useEffect(() => {
    const update = (): void => setPixelRatio(window.devicePixelRatio || 1)
    window.addEventListener('resize', update)
    return () => { window.removeEventListener('resize', update) }
  }, [])

  // A new page starts at the top, like every other document viewer.
  useEffect(() => {
    const node = scrollRef.current
    if (node !== null) node.scrollTo({ top: 0, left: 0 })
  }, [page])

  // Fit-width follows the dock width. The observer lives only while the document is ready,
  // i.e. while the scroll container that it measures is mounted.
  useEffect(() => {
    if (status !== 'ready') return undefined
    const node = scrollRef.current
    if (node === null) return undefined
    const measure = (): void => { setContainerWidth(node.clientWidth) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [status])

  // Paint the current page whenever the page, the zoom, the dock width or the DPR changes.
  // Every run supersedes the previous one: the job id invalidates late continuations and the
  // runtime cancels the previous pdf.js render task, so at most one render is ever active.
  useEffect(() => {
    if (status !== 'ready') return undefined
    const runtime = runtimeRef.current
    const display = displayCanvasRef.current
    if (runtime === null || display === null) return undefined

    let staging = stagingCanvasRef.current
    if (staging === null) {
      staging = document.createElement('canvas')
      stagingCanvasRef.current = staging
    }
    const stagingCanvas = staging
    const job = (paintJobRef.current += 1)
    const ratio = pixelRatio
    let cancelled = false
    setRenderError(null)

    const paint = async (): Promise<void> => {
      try {
        let target = customScale
        if (zoomMode === 'fit') {
          const size = await runtime.pageSize(page)
          if (cancelled || job !== paintJobRef.current) return
          target = fitWidthScale(size.width, containerWidth - PAGE_GUTTER * 2)
        }
        // Width not measured yet: stay on the placeholder until the ResizeObserver reports.
        if (!(target > 0) || !Number.isFinite(target)) return
        target = clampScale(target)

        const previous = paintedRef.current
        if (
          previous !== null &&
          previous.page === page &&
          previous.pixelRatio === ratio &&
          Math.abs(previous.scale - target) < 0.002
        ) {
          return
        }

        const rendered = await runtime.render(page, target, stagingCanvas, ratio)
        if (cancelled || job !== paintJobRef.current) return

        // Atomic swap: the visible canvas keeps showing the previous page until here, so a
        // tab/page/zoom change never flashes an empty white rectangle.
        display.width = stagingCanvas.width
        display.height = stagingCanvas.height
        display.style.width = `${rendered.width}px`
        display.style.height = `${rendered.height}px`
        const context = display.getContext('2d')
        if (context !== null) context.drawImage(stagingCanvas, 0, 0)
        paintedRef.current = { page, scale: target, pixelRatio: ratio }
        setPaintedScale(target)
      } catch (error: unknown) {
        if (cancelled || job !== paintJobRef.current) return
        if (error instanceof PdfDisposedError || runtime.disposed) return
        const failure = toPdfError(error, 'render')
        setRenderError({ message: failure.userMessage, detail: failure.message })
      }
    }
    void paint()

    return () => {
      cancelled = true
    }
  }, [status, page, zoomMode, customScale, containerWidth, pixelRatio, renderAttempt])

  const maxPage = Math.max(numPages, 1)
  const goToPage = (target: number): void => {
    const next = Math.min(Math.max(Math.trunc(target), 1), maxPage)
    setPage(next)
    setPageInput(String(next))
  }

  const currentPercent = zoomMode === 'fit'
    ? (paintedScale > 0 ? paintedScale * 100 : 100)
    : customScale * 100
  const canZoomIn = nextZoomLevel(currentPercent, 1) !== undefined
  const canZoomOut = nextZoomLevel(currentPercent, -1) !== undefined
  const canGoPrevious = page > 1
  const canGoNext = page < numPages

  const changeZoom = (direction: 1 | -1): void => {
    const level = nextZoomLevel(currentPercent, direction)
    if (level === undefined) return
    setZoomMode('custom')
    setCustomScale(level / 100)
  }

  const commitPageInput = (): void => {
    const parsed = Number.parseInt(pageInput, 10)
    if (!Number.isFinite(parsed)) {
      setPageInput(String(page))
      return
    }
    goToPage(parsed)
  }

  const onPageInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setPageInput(event.target.value.replace(/[^0-9]/gu, '').slice(0, 6))
  }

  const onPageInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commitPageInput()
  }

  const retryLoad = (): void => { setLoadAttempt((count) => count + 1) }
  const retryPaint = (): void => { setRenderAttempt((count) => count + 1) }

  const toolbar = status !== 'ready' ? null : (
    <div role="toolbar" aria-label="PDF 工具栏" style={{
      flex: '0 0 auto',
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      height: TOOLBAR_HEIGHT,
      padding: '0 6px',
      boxSizing: 'border-box',
      borderBottom: `1px solid ${BORDER}`,
      background: BG_BASE,
      overflowX: 'auto',
      overflowY: 'hidden',
    }}>
      <ToolButton label="上一页" disabled={!canGoPrevious} onClick={() => { goToPage(page - 1) }}>‹</ToolButton>
      <ToolButton label="下一页" disabled={!canGoNext} onClick={() => { goToPage(page + 1) }}>›</ToolButton>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        aria-label="页码"
        title="输入页码后按回车跳转"
        value={pageInput}
        onChange={onPageInputChange}
        onKeyDown={onPageInputKeyDown}
        onFocus={(event) => { setInputFocused(true); event.currentTarget.select() }}
        onBlur={() => { setInputFocused(false); setPageInput(String(page)) }}
        style={{
          flex: '0 0 auto',
          width: 36,
          height: 22,
          padding: '0 2px',
          boxSizing: 'border-box',
          border: `1px solid ${BORDER_STRONG}`,
          borderRadius: RADIUS_SM,
          background: BG_INPUT,
          color: LABEL_PRIMARY,
          fontFamily: 'inherit',
          fontSize: 11,
          lineHeight: '20px',
          textAlign: 'center',
          outline: inputFocused ? `2px solid ${FOCUS_RING}` : 'none',
          outlineOffset: 1,
        }}
      />
      <span aria-label={`共 ${numPages} 页`} style={{
        flex: '0 0 auto',
        fontSize: 11,
        color: LABEL_TERTIARY,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      }}> / {numPages}</span>
      <span aria-hidden="true" style={{ flex: '0 0 auto', width: 1, height: 14, margin: '0 3px', background: BORDER }} />
      <ToolButton label="缩小" disabled={!canZoomOut} onClick={() => { changeZoom(-1) }}>−</ToolButton>
      <span title="当前缩放比例" style={{
        flex: '0 0 auto',
        minWidth: 34,
        textAlign: 'center',
        fontSize: 11,
        color: LABEL_SECONDARY,
        fontVariantNumeric: 'tabular-nums',
      }}>{paintedScale > 0 ? `${Math.round(currentPercent)}%` : '—'}</span>
      <ToolButton label="放大" disabled={!canZoomIn} onClick={() => { changeZoom(1) }}>+</ToolButton>
      <ToolButton
        label="适应宽度"
        pressed={zoomMode === 'fit'}
        onClick={() => { setZoomMode('fit') }}
        fontSize={11}
      >适应宽度</ToolButton>
    </div>
  )

  const loadingBody = (
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      padding: 24,
      boxSizing: 'border-box',
      textAlign: 'center',
      background: BG_BASE,
    }}>
      <div style={{ fontSize: 12, color: LABEL_SECONDARY, lineHeight: 1.5 }}>
        正在加载 PDF…{progress > 0 ? ` ${Math.round(progress * 100)}%` : ''}
      </div>
      {progress > 0 && (
        <div style={{ width: 140, maxWidth: '80%', height: 3, borderRadius: 2, overflow: 'hidden', background: BG_SKELETON }}>
          <div style={{ width: `${Math.round(progress * 100)}%`, height: '100%', background: BRAND, transition: 'width 120ms linear' }} />
        </div>
      )}
      <div title={name} style={{
        maxWidth: '85%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 11,
        color: LABEL_TERTIARY,
      }}>{name}</div>
    </div>
  )

  const emptyBody = (
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: 24,
      boxSizing: 'border-box',
      textAlign: 'center',
      background: BG_BASE,
    }}>
      <div style={{ fontSize: 12, color: LABEL_SECONDARY }}>没有可预览的页面</div>
      <div style={{ maxWidth: 320, fontSize: 11, lineHeight: 1.6, color: LABEL_TERTIARY }}>
        文件为空，或这份 PDF 不含任何页面。
      </div>
    </div>
  )

  const loadErrorBody = loadError === null ? null : (
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: 20,
      boxSizing: 'border-box',
      textAlign: 'center',
      background: BG_BASE,
    }}>
      <div style={{ maxWidth: 320, fontSize: 12, lineHeight: 1.6, color: ERROR }}>{loadError.message}</div>
      {loadError.detail !== '' && (
        <div title={loadError.detail} style={{
          maxWidth: '90%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 11,
          color: LABEL_TERTIARY,
        }}>{loadError.detail}</div>
      )}
      <button type="button" onClick={retryLoad} style={pointerStyle(LABEL_PRIMARY)}>重试</button>
    </div>
  )

  const readyBody = (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div ref={scrollRef} style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        padding: PAGE_GUTTER,
        boxSizing: 'border-box',
        background: BG_DOCUMENT,
      }}>
        <div style={{ minWidth: '100%', width: 'fit-content', margin: '0 auto' }}>
          <canvas
            ref={displayCanvasRef}
            role="img"
            aria-label={`${name} 第 ${page} 页`}
            style={{
              display: paintedScale > 0 ? 'block' : 'none',
              margin: '0 auto',
              background: '#ffffff',
              boxShadow: '0 1px 4px rgba(15, 23, 42, 0.18)',
            }}
          />
        </div>
      </div>
      {paintedScale === 0 && renderError === null && (
        <div aria-hidden="true" style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: BG_DOCUMENT,
          pointerEvents: 'none',
        }}>
          <span style={{ fontSize: 12, color: LABEL_SECONDARY }}>正在渲染页面…</span>
        </div>
      )}
      {renderError !== null && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: 20,
          boxSizing: 'border-box',
          textAlign: 'center',
          background: BG_BASE,
        }}>
          <div style={{ maxWidth: 320, fontSize: 12, lineHeight: 1.6, color: ERROR }}>{renderError.message}</div>
          {renderError.detail !== '' && (
            <div title={renderError.detail} style={{
              maxWidth: '90%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 11,
              color: LABEL_TERTIARY,
            }}>{renderError.detail}</div>
          )}
          <button type="button" onClick={retryPaint} style={pointerStyle(LABEL_PRIMARY)}>重试</button>
        </div>
      )}
    </div>
  )

  return (
    <section aria-label={`PDF 预览：${name}`} style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      background: BG_BASE,
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: 12,
    }}>
      {toolbar}
      {status === 'loading' && loadingBody}
      {status === 'empty' && emptyBody}
      {status === 'error' && loadErrorBody}
      {status === 'ready' && readyBody}
    </section>
  )
}
