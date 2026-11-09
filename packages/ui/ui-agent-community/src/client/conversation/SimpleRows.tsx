/**
 * Small transcript rows — the error card, the dispatch/round dividers, and the two live-text
 * affordances the running turn mounts.
 *
 * Split out of MessageRows.tsx: none of these touch the turn's disclosure state, so each
 * renders from one ledger entry (or a plain string) and nothing else.
 *
 * @module
 */
import type { LedgerEntry } from './types.ts'
import { bodyText, errorAccent, metaLabel, mutedText, nameLabel } from './styles.ts'
import { noticeKindLabel, noticeKindOf } from './threadView.ts'
import { modernizeNoticeText } from './legacyNotice.ts'

// ── ErrorRow ──────────────────────────────────────────────────────────────────

export function ErrorRow({ entry }: { entry: LedgerEntry }) {
  if (entry.type !== 'error') return null
  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'flex-start',
      padding: '8px 12px',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      border: '0.5px solid var(--dsw-alias-state-error-primary)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)',
    }}>
      <span style={{ ...errorAccent, fontSize: 14, flexShrink: 0 }}>✕</span>
      <div>
        <span style={{ ...nameLabel, ...errorAccent }}>{entry.botName ?? ''}  运行失败</span>
        {entry.message !== undefined && (
          <div style={{ ...mutedText, marginTop: 2 }}>{entry.message}</div>
        )}
      </div>
    </div>
  )
}

// ── DispatchRow ───────────────────────────────────────────────────────────────

/** The quiet hairline shared by the plain notice row and the round lifecycle row. */
const dividerStyle = { height: '0.5px', flex: 1, background: 'var(--dsw-alias-border-l1)' } as const

/**
 * The accent a typed notice gets. The host's audit / drift / finish-gate notices are durable
 * `dispatch` rows (so they replay on reload), and they used to look exactly like
 * 「已邀请 X 加入群聊」. Only the CHROME changes here — the text is the host's, verbatim.
 */
function noticeAccent(kind: ReturnType<typeof noticeKindOf>): string | undefined {
  switch (kind) {
    case 'audit': return 'var(--dsw-alias-state-business-primary)'
    case 'drift': return 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary))'
    case 'finish-gate': return 'var(--dsw-alias-state-error-primary)'
    case 'notice': return undefined
  }
}

export function DispatchRow({ entry }: { entry: LedgerEntry }) {
  if (entry.type !== 'dispatch') return null
  // 2026-11-09: old ledger rows keep the old wording; map it at read time.
  const text = modernizeNoticeText(entry.text ?? '')
  const kind = noticeKindOf(text)
  const label = noticeKindLabel(kind)
  const accent = noticeAccent(kind)
  // A plain notice keeps the original quiet divider: no label, no accent, nothing to explain.
  if (label === undefined || accent === undefined) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '3px 0',
      }}>
        <div style={dividerStyle} />
        <span style={{ ...metaLabel, fontSize: 10 }}>{text}</span>
        <div style={dividerStyle} />
      </div>
    )
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '3px 0',
    }} data-notice-kind={kind}>
      <div style={dividerStyle} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '80%' }}>
        <span style={{
          flexShrink: 0,
          padding: '0 5px',
          borderRadius: 'var(--dsw-radius-sm, 4px)',
          border: `0.5px solid ${accent}`,
          color: accent,
          fontSize: 10,
          lineHeight: '14px',
        }}>{label}</span>
        <span style={{ ...metaLabel, fontSize: 10, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {text}
        </span>
      </span>
      <div style={dividerStyle} />
    </div>
  )
}

// ── RoundRow ──────────────────────────────────────────────────────────────────

/**
 * One row of a group round's lifecycle (P2-1): 「本轮开始…」/「X 跳过本轮」/「本轮收口…」.
 *
 * Host-authored text in the same quiet divider treatment as a plain dispatch notice: the round
 * is context, not a message, so it must not grow an avatar, a bubble or an author line. The
 * `data-round-phase` attribute carries the host's phase for styling/tests; the text itself is
 * the host's wording, painted verbatim.
 */
export function RoundRow({ entry }: { entry: LedgerEntry }) {
  if (entry.type !== 'round') return null
  return (
    <div
      data-round-phase={entry.phase}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '3px 0',
      }}
    >
      <div style={dividerStyle} />
      <span style={{ ...metaLabel, fontSize: 10, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.text ?? ''}
      </span>
      <div style={dividerStyle} />
    </div>
  )
}

// ── Live-text affordances ─────────────────────────────────────────────────────

export function StreamingText({ text }: { text: string }) {
  return (
    <div style={{
      ...bodyText,
      background: 'linear-gradient(90deg, var(--dsw-alias-label-primary) 25%, var(--dsw-alias-label-tertiary) 50%, var(--dsw-alias-label-primary) 75%)',
      backgroundSize: '200% auto',
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      backgroundClip: 'text',
      animation: 'ac-shimmer 2s linear infinite',
    }}>
      {text !== '' ? text : '…'}
    </div>
  )
}

export function MiniSpinner() {
  return (
    <span style={{
      display: 'inline-block', width: 10, height: 10, flexShrink: 0,
      border: '1.5px solid var(--dsw-alias-border-l2)',
      borderTopColor: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary))',
      borderRadius: '50%',
      animation: 'ac-spin 0.8s linear infinite',
    }} />
  )
}
