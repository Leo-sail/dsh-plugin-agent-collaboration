/**
 * Memory scopes — bot / team / room partitions.
 *
 * The current store is one Markdown file per (room, bot): it answers "what did this bot
 * do in THIS conversation". Two other long-lived scopes are missing:
 *
 *   · bot  — a preference the bot keeps across every room ("回答用中文", "先查证再动手");
 *   · team — a rule the whole team shares ("产出必须落文件").
 *
 * This module is the storage/serialization primitive only; wiring it into the prompt and
 * the remember/recall tools is deliberately separate (next slice) so the file format can be
 * reviewed and migrated on its own. It mirrors the existing room-memory shape: a heading,
 * then one `- [at] text` line per entry, so a human can read and edit it.
 *
 * Scope rules (decided):
 *   · bot scope belongs to ONE bot and every room that bot is in reads it;
 *   · team scope belongs to the workspace and every bot reads it;
 *   · room scope stays exactly as today (per (room, bot), never crosses rooms).
 *
 * Nothing here writes files: callers keep using the existing atomic-write helper.
 */

/** Which long-lived memory a line belongs to. */
export type MemoryScope = 'bot' | 'team' | 'room'

/** One entry in a scoped file. `at` is optional for hand-edited files. */
export interface ScopedMemoryEntry {
  readonly text: string
  readonly at?: string | undefined
}

export interface MemoryScopeIds {
  readonly root: string
  /** Required for `bot` and `room` scopes. */
  readonly botId?: string | undefined
  /** Required for `room` scope. */
  readonly roomId?: string | undefined
}

/**
 * Absolute file for one scope.
 *
 * - bot:  `<root>/bots/<botId>.md`
 * - team: `<root>/team/MEMORY.md`
 * - room: `<root>/<botId>/rooms/<roomId>.md` (the existing per-pair file)
 *
 * Throws for a scope missing its id: a silently shared file would leak one bot's memory to
 * another, which is the isolation rule this feature exists to keep.
 */
export function scopedMemoryPath(scope: MemoryScope, ids: MemoryScopeIds): string {
  const root = ids.root.replace(/\/+$/u, '')
  if (scope === 'team') return `${root}/team/MEMORY.md`
  if (ids.botId === undefined || ids.botId === '') throw new Error('bot scope needs a botId')
  if (scope === 'bot') return `${root}/bots/${ids.botId}.md`
  if (ids.roomId === undefined || ids.roomId === '') throw new Error('room scope needs a roomId')
  return `${root}/${ids.botId}/rooms/${ids.roomId}.md`
}

/** Serialize one scoped file. Kept byte-stable so diffs are reviewable. */
export function renderScopedMemory(scope: MemoryScope, entries: readonly ScopedMemoryEntry[]): string {
  const title = scope === 'team' ? '团队记忆' : scope === 'bot' ? 'Bot 长期记忆' : '本房间记忆'
  const lines = [
    '<!-- agent-community:scoped-memory v1 -->',
    `scope: ${scope}`,
    '',
    `# ${title}`,
    '',
    '> 一行一条；用户可直接编辑。与当前对话/文件冲突时，以实际为准。',
    '',
    ...entries.map(entry => `- ${entry.at !== undefined && entry.at !== '' ? `[${entry.at}] ` : ''}${entry.text}`),
    '',
  ]
  return lines.join('\n')
}

/** Parse one scoped file. Tolerant by design: a hand-edited file must not break a turn. */
export function parseScopedMemory(raw: string): ScopedMemoryEntry[] {
  const out: ScopedMemoryEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('- ')) continue
    const body = trimmed.slice(2).trim()
    if (body === '') continue
    const stamped = /^\[([^\]]+)\]\s+([\s\S]*)$/u.exec(body)
    if (stamped !== null) out.push({ at: stamped[1]!.trim(), text: stamped[2]!.trim() })
    else out.push({ text: body })
  }
  return out
}

/** Append one entry, keeping the NEWEST `maxEntries` (same rule as room memory). */
export function appendScopedEntry(
  entries: readonly ScopedMemoryEntry[],
  entry: ScopedMemoryEntry,
  maxEntries: number,
): ScopedMemoryEntry[] {
  const text = entry.text.trim()
  if (text === '') return [...entries]
  if (maxEntries <= 0) return []
  return [...entries, { text, ...(entry.at !== undefined ? { at: entry.at } : {}) }].slice(-maxEntries)
}

/**
 * Render the prompt block for the scopes supplied, or undefined when every one is empty.
 *
 * Injected order is bot → team → room: the room is the most specific and goes last so the
 * model reads the narrowest context immediately before the message. Each scope gets its own
 * labelled section; an empty scope is omitted rather than rendered as a blank heading.
 */
