/**
 * UserMessage — the right-aligned user bubble of the transcript.
 *
 * Split out of MessageRows.tsx, which is now the turn renderer only: this row
 * has no turn state of its own (no disclosure, no liveness), so it renders from
 * the ledger entry and the room's fork affordance alone.
 *
 * @module
 */
import type { LedgerEntry, MessageAttachment } from './types.ts'
import { MessageIconActions } from './messageActions.tsx'
import { renderHighlighted } from './highlight.tsx'
import { metaLabel } from './styles.ts'
import { IconPaperclipOutlineRegular } from './NativeIcons.tsx'

const EMPTY_NAMES: ReadonlySet<string> = new Set()

/**
 * Right-aligned user bubble — native `UserStyleBubble` (§2.11, `chat:1332`).
 *
 * DOM: `userRow` (column, `align-items:flex-end`, `gap:6px`) → `userStack`
 * (the `.702` width cap) → bubble; then the action row as a sibling, exactly
 * like native's `actions(text)` slot. The native clock sits on the **left**
 * (`clock:"start"`) and the row carries `data-chat-flow-kind="user"` so the
 * native "hide until hover when another user message follows" rule applies.
 */
export function UserMessage({
  entry, onFork, skillNames,
}: {
  entry: LedgerEntry
  /** Skill names whose `/name` token is painted in the link colour. */
  skillNames?: ReadonlySet<string> | undefined
  /** Fork from this message: receiving it means the room allows branching. */
  onFork?: ((messageId: string) => void) | undefined
}) {
  if (entry.type !== 'user') return null
  return (
    <div className="ac-user-row" data-chat-flow-kind="user">
      {/* Name only — the clock belongs to the native action row below. */}
      <span style={{ ...metaLabel, marginRight: 4 }}>
        {entry.senderName ?? '用户'}
      </span>
      <div className="ac-user-stack">
        {/* Reference tokens keep the link colour here too, so a sent `/skill`
            reads the same as it did in the composer. */}
        <div className="ac-user-bubble">
          {renderHighlighted(entry.text ?? '', skillNames ?? EMPTY_NAMES)}
          {/* Attachments sit INSIDE the bubble, under the text. An attachment-only
              message has no text at all, so this row is the only thing that makes it
              visible — before it existed, sending a file with no message produced an
              empty balloon and the user could not tell what they had sent. */}
          <AttachmentRows
            attachments={entry.attachments}
            hasText={(entry.text ?? '') !== ''}
          />
        </div>
      </div>
      {/* Clock (start) + copy, plus branch when the room is forkable: a user turn
          is the natural point to branch from, since the reply that follows is what
          the fork is meant to re-answer. */}
      <MessageIconActions
        text={entry.text ?? ''}
        time={entry.at}
        clock="start"
        {...(onFork !== undefined ? { onBranch: () => onFork(entry.id) } : {})}
      />
    </div>
  )
}

/**
 * The compact "what was sent" rows inside a user bubble: icon + name + size.
 *
 * Styled inline rather than through a stylesheet class on purpose: this is a leaf of the
 * bubble, it inherits the bubble's colour, and it must look identical wherever a user
 * message is rendered (transcript, and any future surface) without a global rule that
 * two places have to agree on.
 *
 * No thumbnail: the ledger carries metadata only, never bytes. That is what makes the
 * row identical after a reload — nothing here depends on component memory or on the
 * file still being on disk.
 */
function AttachmentRows({ attachments, hasText }: {
  attachments?: MessageAttachment[] | undefined
  /** Whether the bubble already rendered text, which decides the top gap. */
  hasText: boolean
}) {
  if (attachments === undefined || attachments.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: hasText ? 6 : 0 }}>
      {attachments.map((a, i) => (
        <span
          key={`${a.name}-${i}`}
          className="ac-user-attachment"
          title={a.mime !== undefined ? `${a.name}（${a.mime}）` : a.name}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '18px', minWidth: 0 }}
        >
          <span aria-hidden="true" style={{ display: 'inline-flex', flex: 'none', opacity: 0.75 }}>
            {a.kind === 'image' ? <ImageGlyph size={14} /> : <IconPaperclipOutlineRegular size={14} />}
          </span>
          <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.name}
          </span>
          <span style={{ flex: 'none', opacity: 0.7, fontSize: 11 }}>{formatAttachmentSize(a.size)}</span>
        </span>
      ))}
    </div>
  )
}

/** Picture glyph, matching the native outline icons' 1px stroke. */
function ImageGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.5" stroke="currentColor" />
      <circle cx="5.75" cy="6.5" r="1" stroke="currentColor" />
      <path d="M3 11.5l3-2.5 2.5 2 2-1.5 2.5 2.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** `59 B` / `1.2 KB` / `3.4 MB` — short enough to sit on one line next to a file name. */
function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
