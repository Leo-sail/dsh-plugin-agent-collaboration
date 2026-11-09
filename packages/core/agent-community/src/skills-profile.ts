/**
 * Skill freshness and per-bot skill profiles (§5.3).
 *
 * Two signature layers, because two different things change independently:
 *
 *   1. the room's skill SET  — a SKILL.md added, removed or edited on disk
 *   2. the bot's PROFILE     — which of those skills fit this bot's identity
 *
 * Both layers use "serve the old value, refresh in the background": the prompt
 * builder runs inside a model turn, and a stale name list is always better than a
 * turn that waits on a filesystem walk. A refresh that fails falls back to the full
 * skill set, which is the always-correct answer.
 *
 * The analysis call goes through `ctx.llm.stream()` directly and never through a
 * DSH session (§24.4): a profile is a stateless one-shot judgement, and giving each
 * (bot, skill set) its own session would add sessions to the LRU and to disk for
 * history nobody will ever read.
 *
 * The previous implementation kept `skillCache` forever — nothing ever deleted or
 * invalidated an entry, so a skill added to the workspace stayed invisible until
 * DSH restarted and a deleted one stayed in the prompt indefinitely.
 */

import { createHash } from 'node:crypto'
import type { BotSkillProfile } from './types.ts'

/** One discovered skill, as the prompt builder and the composer menu consume it. */
export interface SkillEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly path: string
}

/** File facts that make a skill set's signature change when the file changes. */
export interface SkillStat {
  readonly name: string
  readonly mtimeMs: number
  readonly size: number
}

/**
 * How long a scanned skill set is trusted before a background re-scan starts.
 * Short enough that a skill dropped into the workspace shows up within one or two
 * turns, long enough that a busy room is not walking the filesystem every round.
 */
export const SKILL_TTL_MS = 5_000

/** Budget for one analysis call; a profile is optional, so it must not hang a turn. */
export const ANALYSIS_TIMEOUT_MS = 30_000

/** How many skills an analysis may pre-select. */
const MAX_PROFILE_NAMES = 8

/** Skill descriptions are truncated in the analysis prompt to bound its size. */
const ANALYSIS_DESCRIPTION_CHARS = 120

/** Stable hash for signature comparisons; collisions are not a security concern. */
export function signatureOf(parts: readonly string[]): string {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

/**
 * Signature of a skill set: sorted (name, mtimeMs, size).
 *
 * mtime is what catches an edit that keeps the file size; size catches the same
 * byte count written with a different mtime granularity. Both are needed because
 * neither alone sees every change.
 */
export function skillSetSignature(stats: readonly SkillStat[]): string {
  const rows = [...stats]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(s => `${s.name}:${Math.trunc(s.mtimeMs)}:${s.size}`)
  return signatureOf(rows)
}

/**
 * Signature of a bot's profile: its identity text plus the skill set it was chosen
 * against. Editing the bot's description invalidates its own profile without any
 * call site having to remember to invalidate it.
 */
export function profileSignature(
  bot: { readonly description?: string | undefined; readonly systemPrompt?: string | undefined },
  roomSignature: string,
): string {
  return signatureOf([bot.description ?? '', bot.systemPrompt ?? '', roomSignature])
}

export interface LlmChunk {
  readonly type: string
  readonly text?: string | undefined
  readonly reason?: { readonly kind?: string | undefined; readonly failure?: { readonly code?: string | undefined; readonly message?: string | undefined } | undefined } | undefined
}

/**
 * One content block of a direct model request.
 *
 * THE WIRE SHAPE IS BLOCKS, NOT A STRING. This was declared as `content: string` and every
 * caller duly passed a string — but the host's `GenerateOptions` takes `RequestMessage[]`
 * whose `content` is `ContentBlock[]`. A bare string makes the adapter throw while
 * projecting the request, and the stream surfaces that as a bare
 * "(TRANSPORT) DeepSeek Messages transport failed" with no cause, which reads like a
 * network problem and is why this stayed undiagnosed.
 *
 * Observed: the room compactor hit it four times while being written; fixing the shape in
 * its own module made summaries work. Every other direct caller (group proposals via
 * `group-flow`, skill profiles here) was still sending strings and was therefore dead on
 * this build — they all go through this type, so correcting it here fixes them together.
 */
export interface LlmContentBlock {
  readonly type: 'text'
  readonly text: string
}

export interface LlmStreamRequest {
  readonly provider: string
  readonly model: string
  readonly system?: string | undefined
  readonly messages: readonly {
    readonly role: string
    readonly content: readonly LlmContentBlock[]
  }[]
  readonly signal?: AbortSignal | undefined
  /** Native prompt assembly wants a session id even when there is no session. */
  readonly sessionId?: string | undefined
  /** Names the call in host logs, so a stray request is attributable. */
  readonly purpose?: string | undefined
  readonly maxTokens?: number | undefined
}

/** One direct, session-less model call: the plugin's only sanctioned LLM path. */
export type LlmStream = (request: LlmStreamRequest) => AsyncIterable<LlmChunk>

export interface SkillLifecycleDeps {
  /** Full discovery for a room (registry + workspace scan). */
  scan(roomId: string): Promise<readonly SkillEntry[]>
  /** File facts for a discovered skill; undefined for registry (`skill://`) entries. */
  statFile(path: string): Promise<{ readonly mtimeMs: number; readonly size: number } | undefined>
  getBot(botId: string): { readonly description?: string | undefined; readonly systemPrompt?: string | undefined; readonly provider?: string | undefined; readonly model?: string | undefined; readonly name?: string | undefined; readonly skillProfile?: BotSkillProfile | undefined } | undefined
  /** Persist an analysed profile onto the bot. */
  saveProfile(botId: string, profile: BotSkillProfile): void
  /** The direct LLM path; absent when the runtime has no `llm` service. */
  stream(): LlmStream | undefined
  logger?: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void } | undefined
  ttlMs?: number
  now?(): number
}

