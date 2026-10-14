/**
 * DeepDiving — pixel replica of the native "depth diving" running indicator.
 *
 * Replicated from the shipped DSH chat bundle (dsh-client-ui-chat/lib/client.js):
 *   • label        `深度求索中，用时 {duration} ···` / `Deep diving for {duration} ···`
 *                  (note the literal " ···" tail: one space + three U+00B7)
 *   • structure    visually-hidden role=status span (label WITHOUT duration)
 *                  → divider → content(whale tail + shimmer text)
 *   • colour       color: --dsw-alias-label-deep-diving
 *                  and --dsw-alias-label-shimmer is LOCALLY REBOUND to
 *                  --dsw-alias-label-deep-diving-shimmer inside the container
 *   • type         font-size: content-font-size - 2px; line-height: 22px + delta
 *   • icon         14px box, mask + currentColor background, 60-frame APNG
 *   • timing       1s interval refresh, minimum displayed duration 1s
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { WHALE_TAIL_APNG } from './whaleTailApng.ts'
import { TextShimmer } from './tool/primitives.tsx'
import { DEEP_DIVING, DEEP_DIVING_FOR } from './nativeStrings.ts'

/** Native REST_PATH: the static fallback drawn when the mask animation is off. */
const REST_PATH =
  'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742'


/** Native formats 时/分/秒 as separate spans, then joins with no separator. */
function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  let out = `${seconds}秒`
  if (total >= 60) out = `${minutes}分${out}`
  if (hours > 0) out = `${hours}小时${out}`
  return out
}

export interface DeepDivingProps {
  /** Epoch ms the run started; omission renders the plain label with no timer. */
  readonly startedAt?: number | undefined
}

export function DeepDiving({ startedAt }: DeepDivingProps) {
  const [now, setNow] = useState(() => Date.now())

  // Native refreshes once per second; the timer only exists while mounted (the
  // component is mounted only while the session runs).
  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [startedAt])

  const label = startedAt === undefined
    // Minimum 1s displayed, matching Math.max(1e3, now - startTime).
    ? DEEP_DIVING
    : DEEP_DIVING_FOR.replace('{duration}', formatRunDuration(Math.max(1000, now - startedAt)))

  return (
    <div style={RUNNING} data-chat-running="true">
      {/* Screen readers get the steady label, never the ticking duration. */}
      <span style={VISUALLY_HIDDEN} role="status" aria-live="polite" aria-atomic="true">
        {DEEP_DIVING}
      </span>
      <span style={DIVIDER} aria-hidden="true" />
      <span style={CONTENT}>
        <WhaleTail />
        {/* Native `TextShimmer`: the same running sweep every other row uses, so
            the label is not a third hand-rolled replica. It stays inside the
            label's layout box, whose tabular numerals stop the ticking duration
            from reflowing the row. */}
        <span style={RUNNING_TEXT}>
          <TextShimmer active>{label}</TextShimmer>
        </span>
      </span>
    </div>
  )
}

/** Whale tail: animated APNG mask over a static SVG fallback. */
function WhaleTail() {
  return (
    <span style={ICON} aria-hidden="true">
      <span style={WHALE_ANIMATED} />
      <svg
        style={WHALE_STILL}
        width="100%"
        height="100%"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path d={REST_PATH} stroke="currentColor" strokeWidth={1} />
      </svg>
    </span>
  )
}

// ── styles (native values in comments) ───────────────────────────────────────

const RUNNING: CSSProperties = {
  // .icaHSq_running
  ['--dsh-chat-flow-gap' as string]: '12px',
  ['--dsw-alias-label-shimmer' as string]: 'var(--dsw-alias-label-deep-diving-shimmer)',
  color: 'var(--dsw-alias-label-deep-diving)',
  fontSize: 'calc(var(--dsh-content-font-size, 14px) - 2px)',
  lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

const DIVIDER: CSSProperties = {
  // .icaHSq_runningDivider — native hides it unless the previous row qualifies.
  background: 'color-mix(in srgb, var(--dsw-alias-border-l1) 75%, var(--dsw-alias-border-l2))',
  pointerEvents: 'none',
  width: '100%',
  height: '0.5px',
  margin: '8px 0 10px',
  display: 'none',
}

const CONTENT: CSSProperties = {
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  display: 'inline-flex',
}

const RUNNING_TEXT: CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  minWidth: 0,
  position: 'relative',
  display: 'inline-block',
}

const ICON: CSSProperties = {
  // .icaHSq_runningIcon
  width: 'calc(14px + var(--dsh-content-font-delta, 0px))',
  height: 'calc(14px + var(--dsh-content-font-delta, 0px))',
  contain: 'strict',
  flex: 'none',
  display: 'inline-flex',
  position: 'relative',
  overflow: 'hidden',
}

const WHALE_ANIMATED: CSSProperties = {
  // .icaHSq_runningWhaleAnimated — background:currentColor + APNG mask.
  position: 'absolute',
  inset: 0,
  display: 'block',
  background: 'currentColor',
  willChange: 'transform',
  WebkitMaskImage: `url(${WHALE_TAIL_APNG})`,
  maskImage: `url(${WHALE_TAIL_APNG})`,
  WebkitMaskSize: 'contain',
  maskSize: 'contain',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
  maskPosition: 'center',
}

const WHALE_STILL: CSSProperties = {
  // Fallback drawn when mask animation is unavailable.
  position: 'absolute',
  inset: 0,
  display: 'block',
}
