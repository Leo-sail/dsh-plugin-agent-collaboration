/**
 * Leader triage (2026-11-09) — an unaddressed group message is routed by the LEADER, not by a
 * table of heuristics alone.
 *
 * WHY THIS EXISTS. The router can recognise `@name`, a written name, `@all` and management
 * instructions. Everything else is guesswork ("looks like a greeting", "matches a role word"),
 * and the guess decides which bots wake up. The group already has a leader whose job is exactly
 * to decide who does what: give the leader the message plus the roster and let it answer,
 * dispatch, or stay quiet. That is also the only layer that can use semantics, recent events,
 * the current task and per-member descriptions together.
 *
 * WHAT THIS MODULE IS. The prompt ONLY. The service already has the routing/admission state and
 * the dispatch/assign tools; this text tells the leader that it owns the decision and what its
 * options are. Pure so the wording is testable without a host.
 *
 * @module
 */

/** The roster entry the leader needs to make a grounded choice. */
export interface LeaderTriageMember {
  readonly name: string
  readonly description?: string | undefined
}

/** A user message is clipped for the prompt; the transcript keeps the full text. */
export const TRIAGE_MESSAGE_CHARS = 1_500
/** One member description is clipped to keep the triage prompt small. */
export const TRIAGE_DESCRIPTION_CHARS = 120

/**
 * Build the prompt for a leader triage turn.
 *
 * The leader is told what it already can do (answer itself / dispatch / assign / message a peer)
 * and what NOT to do (wake everybody, repeat the message, invent work). No plan ids, no internal
 * stage names — this text is model-facing.
 */
export function buildLeaderTriagePrompt(input: {
  readonly messageText: string
  readonly members: readonly LeaderTriageMember[]
  readonly roomName?: string | undefined
}): string {
  const message = [...input.messageText.trim()].slice(0, TRIAGE_MESSAGE_CHARS).join('')
  const roster = input.members
    .filter(member => member.name.trim() !== '')
    .slice(0, 32)
    .map(member => {
      const description = [...(member.description ?? '').trim()].slice(0, TRIAGE_DESCRIPTION_CHARS).join('')
      return `- ${member.name.trim()}${description !== '' ? `：${description}` : ''}`
    })
    .join('\n')
  return [
    '[需要你判断]',
    input.roomName !== undefined && input.roomName !== ''
      ? `这个群是「${input.roomName}」。用户没有点名任何成员：`
      : '用户没有点名任何成员：',
    `「${message}」`,
    '你是这个群的主持人。请根据消息语义、成员描述、最近的群聊内容、当前任务和群规则，判断这条消息该怎么处理：',
    '· 你自己能回答的，直接回答；',
    '· 更适合某个成员做的，用 dispatch 或 assign_task 把任务交给最合适的人（可以多人，但别叫醒无关成员）；',
    '· 只是招呼、闲聊或不需要行动时，简短回应或结束即可。',
    '不要机械地把消息转给所有成员，也不要复述用户已经看到的话。',
    '群成员：',
    roster === '' ? '（本群暂时没有其他成员）' : roster,
  ].join('\n')
}
