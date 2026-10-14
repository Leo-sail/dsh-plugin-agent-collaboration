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

export function DispatchRow({ entry }: { entry: LedgerEntry }) {
  if (entry.type !== 'dispatch') return null
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '3px 0',
    }}>
      <div style={{ height: '0.5px', flex: 1, background: 'var(--dsw-alias-border-l1)' }} />
      <span style={{ ...metaLabel, fontSize: 10 }}>{entry.text}</span>
      <div style={{ height: '0.5px', flex: 1, background: 'var(--dsw-alias-border-l1)' }} />
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
