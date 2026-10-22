/**
 * Snapshot slimming: what the panel needs from the community, and nothing more.
 *
 * WHY THIS MODULE EXISTS. `snapshot()` is polled every 400 ms while a run is live, and it used
 * to serialize the WHOLE community: every message with its reasoning, tool cards, deliverables,
 * token usage and model-facing skill payload, plus every run with its full prompt. Measured on
 * this board that was several megabytes per answer, most of it fields the panel never reads
 * (the transcript is rendered from the ledger, and the snapshot's messages exist only so the
 * unread water mark can pick the newest one per room).
 *
 * The rule encoded here is deliberately conservative:
 *
 *   · messages keep only what the panel uses: id / roomId / sender / clipped text / createdAt
 *     / sequence / mentions. Text is clipped — a 40 KB reply in a poll payload is waste;
 *   · runs keep their scheduling and status fields (the run strip and queue banner read them)
 *     but drop `prompt` and the lease/internal bookkeeping, which no panel surface displays.
 *
 * Both functions are pure and structural, so a new heavy field added to `BotMessage` later
 * cannot leak into the poll payload by accident: only the fields named here are copied.
 *
 * @module
 */
import type {
  BotId,
  BotMessage,
  BotMessageId,
  BotMessageSenderKind,
  BotRoomId,
  BotRun,
  HarnessAttribution,
  RunEvidence,
  RunFaultSide,
  RunFinishPath,
} from './types.ts'
import type { FailureKind } from './run-budget.ts'

/** How much message text the snapshot keeps. The transcript itself comes from the ledger. */
export const SNAPSHOT_TEXT_LIMIT = 240

/** The sender shape as the snapshot carries it (a plain copy, never the live object). */
export interface SnapshotMessageSender {
  readonly kind: BotMessageSenderKind
  readonly botId?: BotId | undefined
  readonly name: string
}

/**
 * One message as the poll payload carries it.
 *
 * Every field here is used by the panel: `id`/`createdAt` anchor the unread water mark,
 * `roomId` scopes it, `sender`/`text`/`mentions` keep the payload self-describing (and let a
 * future preview render without a second RPC), `sequence` keeps stored order.
 */
export interface SnapshotMessage {
  readonly id: BotMessageId
  readonly roomId: BotRoomId
  readonly sender: SnapshotMessageSender
  readonly text: string
  readonly createdAt: string
  readonly sequence?: number | undefined
  readonly mentions?: readonly BotId[] | undefined
}

/**
 * One run as the poll payload carries it.
 *
 * `prompt` is the big one: a run prompt can be tens of kilobytes (a leader brief), and the
 * panel never renders it — the run strip and queue banner read timing, status and failure
 * wording only. The lease fields are likewise internal: the crash-recovery reader lives on the
 * host, not in the browser.
 */
export interface SnapshotRun {
  readonly id: BotRun['id']
  readonly botId: BotRun['botId']
  readonly roomId: BotRun['roomId']
  readonly origin?: BotRun['origin'] | undefined
  readonly status: BotRun['status']
  readonly controlRevision: number
  readonly attempt: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly startedAt?: string | undefined
  readonly finishedAt?: string | undefined
  readonly error?: string | undefined
  readonly lastError?: string | undefined
  /** S8 adaptive-timeout state: the run strip shows the deadline and the failure reason. */
  readonly deadlineAt?: string | undefined
  readonly lastProgressAt?: string | undefined
  readonly extensions?: number | undefined
  readonly failureKind?: FailureKind | undefined
  /**
   * Harness attribution (OP-01): prompt contract + preset + context budgets this run ran
   * under. Small (six scalar fields) and genuinely useful in the panel/audit trail, so it is
   * kept while `prompt`, reasoning and tool output stay out.
   */
  readonly harness?: HarnessAttribution | undefined
  /**
   * OP-04 run evidence: counters, token usage, finish path and failure side only. Copied
   * field by field below, so no free text (prompt, reasoning, tool output) can ever ride
   * along through this object.
   */
  readonly evidence?: SnapshotRunEvidence | undefined
  /** OP-04 failure attribution, for cheap filtering in the panel/audit. */
  readonly faultSide?: RunFaultSide | undefined
}

/**
 * The evidence fields the snapshot exposes: fixed counter keys, three token numbers and two
 * closed enums. There is deliberately no pass-through of unknown keys.
 */
export interface SnapshotRunEvidence {
  readonly durationMs?: number | undefined
  readonly promptChars?: number | undefined
  readonly toolCalls?: number | undefined
  readonly toolFailures?: number | undefined
  readonly deliverableCount?: number | undefined
  readonly contextWindowMessages?: number | undefined
  readonly approvalRequests?: number | undefined
  readonly usage?: {
    readonly uncachedInputTokens: number
    readonly outputTokens: number
    readonly totalTokens: number
  } | undefined
  readonly finishPath?: RunFinishPath | undefined
  readonly faultSide?: RunFaultSide | undefined
  /** OP-15: per-section character counts (numbers only — never the prompt text). */
  readonly contextSections?: Readonly<Record<string, number>> | undefined
  /** OP-15: rough prompt-token estimate (label only). */
  readonly promptTokensEstimate?: number | undefined
}