export function scopedMemoryBlock(
  scopes: readonly { readonly scope: MemoryScope; readonly entries: readonly ScopedMemoryEntry[] }[],
): string | undefined {
  const labels: Record<MemoryScope, string> = {
    bot: '[Bot 长期记忆]',
    team: '[团队记忆]',
    room: '[本房间记忆]',
  }
  const sections: string[] = []
  for (const scope of ['bot', 'team', 'room'] as const) {
    const found = scopes.find(item => item.scope === scope)
    const entries = found?.entries ?? []
    if (entries.length === 0) continue
    sections.push(`${labels[scope]}\n${entries.map(entry => `- ${entry.text}`).join('\n')}`)
  }
  return sections.length === 0 ? undefined : sections.join('\n\n')
}

/**
 * How many entries of each long-lived scope are considered for one turn's prompt block.
 *
 * `team` gets more than `bot` on purpose: a Bot's own preferences are a handful of rules, while
 * the team conventions are what every Bot must know before it starts.
 */
export const SCOPE_MAX_ENTRIES: Readonly<Record<'bot' | 'team', number>> = { bot: 12, team: 24 }

/** Character budget for the whole long-term prompt block (bot + team). */
export const LONG_TERM_PROMPT_CHARS = 1_500

/** One long-term entry longer than this is clipped before it can spend the block's budget. */
const LONG_TERM_ENTRY_CHARS = 300

/** Collapse whitespace and clip one entry, appending an ellipsis when it was cut. */
function clipLongTermEntry(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length <= LONG_TERM_ENTRY_CHARS) return flat
  return `${flat.slice(0, LONG_TERM_ENTRY_CHARS - 1).trimEnd()}…`
}

/** Newest `limit` entries of one scope, each clipped; blank entries are not worth a prompt line. */
function longTermEntries(entries: readonly ScopedMemoryEntry[], limit: number): ScopedMemoryEntry[] {
  const count = Number.isFinite(limit) ? Math.floor(limit) : 0
  if (count <= 0) return []
  const out: ScopedMemoryEntry[] = []
  for (const entry of entries.slice(-count)) {
    const text = clipLongTermEntry(entry.text)
    if (text === '') continue
    out.push(entry.at !== undefined ? { text, at: entry.at } : { text })
  }
  return out
}

/**
 * The prompt block for the two long-lived scopes, or undefined when both are empty.
 *
 * This is the "what every turn must know" slice of memory: the Bot's cross-room preferences and
 * the team's shared conventions. The room memory keeps its own delta block, injected after this
 * one (narrowest context last — see {@link scopedMemoryBlock}).
 *
 * Rules, kept here so the prompt builder stays pure:
 *   · per scope keep the NEWEST `maxEntriesPerScope` entries (default {@link SCOPE_MAX_ENTRIES},
 *     which differs per scope) and clip each entry to 300 characters;
 *   · render bot → team through `scopedMemoryBlock`, so an empty scope is omitted, not blank;
 *   · when the rendered block exceeds `maxChars` (default {@link LONG_TERM_PROMPT_CHARS}),
 *     delete the OLDEST entries one at a time — Bot's first, then team's — until it fits. The
 *     budget is measured on the rendered block (labels included), which is what the model sees;
 *     a budget too small for even one line therefore yields undefined, same as an empty memory.
 */
export function longTermMemoryBlock(input: {
  readonly bot: readonly ScopedMemoryEntry[]
  readonly team: readonly ScopedMemoryEntry[]
  readonly maxEntriesPerScope?: number | undefined
  readonly maxChars?: number | undefined
}): string | undefined {
  const limit = input.maxEntriesPerScope
  let botEntries = longTermEntries(input.bot, limit ?? SCOPE_MAX_ENTRIES.bot)
  let teamEntries = longTermEntries(input.team, limit ?? SCOPE_MAX_ENTRIES.team)
  const budget = input.maxChars !== undefined && Number.isFinite(input.maxChars)
    ? input.maxChars
    : LONG_TERM_PROMPT_CHARS
  let block = renderLongTermBlock(botEntries, teamEntries)
  while (block !== undefined && block.length > budget) {
    // Oldest first, Bot before team. When both are empty the block is undefined and we stop.
    if (botEntries.length > 0) botEntries = botEntries.slice(1)
    else if (teamEntries.length > 0) teamEntries = teamEntries.slice(1)
    else return undefined
    block = renderLongTermBlock(botEntries, teamEntries)
  }
  return block
}

/** Render the long-term scopes in injection order (bot first, then team). */
function renderLongTermBlock(
  bot: readonly ScopedMemoryEntry[],
  team: readonly ScopedMemoryEntry[],
): string | undefined {
  return scopedMemoryBlock([
    { scope: 'bot', entries: bot },
    { scope: 'team', entries: team },
  ])
}
