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
import { randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BotMemoryEntry, BotMemoryRecord } from './types.ts'
import { appendEntry, clip, entriesFor, MAX_ENTRY_CHARS, redactSecrets } from './bot-memory.ts'
import { writeFileAtomic as writeAtomic } from './atomic.ts'

/** What a memory file says about itself. */
export interface RoomMemoryMeta {
  readonly roomId: string
  readonly roomName: string
  readonly botId: string
  readonly kind: 'direct' | 'group'
}

/**
 * One journal row: what a memory edit changed, so the edit can be undone.
 *
 * The journal is APPEND-ONLY JSONL at `<botDir>/journal.jsonl` (mode 0600): one file per Bot,
 * rows tagged with their room. It is the undo log for the memory UI, not a second copy of the
 * memory itself — `before`/`after` carry only the text of the entry that changed.
 *
 * `entryId` is the stable content id of the entry the row is about (see `stableEntryId`); an
 * `add` row keeps the id it will get, an `update` row keeps the id the entry had, and a
 * `remove` row keeps the id it can be restored with. `before`/`after` are `null` where the
 * action has no old/new text (add has no before, remove has no after).
 */
export interface MemoryJournalRow {
  readonly id: string
  readonly at: string
  readonly roomId: string
  readonly botId: string
  readonly action: 'add' | 'update' | 'remove'
  readonly entryId: string
  /** entry text before the change; null/absent for add */
  readonly before?: string | null
  /** entry text after the change; null/absent for remove */
  readonly after?: string | null
}

/** Where one pair's memory lives. */
export interface MemoryPaths {
  readonly root: string
  readonly botDir: string
  readonly roomFile: string
  readonly overflowFile: string
  readonly indexPath: string
  readonly archiveFile: string
  /** The Bot's append-only edit journal, shared by every room of that Bot. */
  readonly journalFile: string
}

const HEADER = '<!-- agent-community:room-memory v1 -->'

/**
 * Private-by-default modes for every memory artefact.
 *
 * Memory is written verbatim-ish from the user's prompts and the bot's replies (see
 * `taskMemoryText`), so it can contain passphrases, file paths and private work. The files used
 * to be created with the process umask (0644 under the common 022), which made every memory line
 * readable by any local account. New writes use these modes; `hardenPermissions()` migrates what
 * older builds left on disk.
 */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

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
    journalFile: join(botDir, 'journal.jsonl'),
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

/**
 * Serialise one entry.
 *
 * OP-08 extends the bracket with optional `key=value` fields: `source`, `status`, `outcome`,
 * `confidence` (and the existing `run`). They are written in a FIXED order and only when the
 * entry carries them, so:
 *
 *   · a pre-OP-08 file (no metadata) still parses — `parseRoomMemory` derives the legacy defaults;
 *   · `stableEntryId` stays `kind + at + text`, so a lifecycle change (probation → decayed) never
 *     changes an id and the prompt delta boundary survives it.
 *
 * `updatedAt` is intentionally NOT serialised: it is a runtime timestamp that only matters until
 * the next lifecycle write, and keeping the human-readable line short matters more.
 */
function renderEntry(entry: BotMemoryEntry): string {
  const fields: string[] = []
  if (entry.runId !== undefined) fields.push(`run=${entry.runId}`)
  if (entry.source !== undefined) fields.push(`source=${entry.source}`)
  if (entry.status !== undefined) fields.push(`status=${entry.status}`)
  if (entry.outcome !== undefined) fields.push(`outcome=${entry.outcome}`)
  if (entry.confidence !== undefined && Number.isFinite(entry.confidence)) {
    fields.push(`confidence=${Math.round(Math.min(1, Math.max(0, entry.confidence)) * 1000) / 1000}`)
  }
  const meta = fields.length === 0 ? '' : ` ${fields.join(' ')}`
  return `- [${entry.kind} ${entry.at}${meta}] ${clip(entry.text, MAX_ENTRY_CHARS)}`
}

/** The bracket prefix: kind, timestamp, then an optional tail of `key=value` fields. */
const ENTRY_RE = /^- \[(task|note) ([^\s\]]+)([^\]]*)\] (.*)$/u

/** One metadata field inside the bracket. */
const FIELD_RE = /(\w+)=([^\s\]]+)/gu

