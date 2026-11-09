/**
 * Tooltip — replica of the native `Tooltip` primitive.
 *
 * Source of truth:
 *   • `@deepseek-ai/dsh-client-ui-primitives/lib/Tooltip.module.css` — copied
 *     verbatim below; only the class name is scoped (`.bubble` → `.ac-tooltip`)
 *     while the keyframes keep the native name `tooltip-in`.
 *   • `dsh-client-ui-primitives/lib/index.js:4674` — the component:
 *
 *     Tooltip({ label, shortcutKeys, side = 'right', align = 'center',
 *               delayMs = 0, focusDelayMs = 0, gap = 8, disabled = false,
 *               portal = false, maxWidth, openOnClick = false, children })
 *
 * Behaviour ported from the native source: the anchor is **cloned** (never
 * wrapped in an extra element), `show()` measures the anchor rect, and the
 * bubble is clamped into the viewport with the native 12px edge margin —
 * `offset` is half its width, or its full width when `align="end"` — flipping
 * bottom↔top when the preferred side does not fit. `gap` only applies to
 * bottom/top placements; `side="right"` sits 10px past the anchor.
 *
 * Two deliberate deviations from native, both listed in the task report:
 *   • the bubble is **pre-mounted** with `visibility:hidden` instead of being
 *     mounted on first reveal. Native also renders it hidden until its
 *     ResizeObserver reports a size (it flips `style.visibility` itself), so the
 *     painted result is the same — but keeping the node in the tree is what lets
 *     a static render (and assistive tech) see the label.
 *   • `portal` only raises the stacking level (`z-index:1100`) instead of
 *     portalling into `document.body`: the client bundle intentionally has no
 *     `react-dom` import, because the plugin's module loader does not provide it.
 */
import {
  cloneElement, useCallback, useEffect, useId, useRef, useState,
  type Key, type ReactElement, type Ref,
} from 'react'

export type TooltipSide = 'right' | 'bottom' | 'top'
export type TooltipAlign = 'center' | 'end'

export interface TooltipProps {
  /** Bubble text; a function is resolved on every render (native resolves lazily). */
  readonly label: string | (() => string)
  /** Keycap hints rendered after the label (`ShortcutKeys variant="tooltip"`). */
  readonly shortcutKeys?: ReadonlyArray<string> | undefined
  readonly side?: TooltipSide | undefined
  readonly align?: TooltipAlign | undefined
  /** Hover delay in ms. */
  readonly delayMs?: number | undefined
  /** Focus delay in ms — the native default raises the bubble instantly. */
  readonly focusDelayMs?: number | undefined
  /** Anchor-to-bubble distance for bottom/top bubbles; ignored for `right`. */
  readonly gap?: number | undefined
  /** Suppress the bubble while true; the anchor renders identically. */
  readonly disabled?: boolean | undefined
  /** Raise the bubble to the native portal stacking level. */
  readonly portal?: boolean | undefined
  /** Bubble width cap in px, for labels the half-viewport cap would overrun. */
  readonly maxWidth?: number | undefined
  /** Clicking pins the bubble; Esc, Tab or an outside pointerdown dismisses it. */
  readonly openOnClick?: boolean | undefined
  /** A single anchor element; its own ref is forwarded alongside the tooltip's. */
  readonly children: ReactElement
}

/**
 * `Tooltip.module.css`, verbatim but for the scoped class name. The native
 * `animation` declaration moves to the `[data-open]` state so it replays on
 * every reveal (the bubble outlives a single hover).
 */
const CSS = `
.ac-tooltip{display:inline-flex;align-items:center;gap:8px;position:fixed;z-index:100;
  width:max-content;max-width:50vw;padding:3px 7px;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);
  font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;
  pointer-events:none}
.ac-tooltip[data-portal]{z-index:1100}
.ac-tooltip[data-pinned]{pointer-events:auto}
.ac-tooltip-label{min-width:0}
/* A 16px keycap centered beside a 20px label has 5px of vertical clearance. */
.ac-tooltip[data-has-shortcut]{padding-inline-end:5px}
.ac-tooltip[data-has-shortcut]:not(:has(.ac-tooltip-label)){padding:3px}
.ac-tooltip[data-side=right]{transform:translateY(-50%)}
.ac-tooltip[data-side=bottom]{transform:translateX(-50%)}
.ac-tooltip[data-side=top]{transform:translate(-50%,-100%)}
/* End alignment: left carries the anchor's right edge, so the bubble sits fully
   left of it instead of centering. */
.ac-tooltip[data-side=bottom][data-align=end]{transform:translateX(-100%)}
.ac-tooltip[data-side=top][data-align=end]{transform:translate(-100%,-100%)}
/* Hidden until shown, and until the bubble has been measured for viewport
   fitting — the native bubble mounts with style.visibility=hidden too. */
.ac-tooltip:not([data-open]),.ac-tooltip[data-open]:not([data-ready]){visibility:hidden}
.ac-tooltip[data-open]{animation:tooltip-in 150ms var(--ds-ease-in-out)}
@keyframes tooltip-in{from{opacity:0}}
@media (prefers-reduced-motion:reduce){.ac-tooltip{animation:none}}
.ac-tooltip-keys{align-items:center;gap:4px;display:inline-flex}
.ac-tooltip-key{box-sizing:border-box;min-width:16px;height:16px;padding:0 4px;border:.5px solid currentColor;
  border-radius:var(--dsw-radius-sm);opacity:.6;font:inherit;font-size:11px;line-height:16px;
  text-align:center;display:inline-block}
`

