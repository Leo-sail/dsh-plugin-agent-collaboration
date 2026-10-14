/**
 * QuestionBridge — a bot asks the user a question and waits for the answer.
 *
 * WHY A BRIDGE AND NOT THE HOST'S `ask_user_question`
 * That tool waits for an answer submitted through the DSH session UI. A bot's session is a
 * hidden subagent session with no such UI in this panel, so handing it to a bot means a turn
 * that stalls on a question the user never sees. This bridge gives the plugin's own surface
 * instead: the question becomes a ledger row the panel renders as a card, and the answer comes
 * back through one RPC.
 *
 * Shape borrowed from `ApprovalBridge` on purpose — same pending-map, same resolve-from-anywhere
 * discipline, so both blocking surfaces behave identically under concurrency (several bots may
 * be waiting at once, each with its own row).
 *
 * Timeout: a bot must never be stuck forever. When nobody answers in time the row is marked
 * `expired` and the tool result tells the bot to decide for itself, which keeps the room moving.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LedgerProjector } from './ledger.ts'
import type { BotId, BotRoomId } from './types.ts'

/** What the caller (the tool) gets back. */
export interface QuestionOutcome {
  readonly status: 'answered' | 'skipped' | 'expired'
  /** Empty unless `status === 'answered'`. */
  readonly answer: string
}

export interface AskQuestionInput {
  readonly roomId: BotRoomId
  readonly botId: BotId
  readonly runId?: string | undefined
  readonly question: string
  readonly options: readonly string[]
  readonly allowFreeText: boolean
}

/** Default wait: long enough for a user who stepped away, short enough to unblock the room. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60_000

interface PendingQuestion {
  readonly entryId: string
  readonly roomId: BotRoomId
  resolve(outcome: QuestionOutcome): void
  readonly timer: ReturnType<typeof setTimeout>
}

export class QuestionBridge {
  private readonly ctx: Context
  private readonly ledger: LedgerProjector
  private readonly pending = new Map<string, PendingQuestion>()
  private readonly timeoutMs: number
  private seq = 0

  constructor(ctx: Context, ledger: LedgerProjector, opts: { timeoutMs?: number } = {}) {
    this.ctx = ctx
    this.ledger = ledger
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS
  }

  /** How many questions are waiting — used by tests and by a health log line. */
  pendingCount(): number {
    return this.pending.size
  }

  /**
   * Record the question and wait for the user.
   *
   * Never rejects: an unanswered question resolves as `expired`, because the bot's turn has to
   * end in something the model can act on.
   */
  async ask(input: AskQuestionInput): Promise<QuestionOutcome> {
    const questionId = `q-${Date.now().toString(36)}-${(this.seq += 1).toString(36)}`
    const botName = this.ledger.botName(input.botId)
    const now = new Date().toISOString()
    const entry = this.ledger.push({
      type: 'question',
      roomId: input.roomId,
      botId: input.botId,
      botName,
      questionId,
      question: input.question,
      options: [...input.options],
      allowFreeText: input.allowFreeText,
      status: 'pending',
      at: now,
      ...(input.runId !== undefined ? { runId: input.runId as never } : {}),
    } as never)

    return await new Promise<QuestionOutcome>(resolve => {
      const settle = (outcome: QuestionOutcome): void => {
        const pending = this.pending.get(questionId)
        if (pending === undefined) return
        clearTimeout(pending.timer)
        this.pending.delete(questionId)
        this.ledger.patch(entry.id, input.roomId, {
          status: outcome.status,
          ...(outcome.answer !== '' ? { answer: outcome.answer } : {}),
          answeredAt: new Date().toISOString(),
        } as never)
        this.ctx.logger?.info?.(
          `agent-community: question ${questionId} from ${botName} → ${outcome.status}`,
        )
        resolve(outcome)
      }

      const timer = setTimeout(() => {
        settle({ status: 'expired', answer: '' })
      }, this.timeoutMs)
      // Do not hold the process open on a question nobody answers.
      ;(timer as unknown as { unref?(): void }).unref?.()

      this.pending.set(questionId, { entryId: entry.id, roomId: input.roomId, resolve: settle, timer })
    })
  }

  /** The user picked an option or typed an answer. */
  answer(questionId: string, answer: string): boolean {
    const pending = this.pending.get(questionId)
    if (pending === undefined) return false
    pending.resolve({ status: 'answered', answer })
    return true
  }

  /** The user dismissed the question. */
  skip(questionId: string): boolean {
    const pending = this.pending.get(questionId)
    if (pending === undefined) return false
    pending.resolve({ status: 'skipped', answer: '' })
    return true
  }

  /** Resolve every waiting question — used on teardown so no turn is left hanging. */
  dispose(): void {
    for (const [id, pending] of [...this.pending]) {
      pending.resolve({ status: 'expired', answer: '' })
      this.pending.delete(id)
    }
  }
}
