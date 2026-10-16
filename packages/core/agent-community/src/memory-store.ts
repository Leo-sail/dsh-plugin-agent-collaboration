/**
 * The memory store — one Markdown file per (room, bot), plus the bot's global instructions.
 *
 * WHY FILES AND NOT A FIELD IN THE BOARD. The user's lifetime rules are what force this:
 * clearing a room's messages must NOT clear its memory, and deleting a room must not either
 * (the partition is archived instead). A memory that has to outlive its room cannot live on
 * the room record, and keeping it in `state.json` would mean every read is a JSON parse of the
 * whole board and every write rewrites it. Files also make the memory what the user asked for:
 * something a human can open, read and edit.
 *
 * LAYOUT:
 *
 *   $DSH_HOME/agent-community/memory/
 *     <botId>/
 *       INDEX.md                     derived; rebuildable from the room files
 *       rooms/<roomId>.md            this bot's memory of ONE room
 *       learned.overflow.md          entries moved out of the global file when it is full
 *     _archive/
 *       <roomId>/<botId>.md          a partition whose room was deleted (or whose bot was)
 *
 * The global memory is NOT here: it is `<bot workspace>/AGENTS.md`, which DSH already loads as
 * the bot's instruction file. This module owns only its managed block.
 *
 * CONCURRENCY: one file per pair, so a bot working in a 1:1 and two groups writes three files.
 * Same-pair writes are serialised by the executor (one run per room+bot), and every write goes
 * through the same atomic-write helper the board uses. Reads are cached by (mtime, size).
 *
 * @module
 */
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BotMemoryEntry, BotMemoryRecord } from './types.ts'
import { appendEntry, clip, entriesFor, MAX_ENTRY_CHARS } from './bot-memory.ts'
import { writeFileAtomic as writeAtomic } from './atomic.ts'

/** What a memory file says about itself. */
export interface RoomMemoryMeta {
  readonly roomId: string
  readonly roomName: string
  readonly botId: string
  readonly kind: 'direct' | 'group'
}

/** Where one pair's memory lives. */
export interface MemoryPaths {
  readonly root: string
  readonly botDir: string
  readonly roomFile: string
  readonly overflowFile: string
  readonly indexPath: string
  readonly archiveFile: string
}

const HEADER = '<!-- agent-community:room-memory v1 -->'

/** Absolute paths for one (bot, room) pair under a memory root. */
export function memoryPaths(root: string, botId: string, roomId: string): MemoryPaths {
  const botDir = join(root, botId)
  return {
    root,
    botDir,
    roomFile: join(botDir, 'rooms', `${roomId}.md`),
    overflowFile: join(botDir, `${roomId}.overflow.md`),
    indexPath: join(botDir, 'INDEX.md'),
    archiveFile: join(root, '_archive', roomId, `${botId}.md`),
  }
}

/** Serialise one partition. Human-readable first: the header is prose, the entries are lines. */
export function renderRoomMemory(meta: RoomMemoryMeta, entries: readonly BotMemoryEntry[]): string {
  const lines = [
    HEADER,
    `kind: ${meta.kind}`,
    `room: ${meta.roomId}`,
    `roomName: ${meta.roomName}`,
    `bot: ${meta.botId}`,
    '',
    `# ${meta.roomName} · 这个房间的记忆`,
    '',
    '> 只属于这个房间。与当前文件或实际运行结果冲突时，以实际为准。',
    '',
    ...entries.map(renderEntry),
    '',
  ]
  return lines.join('\n')
}

function renderEntry(entry: BotMemoryEntry): string {
  const run = entry.runId === undefined ? '' : ` run=${entry.runId}`
  return `- [${entry.kind} ${entry.at}${run}] ${clip(entry.text, MAX_ENTRY_CHARS)}`
}

const ENTRY_RE = /^- \[(task|note) ([^\s\]]+)(?: run=([^\]]+))?\] (.*)$/u

/** Read back what {@link renderRoomMemory} wrote. Unparseable lines are ignored, never fatal. */
export function parseRoomMemory(text: string): BotMemoryEntry[] {
  const out: BotMemoryEntry[] = []
  let index = 0
  for (const line of text.split('\n')) {
    const match = ENTRY_RE.exec(line.trim())
    if (match === null) continue
    index += 1
    out.push({
      id: `${match[2]}#${index}`,
      kind: match[1] === 'note' ? 'note' : 'task',
      at: match[2]!,
      ...(match[3] !== undefined ? { runId: match[3] } : {}),
      text: match[4] ?? '',
    })
  }
  return out
}

/** The managed block inside a bot's `AGENTS.md`. Everything outside it is the user's. */
export const LEARNED_START = '<!-- agent-community:learned:start -->'
export const LEARNED_END = '<!-- agent-community:learned:end -->'

