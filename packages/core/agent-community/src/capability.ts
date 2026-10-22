/**
 * Capability cards + candidate ranking for group proposals.
 *
 * WHY THIS EXISTS
 * `GroupFlowService.consultModel` used to hand the model a roster of `名称 + description 前 120
 * 字` and a single question: "does this need collaboration?". The model was then free to pick
 * ANY bot, and nothing checked the pick against the task. The user's report was exactly that:
 * a direct-chat bot proposed a group, and the bots it pulled in did not fit the job.
 *
 * This module is the deterministic half of the fix, kept pure so it is testable without a
 * model or a host:
 *
 *   · `buildCapabilityCard` — turn a bot's own text (description, systemPrompt sections,
 *     skill profile) into a small structured card: domains / deliverables / skills /
 *     boundaries. No model, no I/O, capped at 20 tags.
 *   · `rankCandidates` — score every card against the TASK text with mixed CJK/English term
 *     matching: skills weigh most (3), description and domains 2, boundaries 0.5 (a boundary
 *     match is a weak signal — "I don't do X" still says the bot knows the domain).
 *   · `shortlistFor` — the source bot (the one the user is already talking to) is always on
 *     the shortlist; the rest are the top-ranked candidates. The model then chooses INSIDE
 *     this list, and `sanitizeCollaborateSelection` refuses anything outside it.
 *
 * Everything here is deterministic: the same task and cards always produce the same ranking,
 * so a proposal can be explained ("why was this bot picked?") and a model failure can fall
 * back to a defensible answer instead of a guess.
 *
 * @module
 */

/** A bot's capability profile, as derived from its own text — no model involved. */
export interface CapabilityCard {
  readonly botId: string
  readonly name: string
  /** The bot's role sentence (first 400 chars kept for the roster line). */
  readonly description: string
  /** What the bot works on: role clauses and non-generic section headings. */
  readonly domains: readonly string[]
  /** What the bot produces: 产出/交付/输出 lines. */
  readonly deliverables: readonly string[]
  /** Skill names from the bot's skill profile (the strongest match signal). */
  readonly skills: readonly string[]
  /** What the bot explicitly does not do: 边界/不做/不是你 lines. */
  readonly boundaries: readonly string[]
}

/** The subset of `BotIdentity` this module reads. */
export interface CapabilityBotInput {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  readonly systemPrompt?: string | undefined
  readonly skillProfile?: { readonly names: readonly string[] } | undefined
}

/** One scored candidate. `matched` is the task terms that hit the card (task order). */
export interface RankedCandidate {
  readonly botId: string
  readonly score: number
  readonly matched: readonly string[]
}

/** How many bots one proposal may put in front of the model. */
export const DEFAULT_SHORTLIST_SIZE = 4
/** A proposal needs at least two participants — the same floor `propose` enforces. */
export const MIN_PROPOSED_MEMBERS = 2
/** Tags per card are bounded so the roster line stays readable (and the prompt short). */
const MAX_DOMAINS = 8
const MAX_SKILLS = 6
const MAX_DELIVERABLES = 3
const MAX_BOUNDARIES = 3
const MAX_TAG_LENGTH = 18

/** Headings that say nothing about capability — they would match every task equally. */
const GENERIC_TAGS = new Set([
  '职责', '岗位职责', '身份', '角色', '边界', '边界与失败', '流程', '工作流程', '工作方式',
  '注意', '注意事项', '技能', '输出', '产出', '交付', '能力', '协作', '记忆', '工具', '目标',
  '一句话', '首次启动自检', '说明', '建议', '原则', '规则', '工作区', '协作方式',
])

const BOUNDARY_HEADING = /边界|不做|禁止|不是|红线|限制/u
const DELIVERABLE_HEADING = /产出|交付|输出|作品/u
const BOUNDARY_LINE = /你不是|不要|禁止|不得|不碰|不做|别做|只能|红线/u
const DELIVERABLE_LINE = /产出|交付|输出|作品|文件路径/u
/** A clause that opens with one of these reads as a scope boundary, not a capability. */
const BOUNDARY_PREFIX = /^(?:不|别|禁止|不得|只能)/u
/** Leading verbs/adverbs that make a clause read like a sentence instead of a capability. */
const PREAMBLE = /^(?:只做|只判断|只出|只拆|只写|只看|只给|负责|擅长|专注|帮助|协助|为你|为一人公司|把|将|读|写|做|会|能|持续|产出|交付|输出|自动)/u
/** Splits free text into capability-sized clauses (both languages' punctuation). */
const CLAUSE_SPLIT = /[，。；;、|/·\n：:+&]+/u

