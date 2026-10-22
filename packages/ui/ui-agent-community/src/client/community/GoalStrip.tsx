/**
 * GoalStrip — the user's authorization gate for a room's goal, drawn above the transcript.
 *
 * WHY IT EXISTS. A room goal that the bot can keep advancing on its own is a chain of model
 * calls the user did not start. The host therefore parks a newly-suggested goal as
 * `status: 'proposed'`: nothing runs until the user grants it an explicit, bounded
 * authorization (`authorization.maxRounds`), and a goal that hits its stall guard pauses
 * itself. This strip is the ONLY user-facing surface for that gate — without it a proposed
 * goal is invisible and the room can never enter automatic continuation legally.
 *
 * WHAT IT RENDERS (one line, actions on the right):
 *   · proposed → 「目标建议：…」 + 允许自动续跑 / 先不启用
 *   · active, authorized → 「自动续跑 used/max：…」 + 暂停
 *   · active, not authorized → 「目标进行中：…（未授权，不会自动续跑）」 + 允许 / 暂停
 *   · paused → 「已暂停：…」 + 继续
 *   · done / no goal → nothing (the strip is a control, not a history view)
 *
 * The room record arrives from the snapshot the page already polls, so every successful
 * action ends with `onReload()` and the new status paints on the next tick. The host records
 * its own durable notice row for an accepted transition; the shell's `onNotice` is used only
 * for answers the host does NOT record (refusals and transport failures), so one click never
 * leaves two identical rows in the transcript. A refusal also stays in the strip itself.
 *
 * @module
 */
import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { BotRoom } from '@dsh-plugin-agent-community/agent-community'
import type { CommunityRemote } from './types.ts'
import { describe } from './types.ts'

/**
 * Automatic continuation rounds a first grant allows.
 *
 * Three is the host's own default for a user grant (`DEFAULT_GOAL_MAX_ROUNDS` in core's
 * `room-goal.ts`): enough to carry a task across a few real rounds, small enough that an
 * unintended grant cannot burn a long chain of model calls. The user can grant again after
 * those rounds; the host clamps whatever a caller sends.
 */
export const DEFAULT_GOAL_MAX_ROUNDS = 3

export interface GoalStripProps {
  /** The room on screen. Its `goal` field is the whole data source. */
  room: BotRoom
  remote: CommunityRemote
  /**
   * Re-read the snapshot after an action. Deliberately takes no room: the reload must keep
   * whatever the user has selected by the time it lands (see `selection.ts`).
   */
  onReload: () => Promise<void>
  /** The shell's notice sink — one durable row in the transcript for each outcome. */
  onNotice: (text: string) => void
}

type GoalAction = 'authorize' | 'pause' | 'resume'

/** Button captions, also used in the notice text so both halves agree. */
const ACTION_LABEL: Readonly<Record<GoalAction, string>> = {
  authorize: '允许自动续跑',
  pause: '暂停',
  resume: '继续',
}

/**
 * NOTE ON SUCCESS FEEDBACK: no notice is recorded here for a successful action.
 *
 * The host already records one durable `dispatch` row for each accepted goal transition
 * (`authorizeRoomGoal` → 「目标已授权自动续跑…」, `pauseRoomGoal` → 「目标已暂停…」,
 * `resumeRoomGoal` → 「目标已继续…」 in the core service). Calling `onNotice` on success as
 * well would draw a SECOND identical grey row in the transcript for one click. The shell's
 * notice sink is therefore reserved for the answers the host does NOT record: refusals
 * (`ok:false` with a reason) and transport failures.
 */

/** The strip's outer row: a quiet banner above the transcript, not a floating toast. */
const stripStyle: CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  // The error line (flexBasis 100%) wraps under the control row instead of squeezing it.
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: '18px',
}

/** The goal line: one clipped row, full text on hover. */
const labelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const buttonStyle: CSSProperties = {
  flexShrink: 0,
  height: 24,
  padding: '0 10px',
  border: '0.5px solid var(--dsw-alias-border-l3)',
  borderRadius: 'var(--dsw-radius-sm, 4px)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: 1,
  cursor: 'pointer',
}