/** Values the parser accepts for each enum field; anything else is ignored (hand-edited file). */
const SOURCE_VALUES = new Set(['run', 'note', 'a2a', 'routine', 'unknown'])
const STATUS_VALUES = new Set(['active', 'probation', 'decayed'])
const OUTCOME_VALUES = new Set(['positive', 'negative', 'unknown'])

/**
 * Parse the `key=value` tail of one entry line.
 *
 * Unknown keys and out-of-range values are ignored rather than fatal: a human edits these files.
 */
function parseEntryFields(tail: string): Pick<BotMemoryEntry, 'runId' | 'source' | 'status' | 'outcome' | 'confidence'> {
  const out: {
    runId?: string
    source?: NonNullable<BotMemoryEntry['source']>
    status?: NonNullable<BotMemoryEntry['status']>
    outcome?: NonNullable<BotMemoryEntry['outcome']>
    confidence?: number
  } = {}
  FIELD_RE.lastIndex = 0
  for (let match = FIELD_RE.exec(tail); match !== null; match = FIELD_RE.exec(tail)) {
    const key = match[1]
    const value = match[2]!
    if (key === 'run') out.runId = value
    else if (key === 'source' && SOURCE_VALUES.has(value)) out.source = value as BotMemoryEntry['source'] & string
    else if (key === 'status' && STATUS_VALUES.has(value)) out.status = value as BotMemoryEntry['status'] & string
    else if (key === 'outcome' && OUTCOME_VALUES.has(value)) out.outcome = value as BotMemoryEntry['outcome'] & string
    else if (key === 'confidence') {
      const parsed = Number(value)
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) out.confidence = parsed
    }
  }
  return out
}

/**
 * Fill the lifecycle defaults for a legacy (or partially hand-edited) line.
 *
 * LEGACY COMPATIBILITY, stated once and tested: before OP-08 every run-backed task line was a
 * promotion candidate, so an old task line WITH a run id parses as `run/active/positive` and
 * keeps its old learning behaviour. A task line without a run id is `unknown/active/unknown`,
 * a note is `note/active/unknown`. Nothing becomes `probation` merely because it is old.
 */
function withLegacyDefaults(
  entry: BotMemoryEntry,
): BotMemoryEntry {
  const status = entry.status ?? 'active'
  const source = entry.source ?? (
    entry.runId !== undefined ? 'run' : entry.kind === 'note' ? 'note' : 'unknown'
  )
  const outcome = entry.outcome ?? (
    entry.kind === 'task' && entry.runId !== undefined ? 'positive' : 'unknown'
  )
  return { ...entry, source, status, outcome }
}

/**
 * FNV-1a (32-bit) over UTF-16 code units — a small, dependency-free stable hash.
 *
 * The memory delta engine remembers the id of the newest entry it already showed the
 * model. Ids used to be positional (`${at}#${index}`), so trimming an old entry shifted
 * every surviving index and the boundary lookup failed: the delta degraded into a full
 * baseline re-send on every turn once a partition was full. A content hash keeps the id
 * of a surviving entry identical across trims.
 */
export function stableHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Stable id for one memory entry: same (kind, at, text) parses to the same id, always. */
export function stableEntryId(input: {
  readonly kind: string
  readonly at: string
  readonly text: string
}): string {
  return `${input.at}#${stableHash(`${input.kind}\u0000${input.text}`)}`
}

/**
 * Read back what {@link renderRoomMemory} wrote. Unparseable lines are ignored, never fatal.
 *
 * A line that parses twice (the same entry rendered twice, e.g. a retried append) yields
 * ONE entry: the id is content-derived, so duplicates would otherwise collide. Dropping
 * the repeat is the only stable answer — the two lines are indistinguishable.
 *
 * OP-08: the bracket may carry lifecycle metadata (`run`, `source`, `status`, `outcome`,
 * `confidence`). A pre-OP-08 line has none and gets the documented legacy defaults
 * ({@link withLegacyDefaults}); either way the id — and therefore the prompt delta boundary —
 * depends only on kind + at + text.
 */
