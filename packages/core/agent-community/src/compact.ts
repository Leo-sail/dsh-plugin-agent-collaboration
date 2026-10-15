/**
 * History compaction — turning a room's older messages into one short summary.
 *
 * The room's stored messages ARE the bot's memory: `SessionRunner` seeds every fresh
 * session from them (`historyFor`) and `RunExecutor.buildPrompt` hands the newest
 * `historyMessagesInPrompt` to each turn. There is no host-side compaction API to call,
 * so the one lever that genuinely compresses what a bot carries forward is replacing the
 * older messages with a summary — which is what this module prepares.
 *
 * Pure except for {@link summariseHistory}, which drives the plugin's one sanctioned
 * session-less LLM path (`ctx.llm.stream`, the same one the group-proposal judgement and
 * the skill profiler use) rather than inventing a second client.
 *
 * @module
 */

/** The sender name the summary row carries in the transcript and in the prompt history. */
export const COMPACT_SENDER_NAME = '压缩摘要'

/** Newest messages kept verbatim by default. */
export const DEFAULT_KEEP_LAST = 6

/** Floor for `keepLast`: below two messages "keep the recent tail" is not a promise worth making. */
export const MIN_KEEP_LAST = 2

/**
 * How long the summariser may take.
 *
 * Bounded because the caller is a UI command: a provider that never answers must surface as
 * an error the user can read, not as a spinner. The client's own RPC deadline is larger
 * (see `COMPACT_CALL_DEADLINE_MS`), so this fires first and the failure is reportable.
 */
export const COMPACT_MODEL_TIMEOUT_MS = 45_000

/** Characters of one message handed to the summariser. */
const PER_MESSAGE_CHARS = 1_200

/**
 * Characters of transcript handed to the summariser.
 *
 * A room can hold thousands of messages; the summariser prompt must not grow without
 * bound. When the older segment does not fit, the NEWEST of it wins (see
 * {@link buildSummaryPrompt}) — the decisions the conversation arrived at matter more
 * than its opening pleasantries.
 */
const TRANSCRIPT_BUDGET_CHARS = 24_000

/** One message as the summariser sees it. */
export interface CompactSourceMessage {
  readonly senderName: string
  readonly text: string
}

/** `keepLast` as the caller asked for it, clamped into the range the service supports. */
export function clampKeepLast(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_KEEP_LAST
  return Math.max(MIN_KEEP_LAST, Math.floor(value))
}

/**
 * Split a room's messages into the part that becomes a summary and the tail kept verbatim.
 *
 * `keepLast` is clamped here as well as at the RPC boundary, so every caller — including
 * a future one that forgot to clamp — keeps at least {@link MIN_KEEP_LAST} messages.
 */
export function splitForCompaction<T>(
  messages: readonly T[],
  keepLast: number,
): { older: T[]; tail: T[] } {
  const keep = Math.max(MIN_KEEP_LAST, Math.floor(keepLast))
  const cut = Math.max(0, messages.length - keep)
  return { older: messages.slice(0, cut), tail: messages.slice(cut) }
}

export interface SummaryPrompt {
  readonly system: string
  readonly user: string
}

/**
 * The prompt that asks for the summary.
 *
 * Deliberately specific about what to keep: a generic "summarise this" produced polite
 * prose that dropped exactly the facts (names, numbers, decisions, open questions) the next
 * turn needs. The length cap is stated so the summary stays a compaction rather than a
 * copy of the transcript.
 */
