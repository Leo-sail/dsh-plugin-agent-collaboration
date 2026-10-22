/**
 * Per-(room, bot) memory — the arithmetic, and nothing else.
 *
 * WHAT THIS IS FOR. A Bot is an agent with an identity, and the user's requirement is that it
 * carries its own memory into the work it does: what it handled in this direct chat, and what it
 * completed in each group it belongs to. The requirement comes with a hard isolation rule, in the
 * user's words: 不能将单聊中的任务发到群聊内，也不能将群聊内的任务发到单聊中，也不能将A群聊的任务发到B群聊中.
 *
 * WHY THE KEY IS THE PAIR, AND WHY THAT IS THE WHOLE DESIGN. Every function here takes a
 * `(roomId, botId)` pair and can only ever read or write that pair's partition. There is no
 * "all memories of this bot" accessor, so no caller — prompt builder, tool, or cleanup — has a
 * way to mix two rooms even by accident. A Bot working in a 1:1 and in two groups at the same
 * time (which the executor explicitly supports) therefore has three disjoint memories, and
 * concurrency needs no lock: two rooms touch two different records.
 *
 * BOUNDED BY CONSTRUCTION. A partition keeps at most `maxEntries` task/note lines and each line
 * is clipped, so the persistent board cannot grow without limit and the prompt block has a known
 * worst case. Trimming drops the OLDEST entries — the recent past is what a bot needs to stay
 * coherent.
 *
 * Pure on purpose: every rule above is kept honest by the plugin's own review pass.
 *
 * @module
 */
import type { BotId, BotMemoryEntry, BotMemoryRecord, BotRoomId } from './types.ts'
import { isInjectable } from './memory-lifecycle.ts'

/** Entries kept per (room, bot). */
export const DEFAULT_MAX_ENTRIES = 12
/** Entries rendered into one turn's prompt. */
export const DEFAULT_PROMPT_ENTRIES = 8
/** Character budget for the rendered block (~500 Chinese characters). */
export const DEFAULT_PROMPT_BUDGET = 2_000
/** Hard cap on one entry, whatever its source. */
export const MAX_ENTRY_CHARS = 300

/** Collapse whitespace and cut to `max` characters, appending an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * The line recorded when a run of this bot finishes in this room.
 *
 * Both halves are clipped: the task from the run's own prompt (the user's words, or the leader's
 * brief) and the outcome from the reply. This is deliberately not a model call — a summariser
 * would cost a request per turn and could itself fail — so the record is verbatim-ish and cheap.
 */
export function taskMemoryText(prompt: string, reply: string): string {
  const task = clip(prompt.replace(/^\[[^\]]*\]\s*/u, ''), 160)
  const outcome = clip(reply, 200)
  if (task === '') return outcome
  return clip(outcome === '' ? `任务：${task}` : `任务：${task} → 结果：${outcome}`, MAX_ENTRY_CHARS)
}

/** The partition for one pair, or `undefined` when that pair has no memory yet. */
export function memoryFor(
  records: readonly BotMemoryRecord[] | undefined,
  roomId: string,
  botId: string,
): BotMemoryRecord | undefined {
  return records?.find(r => r.roomId === roomId && r.botId === botId)
}

/** One pair's entries, oldest first. Empty for a pair that has never recorded anything. */
export function entriesFor(
  records: readonly BotMemoryRecord[] | undefined,
  roomId: string,
  botId: string,
): readonly BotMemoryEntry[] {
  return memoryFor(records, roomId, botId)?.entries ?? []
}

/**
 * Append one entry to one pair's partition, trimming the oldest beyond `maxEntries`.
 *
 * Returns a NEW array (the board is immutable state); the record for every other pair is passed
 * through untouched, which is what keeps a write in one room invisible to another.
 *
 * OP-08: the entry's lifecycle metadata (`source`/`status`/`outcome`/`confidence`/`updatedAt`)
 * rides along untouched — the spread below preserves it, and serialising it to the partition is
 * `memory-store.ts`'s job. Only `text` is clipped here.
 */
