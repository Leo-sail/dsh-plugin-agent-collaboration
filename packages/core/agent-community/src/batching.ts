/**
 * Message batching (S0-5) — merge a burst of user messages into the ONE run that is still
 * waiting to start.
 *
 * WHY THIS EXISTS. A person types two or three lines instead of one. Today each line routes
 * independently and creates its own run, so the same bot answers the same request several times
 * and pays for several full prompts; the Super-agent article's router avoids this by batching the
 * triggers that arrived while it was busy. This module is the deterministic half of that idea for
 * a room: given the open batch for one `(room, bot)` pair, decide whether the next user message
 * may be folded into the waiting run instead of opening another one.
 *
 * WHAT MAY MERGE (all must hold):
 *   · batching is enabled for the deployment;
 *   · an open batch exists and its run is still `queued` (never a running or settled run — folding
 *     into a turn the model already started would produce an answer to a prompt nobody read);
 *   · the new message arrives within the window of the LAST merge, and the batch holds fewer
 *     messages than the cap;
 *   · the new message belongs to the SAME thread/task key, so two unrelated instructions in the
 *     same room are never silently combined.
 *
 * The service only merges when EVERY target of the message is batchable; a partially merged
 * instruction would leave one bot answering a combined prompt and another answering half of it.
 * That decision is made by the caller from per-target {@link mergeBatch} results.
 *
 * @module
 */

/** Deployment-level batching settings; `enabled` is false until the feature is validated. */
export interface BatchingConfig {
  readonly enabled: boolean
  /** How long after the last merge another message may still join (milliseconds). */
  readonly windowMs: number
  /** Most messages one batch holds; the next one opens a fresh run. */
  readonly maxMessages: number
}

/** Defaults: off, a 2.5 s window, at most 5 messages. */
export const DEFAULT_BATCHING: BatchingConfig = {
  enabled: false,
  windowMs: 2_500,
  maxMessages: 5,
}

/** Clamp a partial deployment config into the shape the decision code reads. */
export function normalizeBatching(input: Partial<BatchingConfig> | undefined): BatchingConfig {
  const windowMs = input?.windowMs
  const maxMessages = input?.maxMessages
  return {
    enabled: input?.enabled ?? DEFAULT_BATCHING.enabled,
    windowMs: Number.isFinite(windowMs) && (windowMs as number) >= 0
      ? Math.floor(windowMs as number)
      : DEFAULT_BATCHING.windowMs,
    maxMessages: Number.isFinite(maxMessages) && (maxMessages as number) >= 1
      ? Math.floor(maxMessages as number)
      : DEFAULT_BATCHING.maxMessages,
  }
}

/** One queued run that may still accept more user messages. */
export interface OpenBatch {
  readonly runId: string
  /** Thread/task identity both messages must share; `''` means "the room, no thread". */
  readonly threadKey: string
  readonly openedAt: number
  /** When the last message joined — the sliding window anchor. */
  readonly lastAt: number
  /** Message texts already folded in, oldest first. */
  readonly parts: readonly string[]
  /** Message ids already folded in, same order as {@link parts}. */
  readonly messageIds: readonly string[]
}

/** One incoming user message. */
export interface BatchMessage {
  readonly id: string
  readonly text: string
}

/** What to do with one incoming message for one target. */
export type BatchMergeResult =
  | {
      readonly kind: 'merged'
      /** The complete prompt the waiting run should carry from now on. */
      readonly prompt: string
      /** Parts after the merge (old + new), for the next decision. */
      readonly parts: readonly string[]
      readonly messageIds: readonly string[]
    }
  | {
      readonly kind: 'closed'
      /** Why this batch cannot take the message; the caller drops it and starts a new run. */
      readonly reason: 'disabled' | 'expired' | 'limit' | 'thread-changed' | 'run-not-queued'
    }
  | { readonly kind: 'none' }

export interface BatchMergeInput {
  /** The open batch for the target, if any. */
  readonly batch: OpenBatch | undefined
  /** The batch's run status right now (`queued` is the only mergeable one). */
  readonly runStatus: string | undefined
  readonly now: number
  readonly config: BatchingConfig
  /** Thread/task identity of the incoming message. */
  readonly threadKey: string
  readonly message: BatchMessage
}

/** The thread/task identity two messages must share to be merged. */
export function threadKeyOf(threading: { readonly threadId?: string | undefined; readonly taskId?: string | undefined }): string {
  return `${threading.threadId ?? ''}\u0000${threading.taskId ?? ''}`
}

/**
 * Render the merged prompt.
 *
 * A single message keeps its original text (a batch of one must be indistinguishable from
 * today's input, so the model sees exactly what it always saw). Two or more get an explicit
 * ordered block: the model must not read the second line as a correction of the first, and the
 * short message ids let a confusing answer be traced back to the messages that caused it.
 */
export function renderBatchPrompt(parts: readonly string[], messageIds: readonly string[] = []): string {
  if (parts.length === 1) return parts[0] ?? ''
  const lines = [`【本轮输入合并了 ${parts.length} 条连续消息，按时间顺序处理；如果互相矛盾，先向用户确认】`]
  parts.forEach((part, index) => {
    const id = messageIds[index]
    const label = id === undefined ? `[消息 ${index + 1}]` : `[消息 ${index + 1} · ${id.slice(0, 8)}]`
    lines.push(`${label} ${part}`)
  })
  return lines.join('\n')
}

/** The decision for one incoming message and one target. */
export function mergeBatch(input: BatchMergeInput): BatchMergeResult {
  const { batch, runStatus, now, config, threadKey, message } = input
  if (batch === undefined) return { kind: 'none' }
  if (!config.enabled) return { kind: 'closed', reason: 'disabled' }
  if (runStatus !== 'queued') return { kind: 'closed', reason: 'run-not-queued' }
  if (batch.threadKey !== threadKey) return { kind: 'closed', reason: 'thread-changed' }
  if (now - batch.lastAt > config.windowMs) return { kind: 'closed', reason: 'expired' }
  if (batch.parts.length >= config.maxMessages) return { kind: 'closed', reason: 'limit' }
  const parts = [...batch.parts, message.text]
  const messageIds = [...batch.messageIds, message.id]
  return {
    kind: 'merged',
    prompt: renderBatchPrompt(parts, messageIds),
    parts,
    messageIds,
  }
}

/** The batch to remember after a run was created for a first message. */
export function startBatch(input: {
  readonly runId: string
  readonly threadKey: string
  readonly message: BatchMessage
  readonly now: number
}): OpenBatch {
  return {
    runId: input.runId,
    threadKey: input.threadKey,
    openedAt: input.now,
    lastAt: input.now,
    parts: [input.message.text],
    messageIds: [input.message.id],
  }
}