/** A cached scan, plus the signature the cache is valid for. */
interface SkillCacheEntry {
  readonly skills: readonly SkillEntry[]
  readonly scannedAt: number
  readonly signature: string
}

export class SkillLifecycle {
  private readonly deps: SkillLifecycleDeps
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, SkillCacheEntry>()
  /** Scans in flight, so a hot prompt loop cannot start one walk per round. */
  private readonly scanning = new Map<string, Promise<void>>()
  /** Analyses in flight, keyed by the signature they were started for. */
  private readonly analysing = new Set<string>()

  constructor(deps: SkillLifecycleDeps) {
    this.deps = deps
    this.ttlMs = deps.ttlMs ?? SKILL_TTL_MS
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * The room's skills, synchronously, for the prompt builder.
   *
   * Never blocks: a missing or expired entry returns what is known now and starts a
   * background scan whose result the NEXT turn will see.
   */
  skillsFor(roomId: string): readonly SkillEntry[] {
    const entry = this.cache.get(roomId)
    if (entry === undefined) {
      this.cache.set(roomId, { skills: [], scannedAt: 0, signature: '' })
      this.rescan(roomId)
      return []
    }
    if (this.now() - entry.scannedAt > this.ttlMs) this.rescan(roomId)
    return entry.skills
  }

  /** Store a completed scan and its signature. Called by the async discovery path. */
  async record(roomId: string, skills: readonly SkillEntry[]): Promise<readonly SkillEntry[]> {
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name))
    const stats: SkillStat[] = []
    for (const skill of sorted) {
      // Registry skills have no file to stat; their name is their identity.
      const stat = skill.path.startsWith('skill://')
        ? { mtimeMs: 0, size: 0 }
        : await this.deps.statFile(skill.path).catch(() => undefined)
      stats.push({ name: skill.name, mtimeMs: stat?.mtimeMs ?? 0, size: stat?.size ?? 0 })
    }
    this.cache.set(roomId, {
      skills: sorted,
      scannedAt: this.now(),
      signature: skillSetSignature(stats),
    })
    return sorted
  }

  /** Signature of the room's current skill set, or undefined before the first scan. */
  signatureOf(roomId: string): string | undefined {
    const entry = this.cache.get(roomId)
    return entry === undefined || entry.signature === '' ? undefined : entry.signature
  }

  /** Drop cached skill sets; `roomId` omitted clears every room. */
  invalidate(roomId?: string): void {
    if (roomId === undefined) this.cache.clear()
    else this.cache.delete(roomId)
  }

  /** Start a background re-scan; returns immediately. */
  rescan(roomId: string): void {
    if (this.scanning.has(roomId)) return
    const task = this.deps.scan(roomId)
      .then(skills => this.record(roomId, skills))
      .then(() => undefined)
      .catch((error: unknown) => {
        // A failed scan keeps the previous names: the room's skills did not
        // disappear just because the filesystem hiccuped.
        this.deps.logger?.warn?.(`agent-community: skill rescan failed for room ${roomId}: ${String(error)}`)
      })
      .finally(() => { this.scanning.delete(roomId) })
    this.scanning.set(roomId, task)
  }

  /** Await any in-flight scan for a room (used by startup warm-up and tests). */
  async settled(roomId?: string): Promise<void> {
    if (roomId !== undefined) {
      await this.scanning.get(roomId)?.catch(() => undefined)
      return
    }
    await Promise.all([...this.scanning.values()].map(p => p.catch(() => undefined)))
  }

  /** The profile whose signature still matches this bot + skill set, if any. */
  matchingProfile(roomId: string, botId: string): BotSkillProfile | undefined {
    const roomSignature = this.signatureOf(roomId)
    if (roomSignature === undefined) return undefined
    const bot = this.deps.getBot(botId)
    const profile = bot?.skillProfile
    if (profile === undefined) return undefined
    return profile.signature === profileSignature(bot ?? {}, roomSignature) ? profile : undefined
  }

  /**
   * The skill names this bot should prefer.
   *
   * Signature mismatch serves the OLD profile this round (a stale ranking beats a
   * blocked turn) and starts a background re-analysis; with no usable profile the
   * full set is returned, which is exactly the "fall back to every skill" rule.
   */
  namesFor(roomId: string, botId: string): readonly string[] {
    const skills = this.skillsFor(roomId)
    const available = new Set(skills.map(s => s.name))
    const profile = this.matchingProfile(roomId, botId)
    if (profile !== undefined) {
      const kept = profile.names.filter(name => available.has(name))
      if (kept.length > 0) return kept
    } else {
      void this.refreshProfile(roomId, botId)
    }
    return skills.map(s => s.name)
  }

  /**
   * Re-analyse one bot against one room's skills, in the background.
   *
   * Never throws: a failure persists a profile naming every skill, so the prompt is
   * still complete and the next turn does not pay for another failed call.
   */
  async refreshProfile(roomId: string, botId: string): Promise<void> {
    const bot = this.deps.getBot(botId)
    if (bot === undefined) return
    const roomSignature = this.signatureOf(roomId)
    if (roomSignature === undefined) return
    const skills = this.skillsFor(roomId)
    const allNames = skills.map(s => s.name)
    const signature = profileSignature(bot, roomSignature)
    if (bot.skillProfile?.signature === signature) return
    const key = `${botId}\u0000${roomId}\u0000${signature}`
    if (this.analysing.has(key)) return
    this.analysing.add(key)
    try {
      const chosen = await this.analyse(bot, skills)
      // An empty answer means "nothing matched" just as often as it means "the call
      // failed", and the two are indistinguishable from the text alone. Falling back
      // to the full set is the safe reading: it can only over-offer.
      const names = chosen.length > 0 ? chosen : allNames
      this.deps.saveProfile(botId, { names, signature, analyzedAt: new Date(this.now()).toISOString() })
    } catch (error: unknown) {
      this.deps.logger?.warn?.(`agent-community: skill profile analysis failed for bot ${botId}: ${String(error)}`)
      this.deps.saveProfile(botId, { names: allNames, signature, analyzedAt: new Date(this.now()).toISOString() })
    } finally {
      this.analysing.delete(key)
    }
  }

  /**
   * The `[可用技能]` block (§5.3 prompt 三态).
   *
   * Returns undefined when the room has no skills at all, so a skill-less room's
   * prompt is unchanged. Otherwise the profile's picks come first and the full set
   * is always listed — the model must know it can load ANY skill by name, not only
   * the pre-selected ones.
   *
   * ── THIS IS A TOOLBOX, NOT A TO-DO LIST ─────────────────────────────────────────────────────────
   * A skill is a capability the bot may CALL, exactly like a tool. The earlier wording ("与你身份
   * 相关的（优先使用）") plus action-flavoured skill descriptions (a skill says what it can create:
   * banners, design systems, slides) read as a menu of work to get on with: measured live, a bot
   * greeted with 你好 browsed this list, loaded two skills and started building a brand package
   * nobody asked for. The framing below states the boundary on every turn — these skills are
   * available WHEN THE USER'S REQUEST NEEDS THEM, and having a skill is never a reason to start.
   */
  promptBlock(roomId: string, botId: string): string | undefined {
    const skills = this.skillsFor(roomId)
    if (skills.length === 0) return undefined
    const profile = this.matchingProfile(roomId, botId)
    const available = new Set(skills.map(s => s.name))
    const picked = profile === undefined ? [] : profile.names.filter(n => available.has(n))
    const all = skills.map(s => `· ${s.name}`)
    const lines = [
      '[可用技能]',
      '这些是你可以调用的能力（工具），不是任务清单，也不代表你现在应该做什么。',
      '只有用户的请求确实需要某项技能时才用 skill 工具加载并执行；不要因为清单里有它就主动开工。',
    ]
    if (picked.length > 0) {
      lines.push('与你身份相关的（按需使用）：')
      lines.push(...picked.map(n => `· ${n}`))
      lines.push('')
    } else {
      // No profile yet: the analysis is running, so this turn gets the full list.
      void this.refreshProfile(roomId, botId)
    }
    lines.push('技能全集（用 skill 工具可按名字加载任意一个）：')
    lines.push(all.join('、'))
    lines.push('')
    lines.push(
      '提示：以上是按你的身份预筛的常用项，任务需要时可以加载任意技能，不受此列表限制。'
      + '加载技能=获得做某件事的方法，不等于用户要你做那件事。',
    )
    return lines.join('\n')
  }

  /** One direct model call, parsed into skill names that actually exist. */
  private async analyse(
    bot: { readonly description?: string | undefined; readonly systemPrompt?: string | undefined; readonly provider?: string | undefined; readonly model?: string | undefined; readonly name?: string | undefined },
    skills: readonly SkillEntry[],
  ): Promise<readonly string[]> {
    const stream = this.deps.stream()
    if (stream === undefined) throw new Error('ctx.llm is unavailable')
    if (bot.provider === undefined || bot.model === undefined) {
      throw new Error('bot has no provider/model configured')
    }
    const catalogue = skills.slice(0, 200).map((s) => {
      const description = s.description.replace(/\s+/gu, ' ').slice(0, ANALYSIS_DESCRIPTION_CHARS)
      return `- ${s.name}${description === '' ? '' : `: ${description}`}`
    }).join('\n')
    const system = [
      '你是技能匹配助手。给定一个 Bot 的身份和一份技能清单，挑出与它身份最相关的技能。',
      `只输出一个 JSON 字符串数组，最多 ${MAX_PROFILE_NAMES} 个元素，元素必须是清单里出现过的技能名。`,
      '没有相关技能时输出 []。不要输出解释、Markdown 或代码块。',
    ].join('\n')
    const user = [
      '[Bot 身份]',
      `名称：${bot.name ?? ''}`,
      `描述：${bot.description ?? ''}`,
      `系统提示：${bot.systemPrompt ?? ''}`,
      '',
      '[技能清单]',
      catalogue,
    ].join('\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS)
    try {
      let text = ''
      for await (const chunk of stream({
        provider: bot.provider,
        model: bot.model,
        system,
        // Blocks, not a string: see `LlmContentBlock`. A string here made the adapter
        // throw while projecting, which surfaced as a bare TRANSPORT failure.
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        purpose: 'skill-profile',
        signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
        if (chunk.type === 'finish') {
          const kind = chunk.reason?.kind
          if (kind === 'error') {
            throw new Error(`provider rejected the analysis request: ${chunk.reason?.failure?.message ?? 'unknown failure'}`)
          }
          if (kind === 'aborted') throw new Error('analysis request aborted')
        }
      }
      return pickSkillNames(text, new Set(skills.map(s => s.name)))
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Pull the skill names out of a model answer.
 *
 * Only names that exist in the catalogue survive: a hallucinated name in the prompt
 * would be worse than no profile, because the bot would be told to prioritise a
 * skill the `skill` tool cannot load.
 */
export function pickSkillNames(text: string, available: ReadonlySet<string>): readonly string[] {
  const match = /\[[\s\S]*?\]/u.exec(text)
  if (match === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const value of parsed) {
    if (typeof value !== 'string' || !available.has(value) || out.includes(value)) continue
    out.push(value)
    if (out.length >= MAX_PROFILE_NAMES) break
  }
  return out
}
