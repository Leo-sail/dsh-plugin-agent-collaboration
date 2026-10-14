/**
 * Perception scope: what a bot is allowed to know about the other bots.
 *
 * Two different things, deliberately:
 *
 *   roster  — "these bots exist and here is what they are good at" (DIRECT chat only)
 *   members — "these bots are in this room with you"                  (GROUP chat only)
 *
 * Knowing a bot exists never implies seeing its conversation, and never implies it is in
 * the room. §5.2.
 *
 * RED LINE: in a group room the prompt must not contain the NAME of a bot that is not a
 * member — not to mention it, not to hint at it. Every string this module produces is
 * built from the member set alone in group mode, so a non-member cannot leak in through a
 * roster block, and it cannot leak in through a delta either: the delta compares the
 * VISIBLE projection, so an unrelated bot being renamed produces no message at all.
 *
 * Branded ids (`BotId`) are strings, so the plain `string` fields below stay structurally
 * compatible with the kernel types without importing them.
 */

/** The room fields perception reads; `undefined` means the room could not be resolved. */
export interface PerceptionRoom {
  readonly memberIds: readonly string[]
  readonly directBotId?: string | undefined
}

/**
 * A room as callers actually have it.
 *
 * Both natural call shapes are accepted: the whole room object (with `id`, `name`, … —
 * ignored here) and a freshly built literal, which often carries extra keys too. A plain
 * interface rejects the literal through excess-property checking, and adding an index
 * signature rejects the full room object because an interface has no implicit index
 * signature; the union takes either.
 */
export type PerceptionRoomInput = PerceptionRoom | (PerceptionRoom & { readonly [key: string]: unknown })

export interface PerceptionBot {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
}

export interface PerceptionInput {
  /**
   * The room the bot is running in.
   *
   * Absent (lookup failed, room deleted) is treated as a group with no members: when
   * membership is unknown the only safe direction is to reveal less, never more.
   */
  readonly room?: PerceptionRoomInput | undefined
  /** Every bot that exists. In group mode this is filtered down to members. */
  readonly bots: readonly PerceptionBot[]
  readonly selfId: string
  /**
   * Skill-name universe, tracked for `[技能变更]` deltas only.
   *
   * The skill block itself (`[可用技能]`, identity pre-selection) belongs to the skill
   * profile path in §5.3; emitting it here too would duplicate it in the prompt.
   */
  readonly skills?: readonly string[] | undefined
}

/** Everything that can change under a bot's feet, as observed on one step. */
export interface PerceptionValue {
  readonly room?: PerceptionRoomInput | undefined
  readonly bots: readonly PerceptionBot[]
  readonly skills?: readonly string[] | undefined
}

export type PerceptionMode = 'group' | 'direct'

export interface Perception {
  /** The prompt section describing this bot's perception scope. */
  readonly systemContext: string
  /** Which rule set produced {@link systemContext}. */
  readonly mode: PerceptionMode
  /** Value {@link systemContext} was built from; pass it to the first delta check. */
  readonly value: PerceptionValue
  /**
   * Text to APPEND as a new user message when the visible perception changed, or
   * `undefined` when nothing changed.
   *
   * Appending only on change is what keeps the conversation append-only, which is what
   * keeps the provider's KV cache valid (§17.5 decision 7).
   */
  deltaOnChange(value: PerceptionValue): string | undefined
}

/** Visible state, already filtered for the mode — this is what the prompt is built from. */
interface Projection {
  readonly mode: PerceptionMode
  /** Group mode: rendered member labels. Direct mode: empty. */
  readonly members: readonly string[]
  /** Direct mode: rendered roster lines. Group mode: empty. */
  readonly roster: readonly string[]
  /** Sorted skill names, or `undefined` when the caller does not report skills. */
  readonly skills: readonly string[] | undefined
}

const NO_DESCRIPTION = '（未描述）'

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

function botLine(bot: PerceptionBot): string {
  const description = bot.description !== undefined && bot.description.trim() !== ''
    ? bot.description.trim()
    : NO_DESCRIPTION
  return `${bot.name}：${description}`
}