/** Clean one raw clause into a tag, or `''` when it is not usable. */
function cleanClause(raw: string, options: { readonly dropPreamble?: boolean } = {}): string {
  let clause = raw.replace(/\s+/gu, ' ').trim()
  // Markdown list markers and emphasis are noise inside a tag.
  clause = clause.replace(/^[#>*+\-\d.、\s]+/u, '').replace(/^[「『【[]|[」』】\]]$/gu, '').trim()
  if (options.dropPreamble !== false) clause = clause.replace(PREAMBLE, '').trim()
  // A trailing parenthetical is usually an aside, not the capability.
  clause = clause.replace(/（[^）]*）$/u, '').trim()
  if (clause.length < 2 || clause.length > MAX_TAG_LENGTH) return ''
  if (GENERIC_TAGS.has(clause)) return ''
  return clause
}

/** Cleaned clauses of a free-text field. */
function clausesOf(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(CLAUSE_SPLIT)) {
    const clause = cleanClause(raw)
    if (clause !== '') out.push(clause)
  }
  return out
}

/** Deduplicate while keeping the first (deterministic) occurrence. */
function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (item === '' || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** What the sections of a bot's system prompt say about capability. */
function readSystemPrompt(prompt: string): {
  readonly headings: readonly string[]
  readonly boundaries: readonly string[]
  readonly deliverables: readonly string[]
} {
  const headings: string[] = []
  const boundaries: string[] = []
  const deliverables: string[] = []
  let section: 'other' | 'boundaries' | 'deliverables' = 'other'
  for (const raw of prompt.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '') continue
    const heading = /^#{1,6}\s+(.+)$/u.exec(line)
    if (heading !== null) {
      const text = (heading[1] ?? '').replace(/\s+/gu, ' ').trim()
      if (text !== '') headings.push(text)
      section = BOUNDARY_HEADING.test(text) ? 'boundaries'
        : DELIVERABLE_HEADING.test(text) ? 'deliverables'
          : 'other'
      continue
    }
    const content = line.replace(/^[-*+>]\s*/u, '')
    if (BOUNDARY_LINE.test(content) || section === 'boundaries') boundaries.push(...clausesOf(content))
    else if (DELIVERABLE_LINE.test(content) || section === 'deliverables') deliverables.push(...clausesOf(content))
  }
  return { headings, boundaries, deliverables }
}

/** How a description clause should be classified: a capability, an output or a boundary. */
function classifyDescriptionClause(raw: string): 'domain' | 'deliverable' | 'boundary' {
  const trimmed = raw.trim()
  if (BOUNDARY_PREFIX.test(trimmed) || BOUNDARY_LINE.test(trimmed)) return 'boundary'
  if (DELIVERABLE_LINE.test(trimmed)) return 'deliverable'
  return 'domain'
}

/**
 * Turn one bot into a capability card.
 *
 * Deterministic by construction: every field is extracted with the same ordered rules, and the
 * caps are applied after dedupe, so two calls with the same input always agree.
 */
export function buildCapabilityCard(bot: CapabilityBotInput): CapabilityCard {
  const description = (bot.description ?? '').replace(/\s+/gu, ' ').trim()
  const skills = dedupe(
    (bot.skillProfile?.names ?? [])
      .map(name => name.replace(/\s+/gu, ' ').trim())
      .filter(name => name.length >= 2),
  ).slice(0, MAX_SKILLS)
  const { headings, boundaries, deliverables } = readSystemPrompt(bot.systemPrompt ?? '')

  const domains: string[] = []
  const outputs: string[] = [...deliverables]
  const limits: string[] = [...boundaries]
  for (const raw of description.split(CLAUSE_SPLIT)) {
    const clause = cleanClause(raw)
    if (clause === '') continue
    switch (classifyDescriptionClause(raw)) {
      case 'boundary': limits.push(clause); break
      case 'deliverable': outputs.push(clause); break
      default: domains.push(clause)
    }
  }
  for (const heading of headings) {
    const tag = cleanClause(heading, { dropPreamble: false })
    if (tag !== '') domains.push(tag)
  }
  return {
    botId: bot.id,
    name: bot.name,
    description: description.slice(0, 400),
    domains: dedupe(domains).slice(0, MAX_DOMAINS),
    deliverables: dedupe(outputs).slice(0, MAX_DELIVERABLES),
    skills,
    boundaries: dedupe(limits).slice(0, MAX_BOUNDARIES),
  }
}

/**
 * Terms too generic to tell bots apart.
 *
 * This is the lesson of the measured duplicate: two bots whose prompts both contained 「确认」
 * tied, and the tie woke both. A term that appears in half the team's prompts, or in every
 * user sentence, carries no routing signal — including it produces ties, not matches.
 */
const CJK_STOP_TERMS = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '一个', '一下', '一些', '这些', '那些',
  '帮我', '你看', '需要', '要求', '现在', '已经', '然后', '就是', '不是', '没有', '可以', '应该',
  '以及', '还有', '但是', '因为', '所以', '如果', '或者', '进行', '通过', '使用', '相关', '方面',
  '内容', '东西', '事情', '问题', '任务', '工作', '时候', '地方', '如何', '是否', '确认', '允许',
  '收到', '好的', '谢谢', '辛苦', '请帮', '帮忙', '有没有', '今天', '明天', '昨天', '一份', '一点',
  '看看', '看一', '这的', '的时', '要的', '的任', '时我', '把这', '里的', '再看', '再做', '一张',
  '给我', '来看', '下这', '写一', '查一', '天的', '的报',
])

