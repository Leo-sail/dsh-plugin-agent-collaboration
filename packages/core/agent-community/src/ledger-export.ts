/**
 * ledger-export.ts — the pure export/share layer for the room ledger (P4).
 *
 * WHY IT IS SEPARATE. The ledger (`ledger.ts`) is the in-memory projection the group-chat panel
 * renders, and its rows are deliberately rich: reasoning, tool calls, raw tool output, approval
 * fingerprints, questions, round lifecycle — the things an operator needs and a person you share
 * a transcript with does not. Export therefore has two audiences and must serve both without IO:
 *
 *   · OPERATOR / ROUND-TRIP: JSON and JSONL carry EVERY row with every public field, in a stable
 *     key order (base identity first, then `type`, then the variant's own fields) so two exports
 *     diff cleanly and a consumer can re-import them;
 *   · SHARING: the Markdown transcript is a REDACTED view by default — user text, bot text,
 *     deliverable files and errors only. Thinking (`bot-reasoning`), tool traffic and coordination
 *     rows (approval/question/dispatch/round) are opt-in, so a transcript shared with a user never
 *     leaks a chain of thought or a raw tool payload by accident.
 *
 * Everything here is PURE: no IO, no clock and no host — entries in, text out. Truncation uses the
 * caller's `maxChars` budget (default 20 000 body characters) and appends `…（已截断）`, so a long
 * room cannot freeze a share button. Timestamps are sliced out of the row's ISO `at` (`HH:MM:SS`,
 * never timezone-converted) — the export shows the ledger's own clock, not the exporter's.
 *
 * @module
 */

import type { LedgerEntry } from './ledger.ts'

/** The export shapes: full rows (`json`/`jsonl`) or the sharing transcript (`markdown`). */
export type LedgerExportFormat = 'json' | 'jsonl' | 'markdown'

/** Options for the sharing transcript (also accepted by {@link exportLedger} for markdown). */
export interface TranscriptOptions {
  /** Include thinking rows (`bot-reasoning`). Defaults to false. */
  readonly includeThinking?: boolean | undefined
  /** Include tool call/result rows. Defaults to false. */
  readonly includeTools?: boolean | undefined
  /** Include coordination rows (dispatch/round/approval/question). Defaults to false. */
  readonly includeCoordination?: boolean | undefined
  /** Heading line text (defaults to「群聊记录」). */
  readonly title?: string | undefined
  /** Body character budget; exceeding it truncates and appends「…（已截断）」. Defaults to 20000. */
  readonly maxChars?: number | undefined
}

/** Default heading used by the sharing transcript. */
const DEFAULT_TITLE = '群聊记录'

/** Default body budget: a room can be long, a pasted transcript should not be unbounded. */
const DEFAULT_MAX_CHARS = 20_000

/** Marker appended when the body is cut by the budget. */
const TRUNCATION_SUFFIX = '…（已截断）'

/**
 * Export full ledger rows — the operator/round-trip format.
 *
 *   · `json` — a pretty-printed array of {@link exportableRow} objects (`[]` for no entries);
 *   · `jsonl` — one compact JSON object per line, NEWLINE-terminated when non-empty and never a
 *     trailing blank line (`''` for no entries);
 *   · `markdown` — the sharing transcript (same as {@link exportTranscript}).
 *
 * Input order is preserved: the full export mirrors the ledger the caller handed in, while the
 * Markdown transcript sorts by time because a reader expects chronological blocks.
 */