/**
 * Reduce a value to what this bot may perceive.
 *
 * This is the single place the group/direct rule is applied, so every consumer — the
 * system context, the delta, and any future rendering — inherits the same restriction.
 */
function project(value: PerceptionValue, selfId: string): Projection {
  const direct = value.room !== undefined && value.room.directBotId !== undefined
  const skills = value.skills === undefined
    ? undefined
    : [...new Set(value.skills)].sort()

  if (direct) {
    // DIRECT: the whole roster, minus itself — the bots this one could pull into a group.
    const roster = value.bots
      .filter(bot => bot.id !== selfId)
      .map(bot => botLine(bot))
      .sort()
    return { mode: 'direct', members: [], roster, skills }
  }

  // GROUP: resolve names ONLY for ids in `memberIds`. Anything else is not read at all,
  // so a non-member's name cannot reach the output by accident.
  const byId = new Map(value.bots.map(bot => [bot.id, bot] as const))
  const members = [...new Set(value.room?.memberIds ?? [])]
    .map(id => {
      const bot = byId.get(id)
      const name = bot === undefined ? id : bot.name
      return id === selfId ? `${name}（你）` : name
    })
    .sort()
  return { mode: 'group', members, roster: [], skills }
}

function groupRulesBlock(projected: Projection): string {
  const members = projected.members.length === 0 ? '（本群目前只有你）' : projected.members.join('、')
  return [
    '[群聊规则]',
    `房间成员：${members}`,
    '你只能感知以上成员；其他 bot 不在本群，不要提及、也不要假设其存在。',
    '若某工作更适合不在本群的 bot → 调 invite_bot 拉进来。',
    // Removal is the mirror of invite, and the model has to know it exists BEFORE it
    // starts inventing workarounds (ignoring the member, re-asking, or giving up).
    '若某个成员跑偏、重复劳动或已无必要 → 你是队长时用 remove_bot 把一个或多个成员移出本群',
    '（移出后它的运行会停止、任务回到待认领、它也不再记得本房间）。你不是队长时不要尝试。',
    '用户要求移出成员而你不是队长 → 直接说明只有队长能执行，并请用户 @队长；不要自己回答"我做不到"就结束。',
  ].join('\n')
}

function rosterBlock(projected: Projection): string {
  const lines = projected.roster.length === 0
    ? '（目前没有其他 bot）'
    : projected.roster.map(line => `· ${line}`).join('\n')
  return [
    '[可协作的 bot]',
    lines,
    '你看不到他们的任何对话内容。',
    '任务超出你能力时调 propose_group，由用户决定。',
  ].join('\n')
}

function renderDelta(previous: Projection, next: Projection): string | undefined {
  const parts: string[] = []

  if (next.mode === 'group' && (previous.mode !== 'group' || !sameList(previous.members, next.members))) {
    // Only CURRENT members are named. A member who left is not named at all — at this
    // point it is a non-member, and naming it would break the red line.
    parts.push([
      `[感知更新] 本群成员有变化。当前成员：${next.members.length === 0 ? '（本群目前只有你）' : next.members.join('、')}`,
      '提示：你只能感知以上成员；其他 bot 不在本群，不要提及、也不要假设其存在。',
    ].join('\n'))
  } else if (next.mode === 'direct' && (previous.mode !== 'direct' || !sameList(previous.roster, next.roster))) {
    const lines = next.roster.length === 0 ? '（目前没有其他 bot）' : next.roster.map(l => `· ${l}`).join('\n')
    parts.push([
      '[感知更新] 可协作的 bot 名册有变化。当前名册：',
      lines,
      '提示：你看不到他们的任何对话内容。',
    ].join('\n'))
  }

  if (!sameList(previous.skills, next.skills) && next.skills !== undefined) {
    parts.push(`[技能变更] 可用技能有变化：${next.skills.length === 0 ? '（暂无）' : next.skills.join('、')}`)
  }

  return parts.length === 0 ? undefined : parts.join('\n\n')
}

/**
 * Build the perception section for a bot's system prompt, plus its change detector.
 *
 * The detector starts from the value used here, so the first check is a no-op and the
 * opening prompt is never duplicated into the history.
 */