export function buildSummaryPrompt(
  roomName: string,
  older: readonly CompactSourceMessage[],
): SummaryPrompt {
  const system = [
    '你是一个对话压缩助手。把这段历史对话压缩成一份摘要，供之后的对话继续使用。',
    '必须保留：已经确认的结论和决定、关键事实与数字（名称、代号、路径、端口、金额、时间等）、未解决的问题、各方的分工与承诺、接下来要做的事。',
    '可以省略：寒暄、重复内容、逐步的工具调用与思考过程。',
    '用中文，条目式，400 字以内；宁可写满也不要漏掉事实。',
    '直接输出摘要正文，不要任何前言、标题或 Markdown 代码块。',
  ].join('\n')

  const lines: string[] = []
  let omitted = 0
  let used = 0
  // Newest-first under the budget, then reversed: when the segment does not fit, the most
  // recent of it survives, because that is where the current state of the work lives.
  for (let i = older.length - 1; i >= 0; i--) {
    const m = older[i]!
    const text = m.text.replace(/\s+/gu, ' ').trim().slice(0, PER_MESSAGE_CHARS)
    const line = `${m.senderName}: ${text}`
    if (used + line.length + 1 > TRANSCRIPT_BUDGET_CHARS) {
      omitted = i + 1
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  lines.reverse()

  const user = [
    `[房间] ${roomName.trim() === '' ? '（未命名）' : roomName.trim()}`,
    `[需要压缩的历史消息：${older.length} 条${omitted > 0 ? `，其中最早的 ${omitted} 条因长度限制未提供` : ''}]`,
    ...lines,
  ].join('\n')
  return { system, user }
}

/**
 * The stream shape this module needs: the plugin's `LlmStream` with the request envelope
 * the host actually accepts.
 *
 * `@deepseek-ai/dsh-llm`'s `GenerateOptions` takes `RequestMessage[]`, whose `content` is a
 * `readonly ContentBlock[]` — `[{ type: 'text', text }]`, never a bare string. The plugin's
 * own `LlmStreamRequest` still declares `content: string`, and a string here is not a
 * cosmetic mismatch: the adapter throws while projecting the message, the stream
 * normalizes that to a bare `TRANSPORT` failure, and the user is told the model call
 * failed with no reason. Verified against the host's own summariser
 * (`dsh-compaction-basic`), which builds exactly these fields:
 * `messages` (blocks), `maxTokens`, `sessionId`, `purpose: 'compaction'`, `signal`.
 */
export interface CompactStreamRequest {
  readonly provider: string
  readonly model: string
  /** Exact model-facing blocks — `ContentBlock[]`, NOT a bare string. */
  readonly messages: readonly {
    readonly role: 'user'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }[]
  readonly system?: string | undefined
  readonly signal?: AbortSignal | undefined
  /**
   * Session identity for request routing; the host documents this as the field the agent
   * loop stamps so adapters can map it to model-hidden transport metadata. The summary
   * belongs to the room's own bot session, so that is the id passed.
   */
  readonly sessionId?: string | undefined
  /** What the call IS. The host names `compaction` for exactly this. */
  readonly purpose?: 'compaction' | undefined
  /**
   * Upper bound on the summary, so a chatty model cannot turn "compress" into a second
   * copy of the conversation.
   */
  readonly maxTokens?: number | undefined
}

/** The summary is asked for in ≤400 Chinese characters; this is a ceiling, not a target. */
export const COMPACT_MAX_TOKENS = 1024

/** One streamed chunk; `LlmChunk` plus the failure facts worth reporting. */
export interface CompactChunk {
  readonly type: string
  readonly text?: string | undefined
  readonly reason?: {
    readonly kind?: string | undefined
    readonly failure?: {
      readonly code?: string | undefined
      readonly message?: string | undefined
      readonly status?: number | undefined
    } | undefined
  } | undefined
}

export type CompactStream = (request: CompactStreamRequest) => AsyncIterable<CompactChunk>

export interface SummariseHistoryOptions {
  readonly stream: CompactStream
  readonly provider: string
  readonly model: string
  readonly roomName: string
  readonly older: readonly CompactSourceMessage[]
  /** The room-bot session the request is routed under, when the caller has one. */
  readonly sessionId?: string | undefined
  readonly timeoutMs?: number | undefined
}

/**
 * Ask the model for the summary. Rejects — and mutates nothing — on timeout or provider error.
 *
 * The caller runs this BEFORE its first write, so a failure leaves the room byte-for-byte
 * as it was; that ordering is what makes "压缩失败" a safe outcome.
 */
export async function summariseHistory(options: SummariseHistoryOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? COMPACT_MODEL_TIMEOUT_MS
  const { system, user } = buildSummaryPrompt(options.roomName, options.older)

  const controller = new AbortController()
  const consume = async (): Promise<string> => {
    let answer = ''
    for await (const chunk of options.stream({
      provider: options.provider,
      model: options.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      signal: controller.signal,
      ...(options.sessionId !== undefined && options.sessionId !== ''
        ? { sessionId: options.sessionId }
        : {}),
      purpose: 'compaction',
      maxTokens: COMPACT_MAX_TOKENS,
    })) {
      if (chunk.type === 'text-delta') answer += chunk.text ?? ''
      if (chunk.type === 'finish') {
        if (chunk.reason?.kind === 'error') {
          // The code and status are the diagnostic part: "transport failed" alone cannot
          // tell a rejected route from an expired credential, and the user-facing notice
          // is the only place this ever surfaces.
          const failure = chunk.reason.failure
          const code = failure?.code !== undefined && failure.code !== ''
            ? `［${failure.code}${failure.status !== undefined ? ` ${failure.status}` : ''}］`
            : ''
          throw new Error(`摘要模型调用失败${code}：${failure?.message ?? '未知错误'}`)
        }
        if (chunk.reason?.kind === 'aborted') {
          throw new Error(`摘要生成在 ${Math.round(timeoutMs / 1000)} 秒内没有完成`)
        }
      }
    }
    const summary = answer.trim()
    if (summary === '') throw new Error('摘要模型没有返回任何正文')
    return summary
  }

  // The race is not redundant with `controller.abort()`: a stream that ignores the signal
  // would otherwise leave the RPC pending for ever. `consume()` is also detached with a
  // catch so its later rejection cannot surface as an unhandled rejection.
  let failDeadline: (error: Error) => void = () => undefined
  const deadline = new Promise<never>((_resolve, reject) => { failDeadline = reject })
  const timer = setTimeout(() => {
    controller.abort()
    failDeadline(new Error(`摘要生成超过 ${Math.round(timeoutMs / 1000)} 秒，已放弃`))
  }, timeoutMs)

  const work = consume()
  work.catch(() => undefined)
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The text of the one message that replaces the compacted segment.
 *
 * The first line stays in the bubble AND in every later prompt: the model has to know that
 * what follows is a summary of a longer conversation, not something a participant said.
 */
export function summaryMessageText(removed: number, summary: string): string {
  return `以下是此前 ${removed} 条消息的压缩摘要（原文已不再保留）：\n\n${summary}`
}

/** `compactRoom`'s request, as the RPC carries it. */
export interface CompactRoomRequest {
  readonly roomId: string
  /** Newest messages to keep verbatim. Defaults to {@link DEFAULT_KEEP_LAST}, clamped to ≥ {@link MIN_KEEP_LAST}. */
  readonly keepLast?: number | undefined
}

/** `compactRoom`'s result. A refusal is a normal answer, not an exception. */
export interface CompactRoomResult {
  /** True only when the room was actually rewritten. */
  readonly compacted: boolean
  /** Why nothing happened, when `compacted` is false. Safe to show verbatim. */
  readonly reason?: string | undefined
  /** How many older messages were replaced by the summary. */
  readonly removed: number
  /** How many newest messages were kept verbatim. */
  readonly kept: number
  /** The summary text, for the caller's notice. Absent on a refusal. */
  readonly summary?: string | undefined
  /**
   * How many stale session ids were retired with the messages.
   *
   * A summary only compresses what the bot carries forward if it can no longer replay
   * the full transcript from its session log, so a successful compaction retires the
   * room's previous session generation (`clearCount`-style) and purges those logs.
   */
  readonly sessionsRetired: number
}

/**
 * The messages a turn should see, given what has been folded.
 *
 * Folding is a WINDOW operation, not a delete: the folded rows stay in the transcript (the
 * panel still shows them, unread arithmetic still counts them) while the prompt gets the
 * checkpoint plus everything that came after it. Without this the room would "compact" and then
 * keep sending the same history to the model.
 */
export function windowForPrompt<T extends { readonly id: string }>(
  messages: readonly T[],
  foldedIds: readonly string[] | undefined,
  historyMessages: number,
): T[] {
  const folded = new Set(foldedIds ?? [])
  const visible = folded.size === 0 ? [...messages] : messages.filter(m => !folded.has(m.id))
  return historyMessages <= 0 ? [] : visible.slice(-historyMessages)
}