/**
 * Replace the managed block in an instruction file, leaving the rest untouched.
 *
 * A file without the markers gets the block appended; a file that somehow has several blocks
 * is normalised to one — the user deleting the markers and writing their own notes is a normal
 * thing to do, and it must not produce a second block on the next promotion.
 */
export function withLearnedBlock(existing: string, lines: readonly string[]): string {
  const block = [LEARNED_START, ...lines, LEARNED_END].join('\n')
  const start = existing.indexOf(LEARNED_START)
  const end = existing.indexOf(LEARNED_END)
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + LEARNED_END.length)
  }
  const head = existing.trimEnd()
  return head === '' ? `${block}\n` : `${head}\n\n${block}\n`
}

/** The lines currently inside the managed block, for de-duplication and the audit trail. */
export function readLearnedLines(existing: string): string[] {
  const start = existing.indexOf(LEARNED_START)
  const end = existing.indexOf(LEARNED_END)
  if (start < 0 || end <= start) return []
  return existing.slice(start + LEARNED_START.length, end).split('\n').map(l => l.trim()).filter(l => l !== '')
}

interface CacheRow {
  readonly mtimeMs: number
  readonly size: number
  readonly entries: readonly BotMemoryEntry[]
}

/**
 * File-backed memory for every bot.
 *
 * Every method takes the (bot, room) pair or the bot id; there is no method that returns two
 * rooms' entries together, so the isolation rule holds here exactly as it does in the pure
 * module. The store never throws on a read (a corrupt or missing file is an empty partition)
 * but DOES report write failures: "stored: true" that is not true is how a bot quietly forgets.
 */
export class MemoryStore {
  private readonly root: string
  private readonly cache = new Map<string, CacheRow>()

  constructor(root: string) {
    this.root = root
  }