export function buildPerception(input: PerceptionInput): Perception {
  const initial: PerceptionValue = {
    ...(input.room !== undefined ? { room: input.room } : {}),
    bots: input.bots,
    ...(input.skills !== undefined ? { skills: input.skills } : {}),
  }
  const mode: PerceptionMode = input.room !== undefined && input.room.directBotId !== undefined
    ? 'direct'
    : 'group'
  const systemContext = mode === 'direct'
    ? rosterBlock(project(initial, input.selfId))
    : groupRulesBlock(project(initial, input.selfId))

  let current = initial
  let last = project(initial, input.selfId)

  return {
    systemContext,
    mode,
    get value(): PerceptionValue {
      return current
    },
    deltaOnChange(value: PerceptionValue): string | undefined {
      const next = project(value, input.selfId)
      const delta = renderDelta(last, next)
      current = value
      last = next
      return delta
    },
  }
}

/** One room message, as much of it as seeding needs. */
export interface SeedSourceMessage {
  readonly text: string
  /** Model-facing payload when it differs from the visible text (e.g. a `/skill` call). */
  readonly modelText?: string | undefined
  readonly sender?: {
    readonly kind?: string | undefined
    readonly botId?: string | undefined
    readonly name?: string | undefined
  } | undefined
}

export interface SeedMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export interface SeedOptions {
  /**
   * Whose session is being seeded. That bot's own messages become `assistant` turns;
   * everyone else's become `user` turns prefixed with the sender's name, so attribution
   * survives the round trip (§23.1).
   */
  readonly selfId?: string | undefined
  /** Per-message cap; a 46 KB skill dump must not swallow the whole seed. */
  readonly maxCharsPerMessage?: number | undefined
  /** Total cap, applied by dropping the OLDEST entries — recent history is what matters. */
  readonly maxTotalChars?: number | undefined
}

/**
 * Seed a freshly created bot session from the room's recent history (§23.1).
 *
 * The room ledger is permanent while the bot session is not, so without this the user sees
 * a full conversation that the bot has no memory of. Seeding happens ONLY on first
 * creation: a session rebuilt after `clearMessages` must be seeded empty, or the content
 * the user just deleted would come back.
 *
 * `limit` counts SOURCE messages (the plan's N=50), not emitted ones: consecutive turns
 * with the same role are merged, because a chat history of 50 raw messages is not a valid
 * alternating transcript for every provider.
 */
export function seedFromHistory(
  messages: readonly SeedSourceMessage[],
  limit = 50,
  options: SeedOptions = {},
): SeedMessage[] {
  const wanted = Math.max(0, Math.floor(limit))
  if (wanted === 0 || messages.length === 0) return []

  const maxChars = Math.max(1, options.maxCharsPerMessage ?? 4_000)
  const maxTotal = Math.max(1, options.maxTotalChars ?? 40_000)
  const selfId = options.selfId

  const entries: SeedMessage[] = []
  for (const message of messages) {
    const raw = message.modelText !== undefined && message.modelText.trim() !== ''
      ? message.modelText
      : message.text
    const body = raw.trim()
    // Empty turns carry nothing to remember (§11.4) and would only add noise.
    if (body === '') continue
    const text = body.length > maxChars ? `${body.slice(0, maxChars)}…（已截断）` : body
    const isSelf = selfId !== undefined && message.sender?.botId === selfId
    const name = message.sender?.name
    if (isSelf) {
      entries.push({ role: 'assistant', text })
    } else {
      entries.push({ role: 'user', text: name !== undefined && name !== '' ? `[${name}] ${text}` : text })
    }
  }

  const recent = entries.slice(Math.max(0, entries.length - wanted))

  // Merge same-role neighbours instead of inserting fake turns.
  const merged: SeedMessage[] = []
  for (const entry of recent) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.role === entry.role) {
      merged[merged.length - 1] = { role: last.role, text: `${last.text}\n\n${entry.text}` }
    } else {
      merged.push(entry)
    }
  }

  // Keep the newest content when the seed is too large: drop from the front.
  let total = merged.reduce((sum, m) => sum + m.text.length, 0)
  let start = 0
  while (start < merged.length - 1 && total > maxTotal) {
    total -= merged[start]?.text.length ?? 0
    start += 1
  }
  return merged.slice(start)
}