const ENGLISH_STOP_TERMS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be',
  'you', 'your', 'help', 'please', 'me', 'my', 'we', 'it', 'this', 'that', 'do', 'can',
  'could', 'would', 'should', 'will', 'need', 'want', 'make', 'write', 'read', 'use', 'some',
  'any', 'all', 'from', 'about', 'into', 'they', 'them', 'their', 'our', 'us',
])

/**
 * Function characters that make a CJK bi-gram noise on either end.
 *
 * "把(这)个链接" yields bi-grams like 「把这」「个链」「接里」「的内」: a window that starts or
 * ends on a particle is a fragment of a phrase, not a term, and it can only create accidental
 * matches.
 */
const EDGE_NOISE = new Set([
  '的', '了', '着', '过', '也', '都', '很', '就', '还', '再', '把', '被', '让', '给', '对',
  '从', '向', '于', '而', '则', '吗', '呢', '吧', '啊', '呀', '嘛', '哦', '么', '哈', '和',
  '与', '及', '或', '者', '这', '那', '我', '你', '他', '她', '它', '们',
])

/**
 * The task's searchable terms: English words and CJK bi-grams, lower-cased and deduped.
 *
 * Bi-grams are the CJK unit because there are no word boundaries: a two-character window is
 * what carries the subject ("拆解", "封面") while longer phrases depend on punctuation.
 */
export function taskTerms(text: string, extraStopTerms: readonly string[] = []): string[] {
  const extra = extraStopTerms.map(term => term.toLowerCase())
  const out: string[] = []
  const seen = new Set<string>()
  const push = (term: string): void => {
    const normalized = term.toLowerCase()
    if (normalized.length < 2 || seen.has(normalized) || CJK_STOP_TERMS.has(normalized)
      || ENGLISH_STOP_TERMS.has(normalized) || extra.includes(normalized)) return
    seen.add(normalized)
    out.push(normalized)
  }
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_+.-]*/gu)) push(match[0])
  for (const match of text.matchAll(/[\p{Script=Han}]+/gu)) {
    const run = match[0]
    for (let i = 0; i + 2 <= run.length; i++) {
      const bigram = run.slice(i, i + 2)
      if (EDGE_NOISE.has(bigram[0]!) || EDGE_NOISE.has(bigram[1]!)) continue
      push(bigram)
    }
  }
  return out
}

/** One field of a card and how much a hit in it is worth. */
const SCORED_FIELDS = [
  { weight: 3, text: (card: CapabilityCard) => card.skills.join(' ') },
  { weight: 2, text: (card: CapabilityCard) => card.description },
  { weight: 2, text: (card: CapabilityCard) => card.domains.join(' ') },
  { weight: 0.5, text: (card: CapabilityCard) => card.boundaries.join(' ') },
] as const

export interface RankOptions {
  /** Extra terms to ignore (tests and call sites with their own vocabulary). */
  readonly extraStopTerms?: readonly string[] | undefined
}

/**
 * Score every card against the task, best first.
 *
 * A term counts once per card FIELD CATEGORY (skills 3, description 2, domains 2, boundaries
 * 0.5), so a bot whose skill names literally contain the task's words outranks one that only
 * mentions the domain in prose. Ties are broken by name (then id), never by array order: the
 * ordering is part of the deterministic explanation.
 */
