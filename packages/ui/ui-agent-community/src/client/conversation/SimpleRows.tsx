/**
 * Small transcript rows — the error card, the dispatch divider, and the two live-text
 * affordances the running turn mounts.
 *
 * Split out of MessageRows.tsx: none of these four touch the turn's disclosure state, so each
 * renders from one ledger entry (or a plain string) and nothing else.
 *
 * @module
 */
import type { LedgerEntry } from './types.ts'
import { bodyText, errorAccent, metaLabel, mutedText, nameLabel } from './styles.ts'
import { noticeKindLabel, noticeKindOf } from './threadView.ts'

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
  const text = entry.text ?? ''
  const kind = noticeKindOf(text)
  const label = noticeKindLabel(kind)
  const accent = noticeAccent(kind)
  const divider = { height: '0.5px', flex: 1, background: 'var(--dsw-alias-border-l1)' }
  // A plain notice keeps the original quiet divider: no label, no accent, nothing to explain.
  if (label === undefined || accent === undefined) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '3px 0',
      }}>
        <div style={divider} />
        <span style={{ ...metaLabel, fontSize: 10 }}>{text}</span>
        <div style={divider} />
      </div>
    )
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '3px 0',
    }} data-notice-kind={kind}>
      <div style={divider} />
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
      <div style={divider} />
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