export function exportLedger(
  entries: readonly LedgerEntry[],
  format: LedgerExportFormat,
  options?: TranscriptOptions,
): string {
  if (format === 'markdown') return exportTranscript(entries, options)
  const rows = entries.map(entry => exportableRow(entry))
  if (format === 'jsonl') {
    return rows.length === 0 ? '' : `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
  }
  return JSON.stringify(rows, null, 2)
}

/**
 * The shareable, read-only transcript (Markdown).
 *
 * Chronological blocks (sorted by `at`, then `sequence`), separated by one blank line:
 *
 * ```
 * # 群聊记录
 *
 * **用户** 09:30:00
 * 帮我看下日志
 * [附件] dsh.log
 *
 * **小A** 09:30:04
 * 日志里有个 502
 * ```
 *
 * By default only `user` / `bot-text` / `deliverable` / `error` rows are rendered. Thinking, tool
 * traffic and coordination rows are opt-in through {@link TranscriptOptions}; enabling a group
 * keeps the block order (a thinking row stays right before the reply that followed it). Empty (or
 * fully filtered) input renders just the heading line.
 */
export function exportTranscript(entries: readonly LedgerEntry[], options?: TranscriptOptions): string {
  const resolved = resolveOptions(options)
  const header = `# ${resolved.title}`
  const blocks: string[] = []
  for (const entry of sortByTime(entries)) {
    if (!keepInTranscript(entry, resolved)) continue
    blocks.push(blockOf(entry))
  }
  if (blocks.length === 0) return header
  const body = blocks.join('\n\n')
  const budgeted = body.length <= resolved.maxChars ? body : body.slice(0, resolved.maxChars) + TRUNCATION_SUFFIX
  return `${header}\n\n${budgeted}`
}

/**
 * One ledger row as a plain serializable object with a STABLE key order.
 *
 * Order: `id, roomId, at, sequence, rev, changeSeq, type`, then the variant's own fields in their
 * declared order (see `ledger.ts`). Optional fields whose value is `undefined` are omitted (never
 * emitted as `undefined`), so a JSON/JSONL export round-trips through `JSON.parse` exactly.
 * `sequence`, `rev` and `changeSeq` are never dropped: they are what lets an exported row be
 * matched against the live ledger (ordering, edit revision, incremental cursor).
 */
export function exportableRow(entry: LedgerEntry): Record<string, unknown> {
  const base = {
    id: entry.id,
    roomId: entry.roomId,
    at: entry.at,
    sequence: entry.sequence,
    rev: entry.rev,
    changeSeq: entry.changeSeq,
  }
  switch (entry.type) {
    case 'user':
      return compactRow({
        ...base,
        type: entry.type,
        text: entry.text,
        senderName: entry.senderName,
        attachments: entry.attachments,
        replyTo: entry.replyTo,
        threadId: entry.threadId,
        taskId: entry.taskId,
        messageId: entry.messageId,
      })
    case 'bot-text':
      return compactRow({
        ...base,
        type: entry.type,
        botId: entry.botId,
        botName: entry.botName,
        runId: entry.runId,
        text: entry.text,
        durationMs: entry.durationMs,
        usage: entry.usage,
        streaming: entry.streaming,
        replyTo: entry.replyTo,
        threadId: entry.threadId,
        taskId: entry.taskId,
      })
    case 'bot-reasoning':
      return compactRow({
        ...base,
        type: entry.type,
        botId: entry.botId,
        botName: entry.botName,
        runId: entry.runId,
        text: entry.text,
      })
    case 'tool-call':
      return compactRow({
        ...base,
        type: entry.type,
        botId: entry.botId,
        botName: entry.botName,
        runId: entry.runId,
        callId: entry.callId,
        name: entry.name,
        args: entry.args,
      })
    case 'tool-result':
      return compactRow({
        ...base,
        type: entry.type,
        botId: entry.botId,
        botName: entry.botName,
        runId: entry.runId,
        callId: entry.callId,
        ok: entry.ok,
        output: entry.output,
      })
    case 'deliverable':
      return compactRow({
        ...base,
        type: entry.type,
        botId: entry.botId,
        botName: entry.botName,
        runId: entry.runId,
        files: entry.files,
      })
    case 'approval':
      return compactRow({
        ...base,
        type: entry.type,
        botId: entry.botId,
        botName: entry.botName,
        callId: entry.callId,
        toolName: entry.toolName,
        args: entry.args,
        outcome: entry.outcome,
        argsHash: entry.argsHash,
        binding: entry.binding,
        expiresAt: entry.expiresAt,
      })
    case 'question':
      return compactRow({
        ...base,
        type: entry.type,
        botId: entry.botId,
        botName: entry.botName,
        questionId: entry.questionId,
        runId: entry.runId,
        question: entry.question,
        options: entry.options,
        allowFreeText: entry.allowFreeText,
        status: entry.status,
        answer: entry.answer,
        answeredAt: entry.answeredAt,
      })
    case 'error':
      return compactRow({
        ...base,
        type: entry.type,
        botId: entry.botId,
        botName: entry.botName,
        message: entry.message,
        code: entry.code,
      })
    case 'dispatch':
      return compactRow({
        ...base,
        type: entry.type,
        text: entry.text,
      })
    case 'round':
      return compactRow({
        ...base,
        type: entry.type,
        text: entry.text,
        roundId: entry.roundId,
        phase: entry.phase,
      })
  }
}

/** Transcript options with every default and the invalid `maxChars` fallback already applied. */
interface ResolvedTranscriptOptions {
  readonly includeThinking: boolean
  readonly includeTools: boolean
  readonly includeCoordination: boolean
  readonly title: string
  readonly maxChars: number
}

function resolveOptions(options: TranscriptOptions | undefined): ResolvedTranscriptOptions {
  const maxChars = options?.maxChars
  return {
    includeThinking: options?.includeThinking === true,
    includeTools: options?.includeTools === true,
    includeCoordination: options?.includeCoordination === true,
    title: options?.title ?? DEFAULT_TITLE,
    maxChars: maxChars !== undefined && Number.isFinite(maxChars) && maxChars >= 0 ? maxChars : DEFAULT_MAX_CHARS,
  }
}

/** Chronological order: `at` ascending, then `sequence`; equal keys keep the input order (stable). */
function sortByTime(entries: readonly LedgerEntry[]): readonly LedgerEntry[] {
  return [...entries].sort((left, right) => {
    if (left.at !== right.at) return left.at < right.at ? -1 : 1
    return left.sequence - right.sequence
  })
}

/** Default transcript shape: conversation + deliverables + errors; details are opt-in. */
function keepInTranscript(entry: LedgerEntry, options: ResolvedTranscriptOptions): boolean {
  switch (entry.type) {
    case 'user':
    case 'bot-text':
    case 'deliverable':
    case 'error':
      return true
    case 'bot-reasoning':
      return options.includeThinking
    case 'tool-call':
    case 'tool-result':
      return options.includeTools
    case 'approval':
    case 'question':
    case 'dispatch':
    case 'round':
      return options.includeCoordination
  }
}

/** Render one row as a transcript block (one or more Markdown lines, no surrounding blanks). */
function blockOf(entry: LedgerEntry): string {
  switch (entry.type) {
    case 'user': {
      const lines = [`**用户** ${timeOf(entry.at)}`]
      appendLines(lines, entry.text)
      const names = (entry.attachments ?? []).map(attachment => attachment.name)
      if (names.length > 0) lines.push(`[附件] ${names.join('、')}`)
      return lines.join('\n')
    }
    case 'bot-text': {
      const lines = [`**${entry.botName}** ${timeOf(entry.at)}`]
      appendLines(lines, entry.text)
      return lines.join('\n')
    }
    case 'bot-reasoning':
      return `[思考] ${entry.text}`
    case 'tool-call':
      return `[工具] ${entry.name}(${entry.args})`
    case 'tool-result':
      return entry.output === ''
        ? `[工具结果] ${entry.ok ? 'ok' : 'fail'}`
        : `[工具结果] ${entry.ok ? 'ok' : 'fail'} ${entry.output}`
    case 'deliverable': {
      const names = entry.files.map(file => file.name)
      return names.length === 0 ? '[交付文件]' : `[交付文件] ${names.join('、')}`
    }
    case 'error':
      return `[错误] ${entry.message}`
    case 'approval':
      return `[系统] 审批 ${entry.toolName}：${entry.outcome ?? '待决定'}`
    case 'question':
      return `[系统] 提问：${entry.question}`
    case 'dispatch':
      return `[系统] ${entry.text}`
    case 'round':
      return `[系统] ${entry.text}`
  }
}

/** Append a body text line by line, so embedded newlines stay as Markdown paragraphs. */
function appendLines(lines: string[], text: string): void {
  if (text === '') return
  for (const line of text.split('\n')) lines.push(line)
}

/** `2026-11-08T09:30:00.000Z` → `09:30:00` — pure slice of the ISO clock, no timezone conversion. */
function timeOf(at: string): string {
  const time = at.slice(11, 19)
  return /^\d{2}:\d{2}:\d{2}$/u.test(time) ? time : at
}

/** Drop `undefined`-valued fields while preserving insertion (== key) order. */
function compactRow(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) row[key] = value
  }
  return row
}
