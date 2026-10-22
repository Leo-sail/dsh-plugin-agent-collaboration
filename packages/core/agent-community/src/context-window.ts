/**
 * The `[最近 N 条消息]` window — pure string assembly with a budget and no duplicate input.
 *
 * WHAT WENT WRONG WITH THE PLAIN `last N messages` SLICE. `RunExecutor.buildPrompt` used to
 * hand the newest `historyMessagesInPrompt` rows to the model verbatim. Two costs followed:
 *
 *  1. **The turn's own input appeared twice.** The user's message is appended to the room
 *     before the run is queued, so the newest page contained it — and `[本轮输入]` appended
 *     it again below. The same sentence was paid for twice on every user-originated turn.
 *  2. **The page had no size budget.** One bot reply can be ~10 KB, so ten rows could put
 *     ~100 KB into a single prompt. Long sessions then grew the transcript every turn and
 *     forced the host's own compaction.
 *
 * So the window is built here, as a pure function: it drops the turn's input row, clips
 * each row, and stops when the byte budget is spent — newest first, because the recent
 * past is what a bot needs to stay coherent.
 *
 * Pure on purpose (no host, no React, no I/O): the rules that decide what a bot remembers
 * of the room are asserted directly in `tests/context-window.test.ts`.
 *
 * @module
 */

/** One stored message as the window sees it. */
export interface HistoryWindowMessage {
  /** Message id (`BotMessage.id`); used to drop the turn's own input row by identity. */
  readonly id: string
  /** The model-facing payload: `modelText` when it differs from the visible draft. */
  readonly text: string
  /** Visible text, when {@link text} carries a model-only expansion (a `/skill` body). */
  readonly displayText?: string | undefined
  /** `user` / `bot` / `routine` — only `user` rows can be the turn's input. */
  readonly senderKind?: string | undefined
  /** Speaker name for the rendered line. */
  readonly senderName?: string | undefined
  /** Stored order; only ever a tiebreaker — the input array is the transcript order. */
  readonly sequence?: number | undefined
}

/** What to exclude and how much room the block may take. */
export interface HistoryWindowOptions {
  /** The message that triggered this run, when the caller knows its id (wins over `runPrompt`). */
  readonly runMessageId?: string | undefined
  /** The run's prompt — matched against the last `user` message to find the input row. */
  readonly runPrompt?: string | undefined
  /** Hard cap on rows in the window. `0` disables the block. */
  readonly maxMessages?: number | undefined
  /** Character budget for the rendered block's UTF-8 bytes. */
  readonly maxBytes?: number | undefined
  /** Per-message cap before the row is clipped. */
  readonly perMessageChars?: number | undefined
  /** Line formatter; defaults to `name: text`. */
  readonly render?: ((message: HistoryWindowMessage) => string) | undefined
}

/** The rendered block plus what it cost, so the caller can label a truncated window. */
export interface HistoryWindowResult {
  /** The rows that fit, oldest first, joined with `\n`. Empty when nothing is shown. */
  readonly text: string
  /** How many rows are in {@link text}. */
  readonly included: number
  /** Rows dropped by the count/byte budget (the input row is not counted as omitted). */
  readonly omitted: number
  /** True when anything was clipped or dropped, so the prompt can say so. */
  readonly truncated: boolean
}

/** Default row cap; matches the plugin's `historyMessagesInPrompt`. */
export const DEFAULT_HISTORY_MESSAGES = 10
/**
 * Default character budget for the block's UTF-8 bytes.
 *
 * ~12 KB is a deliberate quarter of the old worst case: ten 10 KB replies (~100 KB) are the
 * failure this constant exists to prevent, while a normal ten-message page stays far below it.
 */
export const DEFAULT_HISTORY_BYTES = 12_000
/** Default per-row cap. A 46 KB `/skill` dump must not swallow the whole window. */
export const DEFAULT_PER_MESSAGE_CHARS = 2_000

/** Suffix appended to a clipped row so the model knows the text continues. */
const CLIP_MARKER = '…（已截断）'

/** UTF-8 byte length of `text`, without allocating a buffer (the module stays pure). */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one 4-byte code point; skip its low half.
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/** Collapse whitespace and cut to `max` characters, marking the cut. */
function clipLine(line: string, max: number): string {
  const flat = line.replace(/\s+/gu, ' ').trim()
  if (flat.length <= max) return flat
  const room = Math.max(0, max - CLIP_MARKER.length)
  return `${flat.slice(0, room).trimEnd()}${CLIP_MARKER}`
}

/** The index of the row that is this turn's own input, or `-1`. */
function findInputIndex(
  messages: readonly HistoryWindowMessage[],
  options: HistoryWindowOptions,
): number {
  if (options.runMessageId !== undefined && options.runMessageId !== '') {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.id === options.runMessageId) return i
    }
    return -1
  }
  const prompt = options.runPrompt
  if (prompt === undefined || prompt.trim() === '') return -1
  const wanted = prompt.trim()
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    // Only a user row can be the input: the seed/repair prompts the plugin injects are
    // user-channel too, but they never equal the run's prompt.
    if (message.senderKind !== 'user') continue
    const candidates = [message.text, message.displayText ?? '']
    for (const candidate of candidates) {
      if (candidate === prompt) return i
      if (candidate.trim() !== '' && candidate.trim() === wanted) return i
    }
  }
  return -1
}

/**
 * Build the model-facing history block for one turn.
 *
 * @param messages - the room's messages, oldest first (the transcript order).
 * @param options - see {@link HistoryWindowOptions}.
 * @returns the rendered block and its accounting.
 */
export function buildHistoryWindow(
  messages: readonly HistoryWindowMessage[],
  options: HistoryWindowOptions = {},
): HistoryWindowResult {
  const render = options.render
    ?? ((message: HistoryWindowMessage): string =>
      `${message.senderName ?? (message.senderKind === 'user' ? 'user' : 'bot')}: ${message.text}`)
  const maxMessages = Math.max(0, Math.floor(options.maxMessages ?? DEFAULT_HISTORY_MESSAGES))
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_HISTORY_BYTES))
  const perMessageChars = Math.max(CLIP_MARKER.length + 1, Math.floor(
    options.perMessageChars ?? DEFAULT_PER_MESSAGE_CHARS,
  ))

  if (messages.length === 0 || maxMessages === 0) {
    return { text: '', included: 0, omitted: messages.length, truncated: messages.length > 0 }
  }

  const inputIndex = findInputIndex(messages, options)
  const candidates: HistoryWindowMessage[] = []
  for (let i = 0; i < messages.length; i += 1) {
    if (i !== inputIndex) candidates.push(messages[i]!)
  }

  const lines: string[] = []
  let used = 0
  let omitted = 0
  let truncated = false
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (lines.length >= maxMessages) {
      omitted = i + 1
      break
    }
    const message = candidates[i]!
    let line = render(message)
    if (line.length > perMessageChars) {
      line = clipLine(line, perMessageChars)
      truncated = true
    }
    const cost = utf8ByteLength(line) + (lines.length > 0 ? 1 : 0)
    if (lines.length > 0 && used + cost > maxBytes) {
      omitted = i + 1
      break
    }
    // The newest row is never dropped, even when it alone exceeds the budget (it has
    // already been clipped to `perMessageChars`); dropping it would answer nothing.
    if (lines.length === 0 && cost > maxBytes) truncated = true
    lines.push(line)
    used += cost
  }
  lines.reverse()
  if (omitted > 0) truncated = true
  return { text: lines.join('\n'), included: lines.length, omitted, truncated }
}
