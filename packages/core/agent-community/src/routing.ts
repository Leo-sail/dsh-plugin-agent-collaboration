/**
 * Who answers a group message.
 *
 * A group message is routed BY ITS CONTENT. Two wrong answers were tried before this
 * one, and both are worth naming so they are not reintroduced:
 *
 *   · EVERY member ran on every message, with no de-duplication. One "你好" started
 *     four runs; four of them started sixteen; bot replies are messages too, so the
 *     queue grew faster than it drained. The user saw a permanent 排队 banner, the same
 *     bot answering the same message twice, and everyone else stuck on 处理中….
 *   · The LEADER ONLY ran. That fixed the pile-up but made a group behave like a
 *     1:1 — ask a design question and the one member who draws nothing still answers.
 *
 * What the user asked for is the middle: read the message, decide how many bots it
 * actually concerns, and wake those. This module is that decision, kept pure so it can
 * be tested without a model, a session, or a service.
 *
 * Matching is lexical on purpose. It is instant, deterministic, and free — the router
 * runs on every message, so a model call here would add latency and cost to a path that
 * must stay cheap. Roles are short ("你是一名漫画家"), so term overlap is enough to
 * separate them; the fallback covers the case where it is not.
 */
import type { BotId } from './types.ts'

/** What the router needs to know about one candidate. */
export interface RoutableBot {
  readonly id: string
  readonly name: string
  /** Free-text role. Either field may be empty; together they are the bot's identity. */
  readonly description?: string | undefined
  readonly systemPrompt?: string | undefined
}

/** The message being routed. */
export interface RoutableMessage {
  readonly text: string
  /** Bots named with `@`. Always wins. */
  readonly mentions: readonly string[]
  /** Ids that resolved from the message's `@name` text. */
  readonly mentionedIds?: readonly string[] | undefined
}

export interface RouteInput {
  readonly members: readonly RoutableBot[]
  readonly message: RoutableMessage
  /** Direct rooms always have exactly one intended recipient. */
  readonly directBotId?: string | undefined
  /** Answers when nothing matches: somebody has to read the message. */
  readonly leaderId?: string | undefined
  /**
   * Every live bot whose NAME appears in the message, member or not.
   *
   * Members alone are not enough for a coordination request: "把 htsrgds 拉进这个群" names
   * a bot that is by definition NOT in the room yet, and without this the router saw a
   * message that mentioned nobody and fanned it out to the whole group.
   */
  readonly namedBotIds?: readonly string[] | undefined
}

export interface RouteDecision {
  /** Bots that should run, in member order. */
  readonly targets: readonly string[]
  /** Why, for the transcript and for debugging a surprising result. */
  readonly reason: 'direct' | 'mention' | 'matched' | 'coordinator' | 'general'
  /** Terms that caused each bot to be picked, for the log. */
  readonly matched: Readonly<Record<string, readonly string[]>>
}

/**
 * Terms too generic to indicate a role.
 *
 * Both Chinese and English, because a bot's role text may be written in either and a
 * match on "工程师" alone would make every technical bot answer every technical message
 * regardless of subject. These are the words that appear in almost every role sentence,
 * so they carry no routing signal.
 */
const STOP_TERMS = new Set([
  '一名', '你是', '你是a', '负责', '擅长', '专注', '帮助', '助手', '工作', '相关', '事情',
  '以及', '并且', '能够', '可以', '你的', '我们', '这个', '那个', '什么', '怎么', '一个',
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'you', 'are',
  'is', 'be', 'your', 'help', 'assist', 'expert', 'assistant', 'agent', 'bot',
])

/**
 * Domain words that mean the same thing for routing purposes.
 *
 * Lexical matching alone is too literal to be useful: a bot whose role is
 * "你是一名软件开发工程师" yields the terms 软件/开发/工程/程师, and a user asking
 * "帮我看看代码" mentions none of them — the request lands on the leader even though the
 * engineer is exactly who should answer. Bots mostly ship with an EMPTY `description`
 * (the perception block renders them as "（未描述）"), so the role sentence is the only
 * signal there is and it has to be stretched a little.
 *
 * Deliberately small and hand-written. Each entry is a domain a small team plausibly
 * splits along; growing it is a judgement call, not a place for a thesaurus.
 */
const SYNONYMS: readonly (readonly string[])[] = [
  ['软件', '开发', '工程', '程序', '代码', '编程', '接口', '接口', 'bug', '调试', '重构', '架构', 'api', '函数', '报错'],
  ['漫画', '绘画', '插画', '画', '角色', '分镜', '美术'],
  ['设计', '视觉', '品牌', '配色', '排版', '字体', 'ui', 'ux', 'banner', '海报', '风格'],
  ['测试', '验收', '质量', '回归', '用例'],
  ['文档', '写作', '说明', '文案', '教程'],
  ['数据', '分析', '统计', '指标', '报表'],
  ['运营', '增长', '推广', '市场'],
]

/**
 * Expand a role term into the domain words it stands for.
 *
 * If the term belongs to a domain group, every word in that group becomes a candidate
 * term — so "工程师" also matches a message that says "代码".
 */