export function parseRoomMemory(text: string): BotMemoryEntry[] {
  const out: BotMemoryEntry[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const match = ENTRY_RE.exec(line.trim())
    if (match === null) continue
    const kind = match[1] === 'note' ? 'note' : 'task'
    const at = match[2]!
    const text_ = match[4] ?? ''
    const id = stableEntryId({ kind, at, text: text_ })
    if (seen.has(id)) continue
    seen.add(id)
    out.push(withLegacyDefaults({
      id,
      kind,
      at,
      ...parseEntryFields(match[3] ?? ''),
      text: text_,
    }))
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
      await mkdir(dirname(paths.roomFile), { recursive: true, mode: DIR_MODE })
      await writeAtomic(paths.roomFile, renderRoomMemory(input.meta, next), { mode: FILE_MODE, dirMode: DIR_MODE })
      if (trimmed.length > 0) await appendLines(paths.overflowFile, trimmed.map(renderEntry))
      this.cache.delete(paths.roomFile)
      await this.rebuildIndex(input.meta.botId)
      // The add is journaled so the UI can undo it. Best-effort on purpose: `append`'s
      // stored/path answer is about the MEMORY write and must not change for the audit log.
      try {
        await this.appendJournalRow({
          roomId: input.meta.roomId,
          botId: input.meta.botId,
          action: 'add',
          // The file derives its own id from (kind, at, text); journal THAT id, so undo can
          // restore the exact entry later even when the caller passed a display id.
          entryId: stableEntryId({
            kind: input.entry.kind,
            at: input.entry.at,
            text: clip(input.entry.text, MAX_ENTRY_CHARS),
          }),
          before: null,
          after: clip(input.entry.text, MAX_ENTRY_CHARS),
        })
      } catch (error: unknown) {
        this.warn(`could not journal an added entry: ${errorText(error)}`)
      }
      return { stored: true, path: paths.roomFile }
    } catch (error: unknown) {
      // Never silent: the caller reports it, and the run does not pretend it remembered.
      return { stored: false, path: paths.roomFile, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Replace one entry's text, keeping its kind/at (and therefore its lifecycle position).
   *
   * The id is content-derived (`stableEntryId`), so the edited entry gets a new id; undoing
   * the edit restores the text and with it the original id. The change is journaled with
   * `before`/`after`, so {@link revertJournal} can put the old text back. A journal write
   * failure is REPORTED (`ok:false`) even though the memory write already happened: losing
   * the audit row silently would make the edit look undoable when it is not.
   */
  async updateEntry(
    meta: RoomMemoryMeta,
    entryId: string,
    text: string,
  ): Promise<{ readonly ok: boolean; readonly error?: string | undefined }> {
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'memory entry text is empty' }
    try {
      const entries = [...await this.read(meta.roomId, meta.botId)]
      const index = entries.findIndex(entry => entry.id === entryId)
      if (index < 0) return { ok: false, error: 'memory entry not found' }
      const before = entries[index]!
      // Same shape the append path writes: clipped to one entry's budget.
      const after = clip(text, MAX_ENTRY_CHARS)
      if (after === before.text) return { ok: true } // nothing changed: no journal row for a no-op
      entries[index] = { ...before, text: after }
      await this.writePartition(meta, entries)
      await this.rebuildIndex(meta.botId)
      try {
        await this.appendJournalRow({
          roomId: meta.roomId,
          botId: meta.botId,
          action: 'update',
          entryId,
          before: before.text,
          after,
        })
      } catch (error: unknown) {
        return { ok: false, error: `memory was updated but its journal row could not be written: ${errorText(error)}` }
      }
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) }
    }
  }

  /**
   * Delete one entry and journal the removal, so {@link revertJournal} can restore it.
   *
   * `removed` tells the caller whether this call changed anything: `ok:false` with
   * `removed:false` is the "not found" contract; a journal failure after a successful delete
   * returns `ok:false` with `removed:true` (the memory write is the authoritative one).
   */
  async removeEntry(
    meta: RoomMemoryMeta,
    entryId: string,
  ): Promise<{ readonly ok: boolean; readonly removed?: boolean; readonly error?: string | undefined }> {
    try {
      const entries = [...await this.read(meta.roomId, meta.botId)]
      const index = entries.findIndex(entry => entry.id === entryId)
      if (index < 0) return { ok: false, removed: false, error: 'memory entry not found' }
      const removed = entries[index]!
      entries.splice(index, 1)
      await this.writePartition(meta, entries)
      await this.rebuildIndex(meta.botId)
      try {
        await this.appendJournalRow({
          roomId: meta.roomId,
          botId: meta.botId,
          action: 'remove',
          entryId,
          before: removed.text,
          after: null,
        })
      } catch (error: unknown) {
        return { ok: false, removed: true, error: `memory entry was removed but its journal row could not be written: ${errorText(error)}` }
      }
      return { ok: true, removed: true }
    } catch (error: unknown) {
      return { ok: false, removed: false, error: errorText(error) }
    }
  }

  /**
   * One pair's journal rows, oldest first.
   *
   * The file is append-only and shared by every room of the Bot, so rows are filtered by
   * `roomId`. A half-written tail (or any corrupt line a human left) is SKIPPED rather than
   * fatal: the journal is an undo convenience and one bad byte must not hide valid rows.
   */
  async journal(roomId: string, botId: string): Promise<readonly MemoryJournalRow[]> {
    const rows = await this.readJournal(botId)
    return rows.filter(row => row.roomId === roomId && row.botId === botId)
  }

  /**
   * Undo one journal row, and journal the undo as a compensating row so it can be redone.
   *
   * The inverse follows the action: an `update` gets its `before` text back; an `add` is
   * deleted; a `remove` is restored with the id/at recovered from `entryId`. The compensating
   * row has the INVERSE action and carries before/after the other way round, so feeding it to
   * this method again toggles the edit — including after a reload, when only the file remains.
   *
   * IDEMPOTENT: when the entry is already gone or already in the target state (a second call,
   * a hand-edited file) it returns `ok:true` without writing a row. The original id/at are
   * recoverable because `entryId` is `"<at>#<hash>"` and the kind is the one of the two the
   * hash fits; lifecycle metadata (source/status/…) is NOT journaled and comes back as the
   * legacy defaults — the entry text and its place in time are what undo promises.
   */
  async revertJournal(
    meta: RoomMemoryMeta,
    journalId: string,
  ): Promise<{ readonly ok: boolean; readonly error?: string | undefined }> {
    try {
      const row = (await this.journal(meta.roomId, meta.botId)).find(candidate => candidate.id === journalId)
      if (row === undefined) return { ok: false, error: 'journal entry not found' }
      const entries = [...await this.read(meta.roomId, meta.botId)]

      if (row.action === 'update') {
        const after = row.after ?? ''
        const before = row.before ?? ''
        if (after === '' || before === '') return { ok: true } // nothing to restore
        // The edited entry has a different content-derived id; recover it from the row's
        // before text + id, and fall back to the text when the file was hand-edited.
        const at = journalEntryAt(row.entryId)
        const afterId = at === undefined
          ? undefined
          : stableEntryId({ kind: journalEntryKind(row, at), at, text: after })
        let index = afterId === undefined ? -1 : entries.findIndex(entry => entry.id === afterId)
        // A compensating row (undo of an undo) points back at the id the entry had, so the
        // original id is the second exact candidate before falling back to text.
        if (index < 0) index = entries.findIndex(entry => entry.id === row.entryId)
        if (index < 0) index = entries.findIndex(entry => entry.text === after)
        if (index < 0) return { ok: true } // already reverted, or the entry was removed since
        entries[index] = { ...entries[index]!, text: before }
        await this.writePartition(meta, entries)
        await this.rebuildIndex(meta.botId)
        await this.appendJournalRow({
          roomId: meta.roomId, botId: meta.botId, action: 'update', entryId: row.entryId,
          before: after, after: before,
        })
        return { ok: true }
      }

      if (row.action === 'add') {
        const after = row.after ?? ''
        let index = entries.findIndex(entry => entry.id === row.entryId)
        if (index < 0) index = entries.findIndex(entry => entry.text === after)
        if (index < 0) return { ok: true }
        entries.splice(index, 1)
        await this.writePartition(meta, entries)
        await this.rebuildIndex(meta.botId)
        await this.appendJournalRow({
          roomId: meta.roomId, botId: meta.botId, action: 'remove', entryId: row.entryId,
          before: after, after: null,
        })
        return { ok: true }
      }

      // remove: put the entry back with the id/at the row was created with.
      const text = row.before ?? ''
      if (text === '') return { ok: true }
      const at = journalEntryAt(row.entryId) ?? row.at
      if (entries.some(entry => entry.id === row.entryId || (entry.at === at && entry.text === text))) {
        return { ok: true } // already restored
      }
      const kind = journalEntryKind(row, at)
      insertByAt(entries, { id: row.entryId, kind, at, text })
      await this.writePartition(meta, entries)
      await this.rebuildIndex(meta.botId)
      await this.appendJournalRow({
        roomId: meta.roomId, botId: meta.botId, action: 'add', entryId: row.entryId,
        before: null, after: text,
      })
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) }
    }
  }

  /** Append one row to a Bot's journal (atomic, 0600); throws so callers can report it. */
  private async appendJournalRow(input: {
    readonly roomId: string
    readonly botId: string
    readonly action: MemoryJournalRow['action']
    readonly entryId: string
    readonly before: string | null
    readonly after: string | null
  }): Promise<void> {
    const row: MemoryJournalRow = {
      id: randomUUID(),
      at: new Date().toISOString(),
      roomId: input.roomId,
      botId: input.botId,
      action: input.action,
      entryId: input.entryId,
      before: input.before,
      after: input.after,
    }
    const path = memoryPaths(this.root, input.botId, 'x').journalFile
    // APPEND (O_APPEND), not read-modify-write: a crash leaves at most a half line (which
    // `readJournal` skips by contract), and two rooms of one Bot editing at the same instant
    // cannot erase each other's rows the way a whole-file rewrite would. The journal is an
    // audit/undo convenience, not the memory itself, so losing one row to a torn append is a
    // better failure than a permanently stuck write.
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
    await appendFile(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: FILE_MODE })
    // A journal created by an older build keeps its own mode; tighten it on every write.
    await chmod(path, FILE_MODE).catch(() => undefined)
  }

  /** A Bot's journal rows, skipping corrupt/half-written lines (the file is append-only). */
  private async readJournal(botId: string): Promise<MemoryJournalRow[]> {
    const path = memoryPaths(this.root, botId, 'x').journalFile
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return []
    }
    const rows: MemoryJournalRow[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let value: unknown
      try {
        value = JSON.parse(trimmed)
      } catch {
        continue // a half-written tail is not data
      }
      if (isJournalRow(value)) rows.push(value)
    }
    return rows
  }

  /**
   * Drop journal rows that can no longer be undone and rewrite the file.
   *
   * Best-effort: clearing memory must not fail because the audit log could not be rewritten.
   * Choice documented at the call sites: clearing a pair/room drops its rows (a deliberate
   * "forget" must not be undoable back into existence), while a deleted room's archive keeps
   * its content but no live undo history.
   */
  private async dropJournalRows(botId: string, keep: (row: MemoryJournalRow) => boolean): Promise<void> {
    try {
      const rows = await this.readJournal(botId)
      if (rows.length === 0) return
      const kept = rows.filter(keep)
      if (kept.length === rows.length) return
      const path = memoryPaths(this.root, botId, 'x').journalFile
      if (kept.length === 0) {
        await rm(path, { force: true })
        return
      }
      await writeAtomic(path, `${kept.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: FILE_MODE, dirMode: DIR_MODE })
    } catch (error: unknown) {
      this.warn(`could not rewrite a memory journal: ${errorText(error)}`)
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
        await mkdir(dirname(paths.archiveFile), { recursive: true, mode: DIR_MODE })
        await rename(paths.roomFile, paths.archiveFile)
        this.cache.delete(paths.roomFile)
        moved.push(paths.archiveFile)
      } catch {
        // Nothing recorded for this pair — the common case, and not an error.
      }
      // The live undo history follows the live partition: the archived file has no undo
      // (restoring it into the live tree would resurrect memory the user deleted with the room).
      await this.dropJournalRows(botId, row => row.roomId !== roomId)
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
      await mkdir(dirname(indexPath), { recursive: true, mode: DIR_MODE })
      await writeAtomic(indexPath, `${lines.join('\n')}\n`, { mode: FILE_MODE, dirMode: DIR_MODE })
    } catch {
      // The index is derived: losing it is an inconvenience, never data loss.
    }
  }

  /**
   * Bring everything already on disk to the private modes.
   *
   * New writes use 0600/0700, but a profile that has been in use for a while still has 0644
   * files from older builds (and a human may have copied files in). Any local account could read
   * those, which is the "memory is plaintext on disk" half of the retention bug, so the service
   * runs this once at startup. Best-effort by design: a file the process does not own, a
   * read-only filesystem or a concurrent writer produces a warning, never a crash.
   */
  async hardenPermissions(): Promise<void> {
    await this.hardenDir(this.root)
  }

  /**
   * Redact credential-shaped values in memory files that are ALREADY on disk.
   *
   * `hardenPermissions` fixes who can read the files; it cannot remove a 口令 that an older
   * build wrote verbatim. The user reported exactly that: the password was still readable in
   * `memory/<botId>/rooms/<roomId>.md` after the transcript was gone. New writes are redacted
   * at the memory entry point (`redactSecrets` in `taskMemoryText` / the service's write path),
   * so this one-time pass is the upgrade path for existing profiles. It rewrites only files
   * whose text actually changes, keeps the Markdown shape intact, and leaves no plaintext
   * backup behind (a backup would defeat the point). Idempotent: a second run changes nothing.
   *
   * Scans the whole root including `_archive` — an archived password is still on the disk the
   * user was talking about. INDEX.md carries only room ids and counts, so it is skipped.
   */
  async scrubSecrets(): Promise<{ readonly files: number; readonly entries: number }> {
    let files = 0
    let entries = 0
    const walk = async (dir: string): Promise<void> => {
      let list
      try {
        list = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of list) {
        const path = join(dir, item.name)
        if (item.isDirectory()) {
          await walk(path)
          continue
        }
        if (!item.isFile() || !/\.md$/u.test(item.name) || item.name === 'INDEX.md') continue
        let text
        try {
          text = await readFile(path, 'utf8')
        } catch {
          continue
        }
        const next = redactSecrets(text)
        if (next === text) continue
        try {
          await writeAtomic(path, next, { mode: FILE_MODE, dirMode: DIR_MODE })
        } catch (error: unknown) {
          this.warn(`could not redact ${path}: ${errorText(error)}`)
          continue
        }
        files += 1
        const before = text.split('\n')
        const after = next.split('\n')
        for (let i = 0; i < before.length; i += 1) {
          if (before[i] !== after[i]) entries += 1
        }
        // A rewritten room file must not keep serving its pre-redaction parse from the cache.
        this.cache.delete(path)
      }
    }
    await walk(this.root)
    return { files, entries }
  }

  /** Recursive body of {@link hardenPermissions}; directories 0700, memory files 0600. */
  private async hardenDir(dir: string): Promise<void> {
    try {
      await chmod(dir, DIR_MODE)
    } catch (error: unknown) {
      this.warn(`could not set ${DIR_MODE.toString(8)} on ${dir}: ${errorText(error)}`)
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.hardenDir(path)
        continue
      }
      if (!entry.isFile() || !/\.(?:md|jsonl)$/u.test(entry.name)) continue
      try {
        await chmod(path, FILE_MODE)
      } catch (error: unknown) {
        this.warn(`could not set ${FILE_MODE.toString(8)} on ${path}: ${errorText(error)}`)
      }
    }
  }

  /**
   * Delete one room's LIVE memory of every bot. The `_archive` tree is deliberately untouched:
   * it is the record of rooms that were DELETED, and the user's rule is that deleting a room
   * keeps what the bots learned there.
   *
   * @param roomId - the room whose live partitions are dropped.
   * @returns how many files were deleted (room file and/or overflow file per bot).
   */
  async clearRoom(roomId: string): Promise<number> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch {
      return 0
    }
    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '_archive') continue
      const botId = entry.name
      const paths = memoryPaths(this.root, botId, roomId)
      let changed = false
      if (await removeFile(paths.roomFile)) {
        removed += 1
        changed = true
      }
      if (await removeFile(paths.overflowFile)) {
        removed += 1
        changed = true
      }
      this.cache.delete(paths.roomFile)
      // A deliberate clear is not undoable: restoring memory the user just forgot with
      // "clear" would reverse that instruction. Rows for other rooms stay.
      await this.dropJournalRows(botId, row => row.roomId !== roomId)
      if (!changed) continue
      await this.rebuildIndex(botId)
    }
    return removed
  }

  /**
   * Delete one `(room, bot)` pair's live memory. The pair is the unit the user edits in the UI,
   * so the same primitive serves "forget this room here" without touching the other bots.
   *
   * @returns true when at least one file existed and was deleted.
   */
  async clearPair(roomId: string, botId: string): Promise<boolean> {
    const paths = memoryPaths(this.root, botId, roomId)
    let changed = false
    if (await removeFile(paths.roomFile)) changed = true
    if (await removeFile(paths.overflowFile)) changed = true
    this.cache.delete(paths.roomFile)
    // Same rule as clearRoom: the pair's undo history is dropped with its memory.
    await this.dropJournalRows(botId, row => row.roomId !== roomId)
    if (!changed) return false
    await this.rebuildIndex(botId)
    return true
  }

  /** A permission/cleanup failure is reported, never thrown (see {@link hardenPermissions}). */
  private warn(message: string): void {
    try {
      process.emitWarning(`agent-community: memory: ${message}`)
    } catch {
      // Diagnostics must never be able to break the memory subsystem.
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
      await mkdir(workspace, { recursive: true, mode: DIR_MODE })
      await writeAtomic(path, withLearnedBlock(raw, [...existing, ...added]), { mode: FILE_MODE, dirMode: DIR_MODE })
      return { stored: true, added, path }
    } catch {
      return { stored: false, added: [], path }
    }
  }

  /** Write one partition directly — used by the migration from the old board field. */
  async writePartition(meta: RoomMemoryMeta, entries: readonly BotMemoryEntry[]): Promise<void> {
    const paths = memoryPaths(this.root, meta.botId, meta.roomId)
    await mkdir(dirname(paths.roomFile), { recursive: true, mode: DIR_MODE })
    await writeAtomic(paths.roomFile, renderRoomMemory(meta, entries), { mode: FILE_MODE, dirMode: DIR_MODE })
    this.cache.delete(paths.roomFile)
  }

  /** Entries the store already holds for a pair, for the promotion scan. */
  entriesFor(roomId: string, botId: string): Promise<readonly BotMemoryEntry[]> {
    return this.read(roomId, botId)
  }
}

/** Shape check for one journal line: a corrupt or future row is skipped, never trusted. */
function isJournalRow(value: unknown): value is MemoryJournalRow {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row['id'] === 'string'
    && typeof row['at'] === 'string'
    && typeof row['roomId'] === 'string'
    && typeof row['botId'] === 'string'
    && (row['action'] === 'add' || row['action'] === 'update' || row['action'] === 'remove')
    && typeof row['entryId'] === 'string'
    && (row['before'] === undefined || row['before'] === null || typeof row['before'] === 'string')
    && (row['after'] === undefined || row['after'] === null || typeof row['after'] === 'string')
}

/** The entry's `at`, recovered from a stable id (`"<at>#<hash>"`) when it has that shape. */
function journalEntryAt(entryId: string): string | undefined {
  const hashAt = entryId.indexOf('#')
  if (hashAt <= 0 || hashAt === entryId.length - 1) return undefined
  return entryId.slice(0, hashAt)
}

/**
 * Which entry kind the restored content had.
 *
 * `stableEntryId` hashes kind + at + text, so the kind is recovered by hashing the two
 * candidates; a journal row whose id fits neither (hand-edited file, unknown caller id) falls
 * back to `note`, which is the SAFE kind: a note is never a lifecycle/promotion candidate.
 */
function journalEntryKind(row: MemoryJournalRow, at: string): 'task' | 'note' {
  const text = row.before ?? ''
  for (const kind of ['task', 'note'] as const) {
    if (stableEntryId({ kind, at, text }) === row.entryId) return kind
  }
  return 'note'
}

/** Insert one entry keeping the partition's oldest-first order (ISO timestamps compare as strings). */
function insertByAt(entries: BotMemoryEntry[], entry: BotMemoryEntry): void {
  const at = entries.findIndex(candidate => candidate.at > entry.at)
  entries.splice(at < 0 ? entries.length : at, 0, entry)
}

/** True when the path was an existing file that has now been removed. */
async function removeFile(path: string): Promise<boolean> {
  try {
    await stat(path)
  } catch {
    return false
  }
  try {
    await rm(path, { force: true })
    return true
  } catch {
    return false
  }
}

/** Plain text for a caught error, for the warning line only. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function appendLines(path: string, lines: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    existing = ''
  }
  await writeAtomic(path, `${existing}${lines.join('\n')}\n`, { mode: FILE_MODE, dirMode: DIR_MODE })
}

/** Re-exported so the service does not import the pure module twice. */
export { entriesFor }