const STYLE_ID = 'agent-community-tooltip'

/**
 * Injected once at module load, exactly like the conversation chrome sheet in
 * `styles.ts`; the attribute guard keeps a re-imported module (HMR) from adding
 * a second copy.
 */
function ensureCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const el = document.createElement('style')
  el.setAttribute('data-plugin-css', STYLE_ID)
  el.textContent = CSS
  document.head.appendChild(el)
}

ensureCss()

/** Native viewport edge margin, `primitives/index.js:4702`. */
const EDGE_MARGIN = 12
/** Native `side === 'right'` anchor offset: `rect.right + 10`. */
const RIGHT_OFFSET = 10

interface AnchorRect {
  x: number
  top: number
  bottom: number
}

export function Tooltip({
  label,
  shortcutKeys,
  side = 'right',
  align = 'center',
  delayMs = 0,
  focusDelayMs = 0,
  gap = 8,
  disabled = false,
  portal = false,
  maxWidth,
  openOnClick = false,
  children,
}: TooltipProps) {
  const id = useId()
  const [pinned, setPinned] = useState(false)
  const [rect, setRect] = useState<AnchorRect | null>(null)
  const [fit, setFit] = useState<{ left: number; top: number; placement: TooltipSide } | null>(null)
  const anchor = useRef<HTMLElement | null>(null)
  const bubble = useRef<HTMLSpanElement | null>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggers = useRef({ hover: false, focus: false })
  /** Set by a pointer interaction so the focus it causes does not raise the bubble. */
  const pointerFocus = useRef(false)

  /** Native `visible = pos !== null && !disabled`. */
  const visible = rect !== null && !disabled

  const cancelShow = useCallback(() => {
    if (showTimer.current === null) return
    clearTimeout(showTimer.current)
    showTimer.current = null
  }, [])

  /** Native `show()`: measure the anchor and remember where the bubble goes. */
  const show = useCallback(() => {
    const el = anchor.current
    if (el === null || disabled || typeof window === 'undefined') return
    const r = el.getBoundingClientRect()
    setRect({
      x: side === 'right' ? r.right + RIGHT_OFFSET : align === 'end' ? r.right : r.left + r.width / 2,
      top: r.top,
      bottom: r.bottom,
    })
  }, [align, disabled, side])

  const showAfterDelay = useCallback((delay: number) => {
    cancelShow()
    if (delay <= 0) { show(); return }
    showTimer.current = setTimeout(() => {
      showTimer.current = null
      show()
    }, delay)
  }, [cancelShow, show])

  const withdraw = useCallback(() => {
    setPinned(false)
    setRect(null)
  }, [])

  const hide = useCallback(() => {
    cancelShow()
    if (!triggers.current.hover && !triggers.current.focus && !pinned) withdraw()
  }, [cancelShow, pinned, withdraw])

  const dismiss = useCallback(() => {
    cancelShow()
    triggers.current = { hover: false, focus: false }
    withdraw()
  }, [cancelShow, withdraw])

  // Native clears everything while disabled (and never mounts the bubble).
  useEffect(() => {
    if (!disabled) return
    cancelShow()
    triggers.current = { hover: false, focus: false }
    setPinned(false)
    setRect(null)
  }, [cancelShow, disabled])

  useEffect(() => () => { cancelShow() }, [cancelShow])

  // Native viewport fitting: measure the bubble, clamp `left`, flip the side when
  // the preferred one does not fit, and only then make it visible.
  useEffect(() => {
    if (rect === null || disabled || typeof window === 'undefined') {
      setFit(null)
      return
    }
    const el = bubble.current
    if (el === null) return
    const measure = (): void => {
      const box = el.getBoundingClientRect()
      const width = box.width
      const height = box.height
      const offset = side === 'right' ? 0 : align === 'end' ? width : width / 2
      const left = Math.max(EDGE_MARGIN, Math.min(rect.x - offset, window.innerWidth - EDGE_MARGIN - width))
      const fitsBelow = rect.bottom + gap + height <= window.innerHeight - EDGE_MARGIN
      const fitsAbove = rect.top - gap - height >= EDGE_MARGIN
      let placement = side
      if (placement === 'bottom' && !fitsBelow && fitsAbove) placement = 'top'
      else if (placement === 'top' && !fitsAbove && fitsBelow) placement = 'bottom'
      const top = placement === 'right'
        ? (rect.top + rect.bottom) / 2
        : placement === 'top' ? rect.top - gap : rect.bottom + gap
      setFit({ left: left + offset, top, placement })
    }
    measure()
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => measure())
      observer.observe(el, { box: 'border-box' })
    }
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [rect, disabled, side, align, gap])

  // Pinned bubbles (`openOnClick`) dismiss on Esc, Tab, or an outside pointerdown.
  useEffect(() => {
    if (!openOnClick || !visible) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
      }
      dismiss()
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (anchor.current?.contains(target as Node) === true) return
      if (bubble.current?.contains(target as Node) === true) return
      dismiss()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [openOnClick, visible, dismiss])

  // The anchor is cloned so the caller's element stays the anchor (native does
  // the same): its own handlers run first, ours follow.
  const childProps = children.props as Record<string, unknown> & { 'aria-describedby'?: string | undefined }
  const childRef = (children as unknown as { ref?: Ref<HTMLElement> | null }).ref
  const mergedRef = useCallback((el: HTMLElement | null) => {
    anchor.current = el
    if (typeof childRef === 'function') childRef(el)
    else if (childRef != null && typeof childRef === 'object') {
      (childRef as { current: HTMLElement | null }).current = el
    }
  }, [childRef])

  const describedBy = [childProps['aria-describedby'], id]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ')

  const call = (name: string, event: unknown): void => {
    const handler = childProps[name]
    if (typeof handler === 'function') (handler as (e: unknown) => void)(event)
  }

  const anchorProps: Partial<Record<string, unknown>> & { key?: Key | null } = {
    ref: mergedRef,
    'aria-describedby': describedBy,
    onMouseEnter: (event: unknown) => {
      call('onMouseEnter', event)
      triggers.current.hover = true
      showAfterDelay(delayMs)
    },
    onMouseLeave: (event: unknown) => {
      call('onMouseLeave', event)
      triggers.current.hover = false
      cancelShow()
      if (!pinned) withdraw()
    },
    onPointerDown: (event: unknown) => {
      call('onPointerDown', event)
      // Native `pointerModality()`: focus that arrives *because* of a pointer
      // interaction (a menu refocusing its trigger) never raises the bubble.
      pointerFocus.current = true
    },
    onFocus: (event: unknown) => {
      call('onFocus', event)
      if (pointerFocus.current) { pointerFocus.current = false; return }
      triggers.current.focus = true
      showAfterDelay(focusDelayMs)
    },
    onBlur: (event: unknown) => {
      call('onBlur', event)
      pointerFocus.current = false
      triggers.current.focus = false
      hide()
    },
    onClick: (event: unknown) => {
      call('onClick', event)
      triggers.current.focus = false
      cancelShow()
      if (openOnClick && !disabled && !pinned) {
        setPinned(true)
        show()
      } else withdraw()
    },
  }

  const resolvedLabel = typeof label === 'function' ? label() : label

  return (
    <>
      {cloneElement(children as ReactElement<Record<string, unknown>>, anchorProps)}
      <span
        ref={bubble}
        id={id}
        className="ac-tooltip"
        role="tooltip"
        data-side={fit?.placement ?? side}
        data-align={align}
        data-open={visible ? '' : undefined}
        data-ready={fit === null ? undefined : ''}
        data-portal={portal ? '' : undefined}
        data-pinned={pinned ? '' : undefined}
        data-has-shortcut={shortcutKeys !== undefined && shortcutKeys.length > 0 ? '' : undefined}
        style={{
          left: fit?.left ?? 0,
          top: fit?.top ?? 0,
          ...(maxWidth === undefined ? {} : { maxWidth }),
        }}
      >
        {resolvedLabel !== '' && <span className="ac-tooltip-label">{resolvedLabel}</span>}
        {shortcutKeys !== undefined && shortcutKeys.length > 0 && (
          <span className="ac-tooltip-keys">
            {shortcutKeys.map(key => <kbd key={key} className="ac-tooltip-key">{key}</kbd>)}
          </span>
        )}
      </span>
    </>
  )
}