function expand(term: string): string[] {
  const lower = term.toLowerCase()
  for (const group of SYNONYMS) {
    if (group.some(word => term.includes(word) || lower.includes(word))) return [...group]
  }
  return [term]
}

/** Split role text into candidate terms. CJK has no spaces, so length is the filter. */
function termsOf(text: string | undefined): string[] {
  if (text === undefined || text === '') return []
  const out: string[] = []
  // Split on anything that is not a letter or a CJK character, then keep terms long
  // enough to be meaningful: a 1-character term matches almost any Chinese sentence.
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    const term = raw.trim()
    if (term.length < 2) continue
    if (STOP_TERMS.has(term.toLowerCase())) continue
    out.push(term)
    // A long role sentence would otherwise match on incidental phrases. Bi-grams of a
    // CJK run are what actually carry the subject ("漫画家" also matches "漫画").
    if (term.length >= 4 && /^[\p{Script=Han}]+$/u.test(term)) {
      for (let i = 0; i + 2 <= term.length; i += 2) {
        const bigram = term.slice(i, i + 2)
        if (!STOP_TERMS.has(bigram)) out.push(bigram)
      }
    }
    // Domain expansion: this is what lets "看代码" reach a 软件开发工程师.
    for (const word of expand(term)) out.push(word)
  }
  return [...new Set(out)]
}

/**
 * The message's searchable form.
 *
 * Lower-cased and stripped of punctuation so a term split out of a role cannot fail to
 * match only because the message punctuated it.
 */
function haystackOf(text: string): string {
  return text.toLowerCase()
}

/**
 * Decide who answers.
 *
 * Order of precedence, each step existing because the one below it is worse for that
 * case:
 *   1. `@mention` — an explicit directive outranks any inference.
 *   2. direct room — exactly one intended recipient by construction.
 *   3. role match — the content names a subject some bots own.
 *   4. leader — nothing matched, but a message with no answer at all is a bug.
 */
export function routeMessage(input: RouteInput): RouteDecision {
  const byId = new Map(input.members.map(m => [m.id, m]))

  // 1. Explicit mentions. Only members can be mentioned into running.
  const mentioned = (input.message.mentionedIds ?? [])
    .filter(id => byId.has(id))
  if (mentioned.length > 0) {
    return { targets: mentioned, reason: 'mention', matched: {} }
  }
  // A mention that resolved to nobody is not a directive to stay silent — it usually
  // means the name was mis-typed or the bot has since left. Fall through so the message
  // is still routed on its content rather than being answered by no one.

  // 2. A direct room has exactly one bot by construction.
  if (input.directBotId !== undefined) {
    return {
      targets: byId.has(input.directBotId) ? [input.directBotId] : [],
      reason: 'direct',
      matched: {},
    }
  }

  // 2.5 An instruction that ACTS ON a member belongs to whoever can execute it.
  //
  // This is the difference between talking TO somebody and doing something ABOUT them.
  // "把 htsrgds 从这个群里踢出去" names htsrgds, so content routing woke htsrgds — which
  // cannot remove anybody: `remove_bot` is leader-only, so the one bot guaranteed to be
  // unable to comply was the one that answered, and the leader never ran. Measured on the
  // real host: the target replied "我做不到", then the user had to @ the leader by hand.
  //
  // The rule is deliberately narrow: a removal verb AND a member's name, in a
  // leader-driven room, with no explicit `@`. A coding request that merely contains the
  // word ("移除这个字段") names no member and keeps normal content routing.
  const hay = haystackOf(input.message.text)
  const act = managementIntent(hay)
  if (act !== undefined) {
    const named = new Set<string>([
      ...membersNamedForRemoval(hay, input.members),
      ...(input.namedBotIds ?? []),
    ])
    if (named.size > 0) {
      if (input.leaderId !== undefined && byId.has(input.leaderId)) {
        return {
          targets: [input.leaderId],
          reason: 'coordinator',
          matched: { [input.leaderId]: [`${act} request: the coordinator acts`] },
        }
      }
      // No leader. Exactly ONE member answers — the room's first in join order, which is
      // the same member leadership would be handed to — and never the bot being acted on.
      // Waking everyone here is how "把 htsrgds 拉进这个群" got four replies.
      const candidate = input.members.find(m => !named.has(m.id))
      if (candidate !== undefined) {
        return {
          targets: [candidate.id],
          reason: 'coordinator',
          matched: { [candidate.id]: [`${act} request, no leader: first member acts`] },
        }
      }
    }
  }

  // 3. Role match: every member whose own terms appear in the message.
  const matched: Record<string, readonly string[]> = {}
  const targets: string[] = []
  for (const member of input.members) {
    const terms = [
      ...termsOf(member.description),
      ...termsOf(member.systemPrompt),
      // The name is part of a bot's identity in practice: "让 fgchb 看一下" addresses it
      // without the `@`, and dropping that would make the router ignore a direct ask.
      ...termsOf(member.name),
    ]
    const hits = terms.filter(term => hay.includes(term.toLowerCase()))
    if (hits.length === 0) continue
    targets.push(member.id)
    matched[member.id] = hits
  }
  if (targets.length > 0) return { targets, reason: 'matched', matched }

  // 4. Nothing matched — the message is GENERAL, so it concerns everyone.
  //
  // "你好" is the case that settled this. Routing it to one bot made a four-member group
  // answer a greeting once, which reads as broken: a greeting is addressed to the room,
  // not to a role. A message that names no subject and no one is by definition for all of
  // them, so all of them answer — that IS the content-based decision, not a fallback
  // away from one.
  //
  // This is only safe because bot messages no longer fan out (`postBotMessage` starts a
  // run solely for an explicitly addressed bot). Fanning out here fans out ONCE per user
  // message; the pile-up came from replies triggering replies, which is fixed.
  return {
    targets: input.members.map(m => m.id),
    reason: 'general',
    matched: {},
  }
}

