/**
 * QuestionComposer — the answer surface that takes over the INPUT BOX while a bot waits.
 *
 * Native DSH answers a question in the composer slot (`QuestionComposer` renders where the
 * chat input normally is), and this plugin now does the same: while a question is pending the
 * composer is replaced by this card, so the answer is typed exactly where every other message
 * is typed — no centered modal, nothing to find. When the question is answered the composer
 * comes straight back.
 *
 * CHOOSING IS NOT ANSWERING. Clicking an option used to answer immediately, which made a
 * mis-click final and gave the user no chance to change their mind (and, for a question whose
 * options are the whole answer, no confirmation step at all). Picking now only marks the row;
 * 提交 sends it. Typed text still wins over a picked row (see `answerSelection`).
 *
 * WHY IT EXISTS AT ALL
 * Bots have `ask_user_question`, but the host's implementation waits for an answer submitted
 * through the DSH session UI — and a bot's session is a hidden subagent session with no such
 * surface here. The plugin therefore registers its OWN `ask_user_question` for bot scopes (see
 * QuestionBridge on the host): it writes a `question` ledger row — the row this card renders —
 * and blocks the turn until the answer comes back through one RPC.
 */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { css } from '../styles.ts'
import type { LedgerEntry } from './types.ts'
import { canSubmit, resolveAnswer } from './answerSelection.ts'

export interface QuestionView {
  readonly questionId: string
  readonly question: string
  readonly options: readonly string[]
  readonly allowFreeText: boolean
  readonly botName: string
}

/** The newest unanswered question in a room, or undefined when none is waiting. */
export function pendingQuestion(entries: ReadonlyArray<LedgerEntry>): QuestionView | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!
    if (entry.type !== 'question') continue
    const row = entry as unknown as {
      questionId?: string; question?: string; options?: string[]
      allowFreeText?: boolean; status?: string; botName?: string
    }
    // Newest first: a row that is already answered must not reopen the card.
    if (row.status !== 'pending') return undefined
    return {
      questionId: String(row.questionId ?? ''),
      question: String(row.question ?? ''),
      options: Array.isArray(row.options) ? row.options : [],
      allowFreeText: row.allowFreeText !== false,
      botName: String(row.botName ?? ''),
    }
  }
  return undefined
}

export function QuestionComposer({ view, busy = false, onAnswer, onSkip }: {
  view: QuestionView
  busy?: boolean | undefined
  onAnswer: (questionId: string, answer: string) => void | Promise<void>
  onSkip: (questionId: string) => void | Promise<void>
}): ReturnType<typeof Input> {
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string | undefined>(undefined)
  /**
   * One submission at a time.
   *
   * The answer RPC is not instant (it can round-trip through the host and reload the
   * ledger), and the old card gave no sign that anything had happened: no spinner, no
   * disabled state. A user who clicked twice therefore sent two answers, the second of
   * which the host refused — and that refusal was invisible. `submitting` makes the
   * click observable and the double-click impossible.
   */
  const [submitting, setSubmitting] = useState(false)
  /**
   * Why the last submission failed, in the card itself.
   *
   * The transport can reject (host gone, deadline), and until now that rejection was
   * `void`-swallowed by the caller — the card just sat there. A failure that is not
   * painted is indistinguishable from a dead control, which is exactly the reported
   * 「打字回答或点跳过都没有反应」.
   */
  const [error, setError] = useState<string | undefined>(undefined)
  const disabled = busy || submitting
  /**
   * Await one action, then always release the latch.
   *
   * `onAnswer`/`onSkip` may return a promise (the panel's handler does); awaiting the
   * union covers both shapes. A refusal that arrives as `{ ok: false }` is handled by
   * the panel (notice + reload) and does NOT reject here — only a real transport
   * failure reaches the catch below.
   */
  const run = async (action: () => void | Promise<void>, failureLabel: string): Promise<void> => {
    setSubmitting(true)
    setError(undefined)
    try {
      await action()
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      setError(`${failureLabel}：${message === '' ? '未知错误' : message}`)
    } finally {
      setSubmitting(false)
    }
  }
  // Picking only selects. `resolveAnswer` decides what actually goes to the bot, and refuses when
  // there is nothing to send (an empty answer would look like a real reply to a waiting bot).
  const submit = (): void => {
    if (disabled) return
    const answer = resolveAnswer({ picked, text })
    if (answer === undefined) return
    void run(() => onAnswer(view.questionId, answer), '提交失败')
  }
  const skip = (): void => {
    if (disabled) return
    void run(() => onSkip(view.questionId), '跳过失败')
  }
  return (
    // Same shell as the composer it replaces — same width, radius, surface and elevation.
    <div className="ac-composer-root">
      <div className="ac-composer-card" role="group" aria-label={`${view.botName} 的问题`}>
        <div className={css.questionHead}>
          <span className={css.questionFrom}>{view.botName} 想先问你</span>
          <span className={css.questionHint}>回答后它继续干活</span>
        </div>
        <p className={css.questionText}>{view.question}</p>
        {view.options.length > 0 && (
          <div className={css.questionOptions}>
            {view.options.map(option => (
              <button
                key={option}
                type="button"
                // Attribute AND class: assistive tech reads the pressed state, the stylesheet
                // paints it, and neither depends on the other.
                aria-pressed={picked === option}
                className={picked === option ? `${css.questionOption} ${css.questionOptionPicked}` : css.questionOption}
                disabled={disabled}
                onClick={() => { setPicked(current => (current === option ? undefined : option)) }}
              >{option}</button>
            ))}
          </div>
        )}
        {/* ONE row for the answer controls: type here, or skip — 跳过 and 提交 side by side, so
            neither is hunting for the other at opposite corners of the card. */}
        <div className={css.questionComposerRow}>
          {view.allowFreeText && (
            <Input
              className={css.questionInput}
              type="text"
              value={text}
              placeholder="或者直接输入你的回答"
              disabled={disabled}
              onChange={e => setText(e.target.value)}
              onKeyDown={(e: { key: string }) => { if (e.key === 'Enter') submit() }}
            />
          )}
          <Button className={css.pick} variant="ghost" disabled={disabled} onClick={skip}>跳过</Button>
          {/* ALWAYS RENDERED. It used to appear only for questions that allowed free text, so a
              question whose options ARE the answer had no submit control at all — picking one
              was the only way to answer, and therefore had to answer immediately. */}
          <Button
            className={css.pick}
            variant="primary"
            disabled={disabled || !canSubmit({ picked, text })}
            onClick={submit}
          >{submitting ? '提交中…' : '提交'}</Button>
        </div>
        {/* The failure line lives INSIDE the card: the card is the whole answer surface, so its
            error has to be where the user is looking — not on a notice row in the transcript,
            which the card itself is covering. */}
        {error !== undefined && (
          <p role="alert" className={css.error} style={{ margin: '8px 0 0', fontSize: 12 }}>{error}</p>
        )}
      </div>
    </div>
  )
}