/** The error line sits under the control row, in the same banner. */
const errorStyle: CSSProperties = {
  flexBasis: '100%',
  color: 'var(--dsw-alias-state-error-primary)',
  overflowWrap: 'anywhere',
}

/** One clipped goal line for the current status. */
function goalLine(goal: NonNullable<BotRoom['goal']>): string {
  const text = goal.text
  if (goal.status === 'proposed') return `目标建议：${text}`
  if (goal.status === 'paused') return `已暂停：${text}`
  const authorization = goal.authorization
  if (authorization === undefined) return `目标进行中：${text}（未授权，不会自动续跑）`
  return `自动续跑 ${authorization.roundsUsed}/${authorization.maxRounds}：${text}`
}

export function GoalStrip({ room, remote, onReload, onNotice }: GoalStripProps) {
  const [pending, setPending] = useState<GoalAction | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const goal = room.goal

  // No goal, or one that finished: the strip has nothing to authorize or control.
  if (goal === undefined || goal.status === 'done') return null

  const busy = pending !== undefined
  const authorized = goal.status === 'active' && goal.authorization !== undefined

  const run = async (action: GoalAction): Promise<void> => {
    // One action at a time: the buttons stay disabled until the host answered, so a double
    // click cannot grant a goal twice or race a pause against a resume.
    if (busy) return
    setPending(action)
    setError(undefined)
    try {
      const result = action === 'authorize'
        ? await remote.authorizeRoomGoal({ roomId: room.id, maxRounds: DEFAULT_GOAL_MAX_ROUNDS })
        : action === 'pause'
          ? await remote.pauseRoomGoal({ roomId: room.id })
          : await remote.resumeRoomGoal({ roomId: room.id })
      if (!result.ok) {
        const reason = result.reason ?? '宿主没有说明原因。'
        setError(`${ACTION_LABEL[action]}失败：${reason}`)
        onNotice(`${ACTION_LABEL[action]}失败：${reason}`)
        return
      }
      // Success: the host already wrote its own durable notice row (see the note above), so
      // only the snapshot needs re-reading for the strip to show the new status.
      await onReload()
    } catch (e: unknown) {
      const message = describe(e)
      setError(`${ACTION_LABEL[action]}失败：${message}`)
      onNotice(`${ACTION_LABEL[action]}失败：${message}`)
    } finally {
      setPending(undefined)
    }
  }

  return (
    <div style={stripStyle} data-goal-strip="" data-goal-status={goal.status}>
      <span style={labelStyle} title={goal.text}>{goalLine(goal)}</span>
      {goal.status === 'proposed' && (
        <>
          <button
            type="button"
            style={buttonStyle}
            disabled={busy}
            onClick={() => { void run('authorize') }}
          >
            {pending === 'authorize' ? '处理中…' : ACTION_LABEL.authorize}
          </button>
          <button
            type="button"
            style={buttonStyle}
            disabled={busy}
            onClick={() => { void run('pause') }}
            title="把这个建议收起来，不启用自动续跑"
          >
            {pending === 'pause' ? '处理中…' : '先不启用'}
          </button>
        </>
      )}
      {goal.status === 'active' && (
        <>
          {!authorized && (
            <button
              type="button"
              style={buttonStyle}
              disabled={busy}
              onClick={() => { void run('authorize') }}
            >
              {pending === 'authorize' ? '处理中…' : ACTION_LABEL.authorize}
            </button>
          )}
          <button
            type="button"
            style={buttonStyle}
            disabled={busy}
            onClick={() => { void run('pause') }}
          >
            {pending === 'pause' ? '处理中…' : ACTION_LABEL.pause}
          </button>
        </>
      )}
      {goal.status === 'paused' && (
        <button
          type="button"
          style={buttonStyle}
          disabled={busy}
          onClick={() => { void run('resume') }}
        >
          {pending === 'resume' ? '处理中…' : ACTION_LABEL.resume}
        </button>
      )}
      {error !== undefined && (
        <span style={errorStyle} role="alert">{error}</span>
      )}
    </div>
  )
}
