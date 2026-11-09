/**
 * Shared types for the self-contained conversation UI components (P1–P8).
 * All data comes from the plugin's own ledger RPC — no DSH session dependency.
 */

export type LedgerEntryType =
  | 'user'
  | 'bot-text'
  | 'bot-reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'approval'
  | 'question'
  | 'error'
  | 'dispatch'
  | 'deliverable'
  /**
   * P2-1: one lifecycle row of a group round (开始 / 成员跳过 / 收口 / 被打断). It is not a
   * message and never enters a turn group — the transcript paints it as a grey divider
   * (see `RoundRow`), exactly like a dispatch notice.
   */
  | 'round'

/**
 * Token accounting for one bot turn, mirroring the provider's own breakdown.
 *
 * Every field is optional on purpose: providers (and restored history) report
 * different subsets, so the UI formats whatever is present and omits the rest
 * instead of printing 0 / undefined for a number it never received.
 */
export interface TokenUsage {
  inputTokens?: number
  uncachedInputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * One row of the turn-usage breakdown popover.
 *
 * Built from {@link TokenUsage} by dropping every field the provider did not
 * report, so a row can never render `0` or `undefined` for unknown data.
 */
export interface UsageDetailRow {
  /** The `TokenUsage` field this row was built from. */
  key: keyof TokenUsage
  /** Display label, e.g. `缓存命中`. */
  label: string
  /** Raw count; thousands separators are applied at render time. */
  value: number
}

/**
 * One attachment as the transcript's user bubble draws it.
 *
 * Metadata only — the bytes are never in the ledger (they live in the bot's workspace).
 * `kind` picks the icon; there is no thumbnail, so a reload renders the same row as the
 * live view did.
 */
export interface MessageAttachment {
  name: string
  size: number
  mime?: string
  kind: 'image' | 'file'
}

/** One file a bot turn declared for the user; metadata only, never the bytes. */
export interface DeliveredFile {
  /** Canonical absolute host path; the card's open/reveal target and dedupe key. */
  path: string
  /** Basename, the card's main label. */
  name: string
  description?: string
  /** Byte size at declaration time; the card shows it for binary types. */
  size?: number
}

export interface LedgerEntry {
  id: string
  type: LedgerEntryType
  roomId: string
  at: string
  sequence: number
  /** Bumped on every in-place update; sequence does not move on a patch. */
  rev?: number
  // user
  text?: string
  senderName?: string
  /**
   * Files the user sent with this message. Present on a user row only, and only when
   * something was attached — an attachment-only message has `text: ''`, so this is what
   * keeps its bubble from rendering empty.
   */
  attachments?: MessageAttachment[]
  /** Deliverable files (deliverable row only). */
  files?: DeliveredFile[]
  // bot-text / bot-reasoning / tool-call / tool-result
  botId?: string
  botName?: string
  runId?: string
  streaming?: boolean
  usage?: TokenUsage
  /** Wall-clock duration of the run, for the native "已完成，用时 …" footer. */
  durationMs?: number
  // tool-call / tool-result / approval
  callId?: string
  name?: string
  args?: string
  ok?: boolean
  output?: string
  toolName?: string
  outcome?: string
  // error
  message?: string
  code?: string
  // dispatch
  /**
   * OP-14 threading/task linkage, passed through by the host on user and bot-text rows.
   *
   * `replyTo` points at an earlier message in the same room (the host drops pointers that do
   * not resolve there); `threadId`/`taskId` are opaque labels. All optional: older rows and
   * rows with no threading simply lack them, and every reader must render them as absent.
   */
  replyTo?: string
  threadId?: string
  taskId?: string
  // round
  /**
   * Which group round this lifecycle row belongs to (P2-1). The transcript paints the row
   * inline and does not need it, but it is the stable identity a future replay/filter uses.
   */
  roundId?: string
  /**
   * The round's phase, which is what the divider row keys its styling on:
   * `started` / `pass` (a member skipped) / `settled` / `interrupted`.
   */
  phase?: 'started' | 'pass' | 'settled' | 'interrupted'
  /**
   * The persisted room message this ledger row stands for, when it stands for one.
   *
   * Ledger ids are NOT message ids: a run-owned row is `run:<runId>:<type>` and a live
   * user row is a random uuid (only a restart-rebuilt row reuses the message id). The
   * host resolves a fork target against `state.messages`, so a row that needs to name a
   * message must carry that id explicitly — otherwise 「在新对话中分支」looked up the
   * ledger id, found nothing, and threw "Message … not found in room …". Optional:
   * tool/reasoning/dispatch rows (and older hosts) have no message behind them.
   *
   * The reply target uses it for the same reason: `replyTo` must name a real message, and a live
   * row's ledger id does not, so a reply from a live row used to lose its threading silently.
   */
  messageId?: string
}

export interface BotInfo {
  id: string
  name: string
}

export interface RunInfo {
  id: string
  botId: string
  status: string
}

export interface QueuedMessage {
  id: string
  text: string
  attachments: AttachmentItem[]
}

export interface AttachmentItem {
  id: string
  kind: 'image' | 'file'
  name: string
  size: number
  /** DataURL for images, undefined for files */
  dataUrl?: string
  file: File
}

/** Queued message in flight — sent but run not yet started */
export interface InFlightMessage {
  id: string
  text: string
}
