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
