/**
 * ThreadQuote — the small OP-14 thread chrome shared by the user bubble and the bot turn.
 *
 * ONE LEVEL ONLY. A reply renders a quote strip above its own body (who/what it answers) and a
 * short thread badge on rows that belong to a thread; the parent message is never pulled into
 * this row and there is no nested conversation column. That is deliberate: the transcript is
 * chronological, and a thread UI that reorders or nests messages would fight it.
 *
 * The strip is metadata about a message, not a button: the parent is right above in most cases,
 * and a "jump" affordance that cannot scroll to a row outside the loaded ledger window would be
 * a dead control. The callers pass only data, so nothing here reads the host.
 *
 * @module
 */
import type { CSSProperties, ReactNode } from 'react'
import { Tooltip } from './Tooltip.tsx'
import { shortId, type ThreadQuoteData } from './threadView.ts'

const quoteStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  maxWidth: '100%',
  padding: '3px 8px',
  borderLeft: '2px solid var(--dsw-alias-border-l3)',
  borderRadius: '0 var(--dsw-radius-sm, 4px) var(--dsw-radius-sm, 4px) 0',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: '18px',
}

const quoteCaptionStyle: CSSProperties = {
  flexShrink: 0,
  color: 'var(--dsw-alias-label-tertiary)',
}

const quoteTextStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-secondary)',
}

const badgeStyle: CSSProperties = {
  flexShrink: 0,
  padding: '0 5px',
  borderRadius: 'var(--dsw-radius-sm, 4px)',
  background: 'var(--dsw-alias-interactive-bg-hover)',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  lineHeight: '16px',
}

/** The quote strip above a reply. Renders nothing when there is no `replyTo`. */
export function ThreadQuote({ data }: { data: ThreadQuoteData }): ReactNode {
  const snippet = data.snippet !== '' ? data.snippet : `#${shortId(data.replyTo)}`
  return (
    <div style={quoteStyle} data-thread-quote="" data-reply-to={data.replyTo}>
      <span style={quoteCaptionStyle}>回复</span>
      <span style={quoteTextStyle} title={snippet}>{snippet}</span>
      {data.threadId !== undefined && (
        <span style={badgeStyle} data-thread-badge={data.threadId}>#{shortId(data.threadId)}</span>
      )}
      {data.taskId !== undefined && (
        <span style={badgeStyle} data-task-badge={data.taskId}>任务 {shortId(data.taskId)}</span>
      )}
    </div>
  )
}

/** The thread chip a row shows when it belongs to a thread but has no explicit quote. */
export function ThreadBadge({ threadId }: { threadId: string }): ReactNode {
  return (
    <span style={badgeStyle} data-thread-badge={threadId} title={`线程 ${threadId}`}>
      #{shortId(threadId)}
    </span>
  )
}

/**
 * The 回复 action, dropped into a message's existing action row (`MessageIconActions`
 * `extraActions`). Rendered only when the caller wired a handler — never a dead button.
 */
export function ReplyAction({ onReply }: { onReply: () => void }): ReactNode {
  return (
    <Tooltip label="回复" side="bottom">
      <button type="button" className="ac-action" aria-label="回复" onClick={onReply}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" strokeWidth={1}>
          <path
            d="M6.2 3.6 2.3 7.1l3.9 3.5V8.4c3.4 0 5.6 1.1 6.9 3.4.1-4.2-1.7-6.6-6.9-7V3.6Z"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </Tooltip>
  )
}
