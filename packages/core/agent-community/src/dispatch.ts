/**
 * `dispatch` — handing work to OTHER MEMBERS OF THE ROOM.
 *
 * This is the plugin's answer to "let the bot use something like workflow, without copying
 * DSH's workflow". DSH's `workflow` runs a JavaScript orchestration that spawns child agents
 * INSIDE the caller's session: those children are invisible to the room (no transcript rows,
 * no concurrency accounting, nothing the stop button reaches) and they duplicate the one
 * mechanism a room already has. The user's rule is explicit: workflow should call other BOTS,
 * not create sub-agents.
 *
 * So dispatch is `assign_task`, in bulk, with the waiting handled by the room:
 *
 *   leader calls dispatch → runs are queued for the named members → dispatch returns at once
 *   → the leader's own answer this turn IS the progress report
 *   → when the members settle, the plugin wakes the leader with their reports
 *   → the leader continues (or `finish_task`s)
 *
 * NOTHING BLOCKS. The earlier design had the leader's run wait up to ten minutes, which raced
 * the run timeout (also ten minutes) and lost the summary when the timeout won.
 *
 * @module
 */

/** One piece of work handed to one member. */
export interface DispatchTask {
  readonly bot: string
  readonly task: string
}

/** What the caller asked for. */
export interface DispatchRequest {
  readonly roomKind: 'direct' | 'group'
  readonly callerId: string
  readonly leaderId?: string | undefined
  readonly memberIds: readonly string[]
  /** Members by name, for resolving `bot` without forcing the model to know ids. */
  readonly roster: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly tasks: readonly DispatchTask[]
}

export interface DispatchPlan {
  /** Tasks that will be queued, in order, with the member id they resolved to. */
  readonly accepted: ReadonlyArray<{ readonly botId: string; readonly task: string }>
  /** Tasks refused, with a reason the tool can hand back to the model. */
  readonly refused: ReadonlyArray<{ readonly bot: string; readonly reason: string }>
  /** What to tell the model when nothing was accepted. */
  readonly refusal?: string | undefined
}

/** §5.6's invite budget: one turn may involve at most four bots. */
export const MAX_DISPATCH_TASKS = 4

/**
 * Decide what a dispatch call actually queues.
 *
 * Failures are per-task where they can be (one bad name does not cancel the other three) and
 * whole-call where they must be (wrong room kind, not the leader, nothing to do).
 *
 * @param request - the call, already resolved against the room.
 * @returns accepted and refused tasks, plus a whole-call refusal when applicable.
 */
export function planDispatch(request: DispatchRequest): DispatchPlan {
  if (request.roomKind !== 'group') {
    return {
      accepted: [],
      refused: [],
      refusal: '单聊里没有其他成员，无法派工；需要人手请先 propose_group 建一个群。',
    }
  }
  if (request.leaderId === undefined || request.leaderId !== request.callerId) {
    return {
      accepted: [],
      refused: [],
      refusal: '只有本群的 leader 可以派工；你可以用 task_report 汇报自己的进度。',
    }
  }
  if (request.tasks.length === 0) {
    return { accepted: [], refused: [], refusal: 'tasks 不能为空：请给出要交给谁、做什么。' }
  }
  const byName = new Map<string, string>()
  for (const member of request.roster) {
    byName.set(member.name.toLowerCase(), member.id)
    byName.set(member.id.toLowerCase(), member.id)
  }
  const accepted: Array<{ botId: string; task: string }> = []
  const refused: Array<{ bot: string; reason: string }> = []
  const taken = new Set<string>()
  for (const task of request.tasks) {
    if (accepted.length >= MAX_DISPATCH_TASKS) {
      refused.push({ bot: task.bot, reason: `一次最多派 ${MAX_DISPATCH_TASKS} 件活，这条没有派出去。` })
      continue
    }
    const text = task.task.trim()
    if (text === '') {
      refused.push({ bot: task.bot, reason: '任务内容为空。' })
      continue
    }
    const botId = byName.get(task.bot.trim().toLowerCase())
    if (botId === undefined || !request.memberIds.includes(botId)) {
      refused.push({ bot: task.bot, reason: '它不是本群成员（要加人请先用 invite_bot）。' })
      continue
    }
    if (botId === request.callerId) {
      refused.push({ bot: task.bot, reason: '那是你自己：需要你自己做的部分直接做，不用派工。' })
      continue
    }
    if (taken.has(botId)) {
      refused.push({ bot: task.bot, reason: '已经给它派过一件活了，一次只派一件。' })
      continue
    }
    taken.add(botId)
    accepted.push({ botId, task: text })
  }
  const refusal = accepted.length === 0
    ? '这次没有任何任务派出去，请看每条的原因后重试。'
    : undefined
  return {
    accepted,
    refused,
    ...(refusal !== undefined ? { refusal } : {}),
  }
}

/**
 * The prompt the leader is woken with once its members have settled.
 *
 * Written as a report, not an order: the leader decides whether the job is done, needs another
 * round, or needs to be handed back to the user.
 */
export function handoffReport(input: {
  readonly perBot: ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly text: string }>
  readonly stillRunning: readonly string[]
}): string {
  const lines = ['[成员回报]']
  for (const item of input.perBot) {
    const head = item.ok ? `${item.name} 完成` : `${item.name} 失败`
    const body = item.text.trim() === '' ? '（没有文字回报）' : item.text.trim()
    lines.push(`· ${head}：${body}`)
  }
  if (input.stillRunning.length > 0) {
    lines.push(`· 还没回来：${input.stillRunning.join('、')}（它们的运行已超时或仍在进行）`)
  }
  lines.push('请据此判断：收尾就用 finish_task 给出结论；还需要人手就继续派工；都不需要就直接回答用户。')
  return lines.join('\n')
}