/** A human-readable sentence for the transcript, or undefined when it adds nothing. */
export function describeRoute(decision: RouteDecision, nameOf: (id: BotId | string) => string): string | undefined {
  if (decision.reason !== 'matched' || decision.targets.length === 0) return undefined
  const who = decision.targets.map(id => nameOf(id)).join('、')
  const why = Object.entries(decision.matched)
    .flatMap(([, hits]) => hits)
    .slice(0, 4)
    .join('、')
  return why === '' ? `由 ${who} 回复` : `由 ${who} 回复（匹配到：${why}）`
}

/**
 * What kind of room management a message asks for, or undefined when it asks for none.
 *
 * Both families are COORDINATION: one instruction, one action. Letting them fall through
 * to content/general routing produced two opposite failures on the live host — a removal
 * answered by the bot being removed, and an invite answered by the whole group.
 */
function managementIntent(hay: string): 'remove' | 'invite' | undefined {
  if (REMOVAL_VERBS.some(verb => hay.includes(verb.toLowerCase()))) return 'remove'
  if (INVITE_VERBS.some(verb => hay.includes(verb.toLowerCase()))) return 'invite'
  // English splits the verb from its object — "add outsider to the group", "remove
  // outsider from the group" — so the phrase is matched as verb + room word instead of a
  // contiguous string. The named-bot requirement keeps this narrow.
  const mentionsRoom = /\b(group|room|chat)\b/.test(hay)
  if (mentionsRoom && /\b(add|invite)\b/.test(hay)) return 'invite'
  if (mentionsRoom && /\b(kick|remove|drop)\b/.test(hay)) return 'remove'
  return undefined
}

/**
 * Verbs that ask for a bot to be brought INTO the room.
 *
 * Like removal, the named bot is the OBJECT of the action — and for an invite it is not
 * even a member, so naming it can never be a way of addressing it.
 */
const INVITE_VERBS: readonly string[] = [
  '拉进', '拉入', '拉进来', '加进', '加入群', '加进群', '邀请', '招进', '拉他', '拉她',
  'invite', 'add to the group', 'add into the group',
]

/**
 * Verbs that ask for a member to be taken OUT of the room.
 *
 * A removal is the one instruction whose grammatical object cannot be its executor:
 * `remove_bot` is leader-only, so naming the target must not be read as addressing it.
 * Kept as a small, explicit list — a broad "management" vocabulary would swallow
 * ordinary requests such as "让 fgchb 看一下".
 */
const REMOVAL_VERBS: readonly string[] = [
  '踢', '移出', '移除群', '移出群', '赶出', '清出', '开除', '不要他了', '别让他',
  'kick', 'remove from the group', 'remove from this group', 'drop from the group',
]

/**
 * The members a removal instruction names, or an empty list when this is not one.
 *
 * Both halves are required: the verb alone is ordinary prose ("移除这个字段"), and a name
 * alone is an ordinary request that the named bot can answer. Returns the ids so the
 * caller can route to the leader — or, with no leader, to everybody EXCEPT them.
 */
function membersNamedForRemoval(hay: string, members: readonly RoutableBot[]): string[] {
  const asksForRemoval = REMOVAL_VERBS.some(verb => hay.includes(verb.toLowerCase()))
  if (!asksForRemoval) return []
  return members
    .filter(member => termsOf(member.name).some(term => term !== '' && hay.includes(term.toLowerCase())))
    .map(member => member.id)
}

/**
 * Every live bot whose name or id appears in the message.
 *
 * Used to fill `RouteInput.namedBotIds`: a coordination request can name a bot that is not
 * in the room (an invite), so membership cannot be the filter. Names shorter than two
 * characters are ignored — the same rule the content matcher uses, because a one-character
 * name matches almost any Chinese sentence.
 */
export function namedBotIdsIn(
  text: string,
  bots: readonly { readonly id: string; readonly name: string }[],
): string[] {
  const hay = haystackOf(text)
  if (hay === '') return []
  const out: string[] = []
  for (const bot of bots) {
    const terms = [...termsOf(bot.name), bot.id.toLowerCase()]
    if (terms.some(term => term !== '' && hay.includes(term.toLowerCase()))) out.push(bot.id)
  }
  return out
}
