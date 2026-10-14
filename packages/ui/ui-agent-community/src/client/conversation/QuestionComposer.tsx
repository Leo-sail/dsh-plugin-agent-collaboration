/**
 * QuestionComposer — the answer surface that takes over the INPUT BOX while a bot waits.
 *
 * Native DSH answers a question in the composer slot (`QuestionComposer` renders where the
 * chat input normally is), and this plugin now does the same: while a question is pending the
 * composer is replaced by this card, so the answer is typed exactly where every other message
 * is typed — no centered modal, nothing to find. When the question is answered the composer
 * comes straight back.
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
  const pick = (option: string): void => { void onAnswer(view.questionId, option) }
  const submitText = (): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    void onAnswer(view.questionId, trimmed)
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
                className={css.questionOption}
                disabled={busy}
                onClick={() => pick(option)}
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
              disabled={busy}
              onChange={e => setText(e.target.value)}
              onKeyDown={(e: { key: string }) => { if (e.key === 'Enter') submitText() }}
            />
          )}
          <Button className={css.pick} variant="ghost" disabled={busy} onClick={() => { void onSkip(view.questionId) }}>跳过</Button>
          {view.allowFreeText && (
            <Button className={css.pick} variant="primary" disabled={busy || text.trim() === ''} onClick={submitText}>提交</Button>
          )}
        </div>
      </div>
    </div>
  )
}