/** Clip message text to the snapshot budget, code-point safe and with an explicit marker. */
export function clipSnapshotText(text: string, limit = SNAPSHOT_TEXT_LIMIT): string {
  if (!Number.isFinite(limit) || limit < 0) return text
  if (text.length <= limit) return text
  if (limit === 0) return ''
  // Slice by code points so a long emoji/Chinese string cannot end in a lone surrogate (which
  // JSON.stringify would escape as an opaque replacement, making the clip look corrupt).
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  return `${chars.slice(0, limit - 1).join('')}…`
}

/** One message → the subset the snapshot may carry. Only named fields are copied. */
export function summarizeSnapshotMessage(message: BotMessage): SnapshotMessage {
  return {
    id: message.id,
    roomId: message.roomId,
    sender: {
      kind: message.sender.kind,
      ...(message.sender.botId !== undefined ? { botId: message.sender.botId } : {}),
      name: message.sender.name,
    },
    text: clipSnapshotText(message.text),
    createdAt: message.createdAt,
    ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
    ...(message.mentions !== undefined ? { mentions: [...message.mentions] } : {}),
  }
}

/** Every message → its snapshot summary (a fresh array, so the poll cannot alias state). */
export function summarizeSnapshotMessages(messages: readonly BotMessage[]): SnapshotMessage[] {
  return messages.map(summarizeSnapshotMessage)
}

/** One run → the subset the snapshot may carry. `prompt` and lease fields are dropped. */
export function summarizeSnapshotRun(run: BotRun): SnapshotRun {
  return {
    id: run.id,
    botId: run.botId,
    roomId: run.roomId,
    ...(run.origin !== undefined ? { origin: run.origin } : {}),
    status: run.status,
    controlRevision: run.controlRevision,
    attempt: run.attempt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.lastError !== undefined ? { lastError: run.lastError } : {}),
    ...(run.deadlineAt !== undefined ? { deadlineAt: run.deadlineAt } : {}),
    ...(run.lastProgressAt !== undefined ? { lastProgressAt: run.lastProgressAt } : {}),
    ...(run.extensions !== undefined ? { extensions: run.extensions } : {}),
    ...(run.failureKind !== undefined ? { failureKind: run.failureKind } : {}),
    // A frozen attribution object copied by reference: its six scalar fields are bounded and
    // `Object.freeze` means the snapshot cannot be mutated through this path.
    ...(run.harness !== undefined ? { harness: run.harness } : {}),
    ...(run.evidence !== undefined ? { evidence: snapshotEvidence(run.evidence) } : {}),
    ...(run.faultSide !== undefined ? { faultSide: run.faultSide } : {}),
  }
}

/** Whitelisted copy of one evidence record: counters/enums only, never free text. */
function snapshotEvidence(evidence: RunEvidence): SnapshotRunEvidence {
  return {
    ...(evidence.durationMs !== undefined ? { durationMs: evidence.durationMs } : {}),
    ...(evidence.promptChars !== undefined ? { promptChars: evidence.promptChars } : {}),
    ...(evidence.toolCalls !== undefined ? { toolCalls: evidence.toolCalls } : {}),
    ...(evidence.toolFailures !== undefined ? { toolFailures: evidence.toolFailures } : {}),
    ...(evidence.deliverableCount !== undefined ? { deliverableCount: evidence.deliverableCount } : {}),
    ...(evidence.contextWindowMessages !== undefined ? { contextWindowMessages: evidence.contextWindowMessages } : {}),
    ...(evidence.approvalRequests !== undefined ? { approvalRequests: evidence.approvalRequests } : {}),
    ...(evidence.usage !== undefined ? {
      usage: {
        uncachedInputTokens: evidence.usage.uncachedInputTokens,
        outputTokens: evidence.usage.outputTokens,
        totalTokens: evidence.usage.totalTokens,
      },
    } : {}),
    ...(evidence.finishPath !== undefined ? { finishPath: evidence.finishPath } : {}),
    ...(evidence.faultSide !== undefined ? { faultSide: evidence.faultSide } : {}),
    // A bounded, numeric copy: section names + character counts only, so nothing textual can
    // ride into the poll payload through the measurement.
    ...(evidence.contextSections !== undefined
      ? {
          contextSections: Object.fromEntries(
            Object.entries(evidence.contextSections)
              .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
              .slice(0, 32),
          ),
        }
      : {}),
    ...(evidence.promptTokensEstimate !== undefined
      ? { promptTokensEstimate: evidence.promptTokensEstimate }
      : {}),
  }
}

/** Every run → its snapshot summary (a fresh array). */
export function summarizeSnapshotRuns(runs: readonly BotRun[]): SnapshotRun[] {
  return runs.map(summarizeSnapshotRun)
}