export function appendEntry(input: {
  readonly records: readonly BotMemoryRecord[] | undefined
  readonly roomId: string
  readonly botId: string
  readonly entry: BotMemoryEntry
  readonly now: string
  readonly maxEntries?: number | undefined
}): BotMemoryRecord[] {
  const max = input.maxEntries ?? DEFAULT_MAX_ENTRIES
  const records = input.records ?? []
  const index = records.findIndex(r => r.roomId === input.roomId && r.botId === input.botId)
  const existing = index < 0 ? undefined : records[index]
  const entries = [...(existing?.entries ?? []), { ...input.entry, text: clip(input.entry.text, MAX_ENTRY_CHARS) }]
  const trimmed = entries.length > max ? entries.slice(entries.length - max) : entries
  const record: BotMemoryRecord = {
    roomId: input.roomId as BotRoomId,
    botId: input.botId as BotId,
    entries: trimmed,
    updatedAt: input.now,
  }
  if (index < 0) return [...records, record]
  const next = [...records]
  next[index] = record
  return next
}

/**
 * The block a turn sees, or `undefined` when this pair has nothing to show.
 *
 * Only THIS pair's entries are ever passed in, and the block says so: the model is told the memory
 * belongs to this room alone, which is the prompt-side half of the isolation rule. The structural
 * half is that the caller cannot obtain another pair's entries in the first place.
 *
 * Trimming is newest-first: the block keeps the most recent entries that fit the character budget.
 *
 * OP-08: only `active` entries are injected. A `probation` entry (a peer bot or a timer started
 * that turn — the user never asked) and a `decayed` entry (the user corrected it) are still in
 * the partition and still searchable, but they must not read like established facts in the main
 * prompt. Records without a status (pre-OP-08 data) stay injectable.
 */
export function renderMemoryBlock(
  entries: ReadonlyArray<{ readonly text: string; readonly at: string; readonly status?: BotMemoryEntry['status'] }>,
  options: { readonly limit?: number | undefined; readonly budget?: number | undefined } = {},
): string | undefined {
  const injectable = entries.filter(entry => isInjectable(entry))
  if (injectable.length === 0) return undefined
  const limit = options.limit ?? DEFAULT_PROMPT_ENTRIES
  const budget = options.budget ?? DEFAULT_PROMPT_BUDGET
  const recent = injectable.slice(-limit)
  const kept: string[] = []
  let used = 0
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const entry = recent[i]!
    // `YYYY-MM-DD HH:MM` — UTC, and short enough not to dominate the line.
    const line = `- ${entry.at.slice(0, 16).replace('T', ' ')} ${entry.text}`
    if (used + line.length > budget && kept.length > 0) break
    kept.push(line)
    used += line.length
  }
  kept.reverse()
  return [
    '[本房间记忆]',
    '以下是你在「这个房间」里做过的事。它们只属于这个房间，不要与其他房间的内容混在一起，也不要主动向用户提起别的房间。',
    ...kept,
  ].join('\n')
}

/** Drop every partition of one room (the room is gone, or the user cleared it). */
export function dropRoom(
  records: readonly BotMemoryRecord[] | undefined,
  roomId: string,
): BotMemoryRecord[] {
  return (records ?? []).filter(r => r.roomId !== roomId)
}

/** Drop every partition of one bot (the bot is gone). */
export function dropBot(
  records: readonly BotMemoryRecord[] | undefined,
  botId: string,
): BotMemoryRecord[] {
  return (records ?? []).filter(r => r.botId !== botId)
}

/** Drop one bot's partitions from ONE room (it was removed from that room). */
export function dropBotFromRoom(
  records: readonly BotMemoryRecord[] | undefined,
  roomId: string,
  botIds: ReadonlySet<string>,
): BotMemoryRecord[] {
  return (records ?? []).filter(r => !(r.roomId === roomId && botIds.has(r.botId)))
}