export function rankCandidates(
  taskText: string,
  cards: readonly CapabilityCard[],
  options: RankOptions = {},
): RankedCandidate[] {
  const terms = taskTerms(taskText, options.extraStopTerms ?? [])
  const byId = new Map(cards.map(card => [card.botId, card]))
  const ranked = cards.map((card): RankedCandidate => {
    const fields = SCORED_FIELDS.map(field => ({ weight: field.weight, text: field.text(card) }))
    let score = 0
    const matched: string[] = []
    for (const term of terms) {
      let hit = false
      for (const field of fields) {
        if (field.text === '') continue
        if (field.text.toLowerCase().includes(term)) {
          score += field.weight
          hit = true
        }
      }
      if (hit) matched.push(term)
    }
    return { botId: card.botId, score, matched }
  })
  return ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    const leftName = byId.get(left.botId)?.name ?? left.botId
    const rightName = byId.get(right.botId)?.name ?? right.botId
    if (leftName !== rightName) return leftName < rightName ? -1 : 1
    return left.botId < right.botId ? -1 : left.botId > right.botId ? 1 : 0
  })
}

/**
 * The candidates one proposal may consider: the source bot first, then the best matches.
 *
 * The source bot must be on the list — it is the bot the user is already talking to, and the
 * one holding the first-hand context. When it is not in `cards` (deleted between the read and
 * here) the list is simply the top-ranked candidates.
 */
export function shortlistFor(
  taskText: string,
  cards: readonly CapabilityCard[],
  sourceBotId: string | undefined,
  max: number = DEFAULT_SHORTLIST_SIZE,
): RankedCandidate[] {
  const limit = Math.max(1, Math.floor(max))
  const ranked = rankCandidates(taskText, cards)
  if (ranked.length === 0) return []
  const source = ranked.find(candidate => candidate.botId === sourceBotId)
  const picked: RankedCandidate[] = []
  if (source !== undefined) picked.push(source)
  for (const candidate of ranked) {
    if (picked.length >= limit) break
    if (candidate.botId === sourceBotId) continue
    picked.push(candidate)
  }
  return picked.slice(0, limit)
}

/** The one coherent selection a proposal is allowed to produce. */
export interface CollaborateSelection {
  readonly members: readonly string[]
  readonly leaderId: string
}

/**
 * The leader rule, in one place: a proposed leader that is a member, else the first fallback
 * that is (the source bot on a proposal, the model's pick on a confirm), else the first member.
 */
export function chooseValidLeader(input: {
  readonly leaderId?: string | undefined
  readonly fallbackLeaderId?: string | undefined
  readonly sourceBotId?: string | undefined
  readonly members: readonly string[]
}): string | undefined {
  for (const candidate of [input.leaderId, input.fallbackLeaderId, input.sourceBotId]) {
    if (candidate !== undefined && input.members.includes(candidate)) return candidate
  }
  return input.members[0]
}

/**
 * Accept a model's selection only if it stays inside the shortlist.
 *
 * Members outside `allowedIds` are dropped (they were never offered), the list is deduped and
 * capped, and the leader is forced to be a member. Fewer than two surviving members is not a
 * group — the caller falls back to the deterministic list.
 */
export function sanitizeCollaborateSelection(
  input: { readonly members: readonly string[]; readonly leaderId?: string | undefined },
  allowedIds: readonly string[],
  sourceBotId: string | undefined,
  max: number = DEFAULT_SHORTLIST_SIZE,
): CollaborateSelection | undefined {
  const allowed = new Set(allowedIds)
  const members: string[] = []
  const limit = Math.max(1, Math.floor(max))
  for (const member of input.members) {
    if (!allowed.has(member) || members.includes(member)) continue
    members.push(member)
    if (members.length >= limit) break
  }
  if (members.length < MIN_PROPOSED_MEMBERS) return undefined
  const leaderId = chooseValidLeader({
    ...(input.leaderId !== undefined ? { leaderId: input.leaderId } : {}),
    sourceBotId,
    members,
  })
  if (leaderId === undefined) return undefined
  return { members, leaderId }
}

/**
 * Deterministic fallback when the model could not be asked or answered outside the shortlist.
 *
 * Two to three of the shortlist, source bot included (the shortlist already put it first), and
 * the source bot as leader when it is a member. This is strictly better than no proposal: the
 * candidates are ranked by fit and the user still confirms before anything runs.
 */
export function fallbackSelection(
  shortlist: readonly RankedCandidate[],
  sourceBotId: string | undefined,
): CollaborateSelection | undefined {
  const members = shortlist.slice(0, 3).map(candidate => candidate.botId)
  if (members.length < MIN_PROPOSED_MEMBERS) return undefined
  const leaderId = chooseValidLeader({
    ...(sourceBotId !== undefined ? { sourceBotId } : {}),
    members,
  })
  if (leaderId === undefined) return undefined
  return { members, leaderId }
}