  /** One pair's entries, oldest first. Empty when the pair has never recorded anything. */
  async read(roomId: string, botId: string): Promise<readonly BotMemoryEntry[]> {
    const path = memoryPaths(this.root, botId, roomId).roomFile
    let info
    try {
      info = await stat(path)
    } catch {
      this.cache.delete(path)
      return []
    }
    const hit = this.cache.get(path)
    if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.entries
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return []
    }
    const entries = parseRoomMemory(text)
    this.cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, entries })
    return entries
  }

  /**
   * Append one entry to one pair's partition, trimming the oldest past `maxEntries`.
   *
   * Trimmed entries are MOVED to the overflow file rather than dropped: the user's rule is that
   * only deleting a bot deletes memory.
   */
  async append(input: {
    readonly meta: RoomMemoryMeta
    readonly entry: BotMemoryEntry
    readonly maxEntries: number
    readonly now: string
  }): Promise<{ readonly stored: boolean; readonly path: string; readonly error?: string | undefined }> {
    const paths = memoryPaths(this.root, input.meta.botId, input.meta.roomId)
    try {
      const existing = await this.read(input.meta.roomId, input.meta.botId)
      // The pure helper works on branded records; the store deals in plain strings, so the
      // pair is branded here and only here.
      const record = {
        roomId: input.meta.roomId as BotMemoryRecord['roomId'],
        botId: input.meta.botId as BotMemoryRecord['botId'],
        entries: [...existing],
        updatedAt: input.now,
      }
      const next = appendEntry({
        records: [record],
        roomId: input.meta.roomId,
        botId: input.meta.botId,
        entry: input.entry,
        now: input.now,
        maxEntries: input.maxEntries,
      })[0]!.entries
      const trimmed = next.length < existing.length + 1
        ? [...existing.slice(0, existing.length + 1 - next.length)]
        : []
      await mkdir(dirname(paths.roomFile), { recursive: true })
      await writeAtomic(paths.roomFile, renderRoomMemory(input.meta, next))
      if (trimmed.length > 0) await appendLines(paths.overflowFile, trimmed.map(renderEntry))
      this.cache.delete(paths.roomFile)
      await this.rebuildIndex(input.meta.botId)
      return { stored: true, path: paths.roomFile }
    } catch (error: unknown) {
      // Never silent: the caller reports it, and the run does not pretend it remembered.
      return { stored: false, path: paths.roomFile, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Move one room's partitions for these bots into the archive (room deleted, or bot deleted). */
  async archiveRoom(roomId: string, botIds: readonly string[]): Promise<readonly string[]> {
    const moved: string[] = []
    for (const botId of botIds) {
      const paths = memoryPaths(this.root, botId, roomId)
      try {
        const info = await stat(paths.roomFile)
        if (info.size === 0) continue
        await mkdir(dirname(paths.archiveFile), { recursive: true })
        await rename(paths.roomFile, paths.archiveFile)
        this.cache.delete(paths.roomFile)
        moved.push(paths.archiveFile)
      } catch {
        // Nothing recorded for this pair — the common case, and not an error.
      }
    }
    return moved
  }

  /**
   * Every bot that has a partition for this room, membership notwithstanding.
   *
   * WHY THIS EXISTS. Deleting a room used to archive only the rooms's CURRENT members, so a bot
   * that had been kicked earlier kept its partition in the live tree forever: the room was gone
   * (unreachable), yet no `_archive/<roomId>/` entry was written for it. Observed on :
   * a temp group with fghj's partition was deleted AFTER fghj was kicked, and his 535-byte memory
   * file survived in `memory/<botId>/rooms/<roomId>.md` while the archive stayed empty.
   *
   * The rule the user set is "deleting a room keeps what the bots learned there" — that is about
   * the room's history, not about who happened to still be a member at the end.
   */
  async botsWithRoom(roomId: string): Promise<readonly string[]> {
    const found: string[] = []
    let entries: readonly string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return found
    }
    for (const botId of entries) {
      if (botId === '_archive') continue
      try {
        const info = await stat(join(this.root, botId, 'rooms', `${roomId}.md`))
        if (info.size > 0) found.push(botId)
      } catch {
        // No partition for this pair.
      }
    }
    return found
  }

  /** Delete a bot's own memory. The caller archives its GROUP partitions first. */
  async deleteBot(botId: string): Promise<void> {
    const dir = memoryPaths(this.root, botId, 'x').botDir
    for (const key of [...this.cache.keys()]) if (key.startsWith(dir)) this.cache.delete(key)
    await rm(dir, { recursive: true, force: true })
  }

  /** Every room id this bot has a partition for. Used by the delete-bot two-step. */
  async roomsOf(botId: string): Promise<readonly string[]> {
    const dir = join(memoryPaths(this.root, botId, 'x').botDir, 'rooms')
    try {
      const { readdir } = await import('node:fs/promises')
      const files = await readdir(dir)
      return files.filter(f => f.endsWith('.md')).map(f => f.slice(0, -3))
    } catch {
      return []
    }
  }

  /** Rewrite the derived index for one bot. Cheap, and always reproducible from the files. */
  async rebuildIndex(botId: string): Promise<void> {
    const rooms = await this.roomsOf(botId)
    const lines = [`# ${botId} · 记忆索引`, '', '> 派生文件：可以从 rooms/ 下的正文重建，删掉也能重新生成。', '']
    let total = 0
    for (const roomId of rooms) {
      const entries = await this.read(roomId, botId)
      if (entries.length === 0) continue
      total += entries.length
      const last = entries[entries.length - 1]!
      lines.push(`- ${roomId}：${entries.length} 条，最后 ${last.at}`)
    }
    lines.push('', `合计 ${total} 条。`)
    const indexPath = memoryPaths(this.root, botId, 'x').indexPath
    try {
      await mkdir(dirname(indexPath), { recursive: true })
      await writeAtomic(indexPath, `${lines.join('\n')}\n`)
    } catch {
      // The index is derived: losing it is an inconvenience, never data loss.
    }
  }

  /** Read the managed block of a bot's instruction file. */
  async readLearned(workspace: string): Promise<{ readonly lines: readonly string[]; readonly raw: string }> {
    const path = join(workspace, 'AGENTS.md')
    try {
      const raw = await readFile(path, 'utf8')
      return { lines: readLearnedLines(raw), raw }
    } catch {
      return { lines: [], raw: '' }
    }
  }

  /**
   * Add lines to the managed block, unless an identical line is already there.
   *
   * The block is inside a file the USER owns: everything outside the markers is theirs and is
   * preserved byte for byte.
   */
  async appendLearned(workspace: string, lines: readonly string[]): Promise<{ readonly stored: boolean; readonly added: readonly string[]; readonly path: string }> {
    const path = join(workspace, 'AGENTS.md')
    const { raw, lines: existing } = await this.readLearned(workspace)
    const added = lines.filter(line => !existing.includes(line))
    if (added.length === 0) return { stored: true, added: [], path }
    try {
      await mkdir(workspace, { recursive: true })
      await writeAtomic(path, withLearnedBlock(raw, [...existing, ...added]))
      return { stored: true, added, path }
    } catch {
      return { stored: false, added: [], path }
    }
  }

  /** Write one partition directly — used by the migration from the old board field. */
  async writePartition(meta: RoomMemoryMeta, entries: readonly BotMemoryEntry[]): Promise<void> {
    const paths = memoryPaths(this.root, meta.botId, meta.roomId)
    await mkdir(dirname(paths.roomFile), { recursive: true })
    await writeAtomic(paths.roomFile, renderRoomMemory(meta, entries))
    this.cache.delete(paths.roomFile)
  }

  /** Entries the store already holds for a pair, for the promotion scan. */
  entriesFor(roomId: string, botId: string): Promise<readonly BotMemoryEntry[]> {
    return this.read(roomId, botId)
  }
}

async function appendLines(path: string, lines: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    existing = ''
  }
  await writeAtomic(path, `${existing}${lines.join('\n')}\n`)
}

/** Re-exported so the service does not import the pure module twice. */
export { entriesFor }