/**
 * What a turn should be told about this room's memory, given what it was already told.
 *
 * BASELINE ONCE, DELTA AFTER. The first turn in a room carries the recent memory; later turns
 * carry only the entries added since — the same paragraph repeated every turn is pure prompt
 * cost, and it also breaks the request prefix cache, which the host explicitly protects.
 *
 * OP-08: the boundary is computed over the INJECTABLE subset only. A `probation` entry written
 * after the last active one must not become the "newest id" (it is not injected), and it must not
 * sit between the boundary and a later active entry (that active entry would be skipped for ever).
 * The returned `newestId` is therefore the newest INJECTED entry; when nothing is injectable the
 * previous boundary is handed back unchanged.
 *
 * @param entries - the pair's entries, oldest first.
 * @param alreadyInjectedId - the newest entry id already shown to this session (undefined = none).
 * @returns the block to add, or undefined when there is nothing new.
 */
export function renderMemoryDelta(
  entries: ReadonlyArray<{
    readonly id: string
    readonly text: string
    readonly at: string
    readonly status?: BotMemoryEntry['status']
  }>,
  alreadyInjectedId: string | undefined,
  options: { readonly limit?: number | undefined; readonly budget?: number | undefined } = {},
): { readonly block: string | undefined; readonly newestId: string | undefined; readonly baseline: boolean } {
  const injectable = entries.filter(entry => isInjectable(entry))
  if (injectable.length === 0) return { block: undefined, newestId: alreadyInjectedId, baseline: false }
  const newestId = injectable[injectable.length - 1]!.id
  if (alreadyInjectedId === newestId) return { block: undefined, newestId, baseline: false }
  const at = alreadyInjectedId === undefined ? -1 : injectable.findIndex(e => e.id === alreadyInjectedId)
  // A baseline (nothing shown yet, or the boundary entry is gone after an overflow/clear) is
  // the recent window; a delta is everything after the boundary.
  const fresh = at < 0 ? injectable.slice(-(options.limit ?? DEFAULT_PROMPT_ENTRIES)) : injectable.slice(at + 1)
  if (fresh.length === 0) return { block: undefined, newestId, baseline: at < 0 }
  const block = renderMemoryBlock(fresh, options)
  return { block, newestId, baseline: at < 0 }
}

/**
 * Rank one pair's entries against a query — the `recall` tool's search.
 *
 * Local and dependency-free on purpose: the host's `sessionQuery` scores Chinese poorly
 * (unicode61 tokenising), and memory is Markdown, not a session log. Character bigrams plus a
 * substring bonus are enough to find "把超时改成 30s" from "超时", and the result carries its
 * provenance so the model can go back to the file rather than trusting a summary.
 *
 * OP-08: recall intentionally searches EVERY entry, including probation/decayed ones — the bot
 * may need what it was told before — but labels them (`[待确认]` / `[已衰减]`) so a peer bot's
 * unconfirmed claim and a user-corrected mistake cannot come back as settled fact.
 */
export function searchMemory(
  entries: readonly BotMemoryEntry[],
  query: string,
  limit = 5,
): ReadonlyArray<{
  readonly entry: BotMemoryEntry
  readonly score: number
  /** `[待确认]` for probation, `[已衰减]` for decayed; absent for active entries. */
  readonly label?: string | undefined
}> {
  const needle = query.replace(/\s+/gu, '').toLowerCase()
  if (needle === '') return []
  const grams = new Set<string>()
  for (let i = 0; i + 1 < needle.length; i += 1) grams.add(needle.slice(i, i + 2))
  const labelOf = (entry: BotMemoryEntry): string | undefined => {
    if (entry.status === 'probation') return '[待确认]'
    if (entry.status === 'decayed') return '[已衰减]'
    return undefined
  }
  const scored = entries.map((entry) => {
    const hay = entry.text.toLowerCase()
    let score = 0
    if (hay.includes(needle)) score += 2
    for (const gram of grams) if (hay.includes(gram)) score += 1
    const label = labelOf(entry)
    return label === undefined ? { entry, score } : { entry, score, label }
  })
  return scored
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || (a.entry.at < b.entry.at ? 1 : -1))
    .slice(0, limit)
}
