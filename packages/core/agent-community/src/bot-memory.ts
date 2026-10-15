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
 * Pure on purpose: every rule above is asserted in `tests/bot-memory.mjs` without a Cordis runtime.
 *
 * @module
 */
import type { BotId, BotMemoryEntry, BotMemoryRecord, BotRoomId } from './types.ts'

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
 */
export function renderMemoryBlock(
  entries: ReadonlyArray<{ readonly text: string; readonly at: string }>,
  options: { readonly limit?: number | undefined; readonly budget?: number | undefined } = {},
): string | undefined {
  if (entries.length === 0) return undefined
  const limit = options.limit ?? DEFAULT_PROMPT_ENTRIES
  const budget = options.budget ?? DEFAULT_PROMPT_BUDGET
  const recent = entries.slice(-limit)
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
