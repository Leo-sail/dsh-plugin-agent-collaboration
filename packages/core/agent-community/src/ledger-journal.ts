/**
 * ledger-journal.ts — the durable, per-room append journal for the ledger (P4).
 *
 * WHY THIS EXISTS. The ledger (`ledger.ts`) is an in-memory projection: it is rebuilt from
 * `state.json` messages on startup, which means everything that never became a message —
 * reasoning blocks, tool traffic, round lifecycle, deliverable cards, approvals — and every turn
 * that died between two state saves is lost on restart. This store is the crash-safe source for
 * those rows:
 *
 *   · `<root>/<roomId>.jsonl`, one {@link LedgerJournalRecord} per line, APPEND-ONLY. A push
 *     writes the finished row once; a patch writes only the changed fields, so a streaming reply
 *     that patches its row 200 times costs 200 small lines, not 200 copies of the row;
 *   · `loadAll()` replays every room in file order and returns the FINAL rows, sorted by
 *     `sequence` then `at`; a room whose history was cleared replays as an empty list;
 *   · `compact()` rewrites a room to one push-line per final row, and is how a busy room stops
 *     growing without bound after the startup replay.
 *
 * FAILURE POLICY (the journal must never break a conversation or a startup):
 *
 *   · every method returns a value — no IO error escapes as an exception;
 *   · a bad LINE is skipped and reported through `onCorrupt`, while the good lines still replay;
 *   · a torn LAST line (a crash mid-append, so it has no newline) is skipped SILENTLY: that is the
 *     normal shape of an interrupted append, not damage;
 *   · a file whose complete content yields no usable record at all is renamed to
 *     `<name>.corrupt-<timestamp>` and skipped, so the bytes are kept for a human but the room
 *     starts empty instead of loading garbage forever;
 *   · each room's writes are serialised behind its own Promise chain, so two appends can never
 *     interleave inside one line; different rooms still write in parallel.
 *
 * ACCESS CONTROL: `roomId` becomes a filename, so it is validated as a bare name — empty, path
 * separators, `..` and NUL are refused with `{ok:false,error:'非法房间 id'}`; `loadAll`/`listRooms`
 * skip such files (and `loadAll` reports them). The journal under-pins the same 0600/0700 modes the
 * rest of the plugin's private state uses.
 *
 * @module
 */
import { appendFile, chmod, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic.ts'
import type { LedgerEntry, LedgerJournalRecord } from './ledger.ts'

/** The journal file suffix and the quarantine suffix (`<name>.corrupt-<ISO>`). */
const FILE_SUFFIX = '.jsonl'
const CORRUPT_SUFFIX = '.corrupt-'

/** Private-by-default modes: the journal holds the room's raw reasoning/tool traffic. */
const DEFAULT_DIR_MODE = 0o700
const DEFAULT_FILE_MODE = 0o600

/** Options for {@link LedgerJournalStore}; every field has a safe default. */
export interface LedgerJournalStoreOptions {
  /** Called for a quarantined file or a skipped line/patch; omit to stay silent. */
  readonly onCorrupt?: ((path: string, reason: string) => void) | undefined
  /** Mode for the journal directory. Defaults to 0o700. */
  readonly dirMode?: number | undefined
  /** Mode for journal files. Defaults to 0o600. */
  readonly fileMode?: number | undefined
}

/** `ok`, or a reason a caller can log; never an exception. */
export type LedgerJournalResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/**
 * One per plugin data home. The service constructs it before the projector (so the projector's
 * journal sink can reference it), calls {@link loadAll} once at startup and `compact`s after the
 * replay; append is fire-and-forget from the projection's point of view.
 */
export class LedgerJournalStore {
  private readonly root: string
  private readonly dirMode: number
  private readonly fileMode: number
  private readonly onCorrupt: ((path: string, reason: string) => void) | undefined
  /** Per-room Promise tail: appends/compactions/removals of ONE room never interleave. */
  private readonly chains = new Map<string, Promise<void>>()
  /** Rooms whose file has already been re-moded in this process (append is a hot path). */
  private readonly hardened = new Set<string>()

  constructor(root: string, options: LedgerJournalStoreOptions = {}) {
    this.root = root
    this.dirMode = options.dirMode ?? DEFAULT_DIR_MODE
    this.fileMode = options.fileMode ?? DEFAULT_FILE_MODE
    this.onCorrupt = options.onCorrupt
  }

  /**
   * Replay every room's journal into its final rows.
   *
   * A missing directory is an empty map. Bad lines are skipped (and reported), a torn last line is
   * skipped silently, and a completely unreadable document is quarantined. Rooms whose replayed
   * list is empty are NOT included: a file with no valid record carries no rows to restore.
   */
  async loadAll(): Promise<Map<string, LedgerEntry[]>> {
    const replayed = new Map<string, LedgerEntry[]>()
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        this.reportCorrupt(this.root, `无法读取日志目录：${errorText(error)}。`)
      }
      return replayed
    }
    // Stable room order makes a restart's logs and replays reproducible.
    for (const name of [...names].sort()) {
      if (!name.endsWith(FILE_SUFFIX)) continue
      const roomId = name.slice(0, -FILE_SUFFIX.length)
      if (!isValidRoomId(roomId)) {
        this.reportCorrupt(join(this.root, name), '日志文件名不是合法的房间 id，已跳过。')
        continue
      }
      const path = this.filePath(roomId)
      const raw = await this.readRoomFile(path)
      if (raw === undefined) continue
      const rows = await this.replayRoom(roomId, path, raw)
      if (rows !== undefined) replayed.set(roomId, rows)
    }
    return replayed
  }

  /**
   * Append one journal record as a single JSON line. The write is serialised per room; failures
   * (invalid room id/record, IO) come back as `{ok:false,error}` and never throw.
   */
  async append(record: LedgerJournalRecord): Promise<LedgerJournalResult> {
    if (!isValidRoomId(record.roomId)) return { ok: false, error: '非法房间 id' }
    if (!isJournalRecordShape(record)) return { ok: false, error: '非法日志记录' }
    let line: string
    try {
      // Serialise NOW (a snapshot), so the bytes written match the call even if the caller
      // reuses its object while the queued write is waiting for its turn.
      line = `${JSON.stringify(record)}\n`
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) }
    }
    const roomId = record.roomId
    const path = this.filePath(roomId)
    return this.enqueue(roomId, async () => {
      try {
        await mkdir(this.root, { recursive: true, mode: this.dirMode })
        // O_APPEND: a crash can tear at most the tail line, never rewrite earlier records.
        await appendFile(path, line, { encoding: 'utf8', mode: this.fileMode })
        await this.hardenOnce(roomId, path)
        return { ok: true }
      } catch (error: unknown) {
        return { ok: false, error: errorText(error) }
      }
    })
  }

  /**
   * Atomically rewrite one room's journal as one push-line per final row.
   *
   * Used by the startup compaction: the append log keeps every patch for ever, so after a replay
   * it is replaced by the rows a fresh replay would reconstruct anyway. An empty list writes an
   * empty file (the room keeps its journal) instead of deleting it. The caller's list is never
   * mutated.
   */
  async compact(roomId: string, entries: readonly LedgerEntry[]): Promise<LedgerJournalResult> {
    const invalid = this.invalidRoom(roomId)
    if (invalid !== undefined) return invalid
    let content: string
    try {
      let parts = ''
      for (const entry of entries) {
        const record: LedgerJournalRecord = { v: 1, op: 'push', roomId, entry }
        parts += `${JSON.stringify(record)}\n`
      }
      content = parts
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) }
    }
    return this.enqueue(roomId, async () => {
      try {
        // Temp file + rename: a crash mid-compaction leaves the old journal intact.
        await writeFileAtomic(this.filePath(roomId), content, { mode: this.fileMode, dirMode: this.dirMode })
        this.hardened.add(roomId)
        return { ok: true }
      } catch (error: unknown) {
        return { ok: false, error: errorText(error) }
      }
    })
  }

  /** Existing journal room ids, sorted; a missing directory is empty. */
  async listRooms(): Promise<string[]> {
    let items: Dirent[]
    try {
      items = await readdir(this.root, { withFileTypes: true })
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        this.reportCorrupt(this.root, `无法读取日志目录：${errorText(error)}。`)
      }
      return []
    }
    const rooms: string[] = []
    for (const item of items) {
      if (!item.isFile() || !item.name.endsWith(FILE_SUFFIX)) continue
      const roomId = item.name.slice(0, -FILE_SUFFIX.length)
      if (isValidRoomId(roomId)) rooms.push(roomId)
    }
    return rooms.sort()
  }

  /** Delete one room's journal. IDEMPOTENT: a room without a journal is still `{ok:true}`. */
  async remove(roomId: string): Promise<LedgerJournalResult> {
    const invalid = this.invalidRoom(roomId)
    if (invalid !== undefined) return invalid
    return this.enqueue(roomId, async () => {
      try {
        await rm(this.filePath(roomId), { force: true })
        return { ok: true }
      } catch (error: unknown) {
        return { ok: false, error: errorText(error) }
      }
    })
  }

  /** Path of one room's journal (safe after {@link isValidRoomId}); pure. */
  private filePath(roomId: string): string {
    return join(this.root, `${roomId}${FILE_SUFFIX}`)
  }

  /** `{ok:false}` for an illegal room id, `undefined` when the id may be used as a filename. */
  private invalidRoom(roomId: string): LedgerJournalResult | undefined {
    return isValidRoomId(roomId) ? undefined : { ok: false, error: '非法房间 id' }
  }

  /** Read one journal file; a missing file is not an error, any other read failure is reported. */
  private async readRoomFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8')
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        this.reportCorrupt(path, `无法读取日志文件：${errorText(error)}。`)
      }
      return undefined
    }
  }

  /**
   * Replay one file into final rows, or `undefined` when it yields no room state at all.
   *
   * Replay order is FILE order (that is what a log means); the returned rows are sorted for
   * readers by `sequence` then `at` (stable for exact ties).
   */
  private async replayRoom(roomId: string, path: string, raw: string): Promise<LedgerEntry[] | undefined> {
    const lines = raw.split('\n')
    const endsWithNewline = raw.endsWith('\n')
    const records: LedgerJournalRecord[] = []
    const badLines: number[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      if (line.trim() === '') continue
      const record = parseJournalRecord(line.trim())
      if (record === undefined) {
        // A torn FINAL line (crash mid-append) has no newline: that is the expected shape after an
        // interrupted append, so it is skipped silently. Any other bad line is reported.
        if (index === lines.length - 1 && !endsWithNewline) continue
        badLines.push(index + 1)
        continue
      }
      if (record.roomId !== roomId) {
        badLines.push(index + 1)
        continue
      }
      records.push(record)
    }
    if (records.length === 0 && raw.trim() !== '') {
      // Nothing usable at all. A complete (newline-terminated, or multi-line) document is damage:
      // quarantine it once so the bytes are kept and the room starts empty. A lone un-terminated
      // line is the torn-first-append case and is left alone.
      if (!endsWithNewline && lines.length === 1) return undefined
      const target = await this.quarantine(path)
      this.reportCorrupt(
        path,
        target === undefined
          ? '整份日志无法解析，且无法隔离，已跳过。'
          : `整份日志无法解析，已隔离为 ${target}。`,
      )
      return undefined
    }
    for (const line of badLines) {
      this.reportCorrupt(path, `第 ${line} 行不是有效日志记录，已跳过。`)
    }
    const rows = new Map<string, LedgerEntry>()
    for (const record of records) {
      if (record.op === 'push') {
        rows.set(record.entry.id, record.entry)
        continue
      }
      if (record.op === 'clear') {
        rows.clear()
        continue
      }
      const current = rows.get(record.id)
      if (current === undefined) {
        this.reportCorrupt(path, `patch 找不到 id ${record.id}，已跳过。`)
        continue
      }
      rows.set(record.id, { ...current, ...record.patch } as LedgerEntry)
    }
    if (records.length === 0) return undefined
    return sortEntries(rows.values())
  }

  /** Rename a damaged file to `<name>.corrupt-<ISO>`; returns the new path, or undefined. */
  private async quarantine(path: string): Promise<string | undefined> {
    const target = `${path}${CORRUPT_SUFFIX}${fileStamp()}`
    try {
      await rename(path, target)
      return target
    } catch {
      return undefined
    }
  }

  /** Tighten a legacy/pre-existing journal to `fileMode` once per room per process. */
  private async hardenOnce(roomId: string, path: string): Promise<void> {
    if (this.hardened.has(roomId)) return
    this.hardened.add(roomId)
    try {
      await chmod(path, this.fileMode)
    } catch {
      // Best-effort: the write already happened; a mode failure is a warning-level concern.
    }
  }

  /** Run `operation` after every queued operation for THIS room, never concurrently with one. */
  private enqueue<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(roomId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.chains.set(roomId, tail)
    // Drop the chain once this room is quiet so the map does not grow with every room ever seen.
    void tail.then(() => {
      if (this.chains.get(roomId) === tail) this.chains.delete(roomId)
    })
    return result
  }

  /** Diagnostics only: a throwing callback must never break a load or a write. */
  private reportCorrupt(path: string, reason: string): void {
    try {
      this.onCorrupt?.(path, reason)
    } catch {
      // Ignore: the callback is for logging.
    }
  }
}

/**
 * Parse one line as a journal record; `undefined` for invalid JSON or a record that is not ours.
 *
 * The shape check is real: a journal on disk can be hand-edited or torn, so a record is trusted
 * only when it has `v:1`, a room id, and the payload its op needs. The rest of a push entry is
 * accepted as-is (it is the projector's own row) — only the fields replay and sorting need are
 * checked, so future entry fields survive an older reader.
 */
function parseJournalRecord(line: string): LedgerJournalRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    return undefined
  }
  return isJournalRecordShape(value) ? value : undefined
}

/** Runtime shape check for a journal record read from (or about to be written to) disk. */
function isJournalRecordShape(value: unknown): value is LedgerJournalRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record['v'] !== 1) return false
  if (typeof record['roomId'] !== 'string' || record['roomId'] === '') return false
  const op = record['op']
  if (op === 'clear') return true
  if (op === 'push') return isLedgerEntryShape(record['entry'])
  if (op === 'patch') {
    return typeof record['id'] === 'string'
      && record['id'] !== ''
      && isPlainObject(record['patch'])
  }
  return false
}

/** The fields replay needs from an entry: a missing id/roomId/sequence means "skip this line". */
function isLedgerEntryShape(value: unknown): value is LedgerEntry {
  if (!isPlainObject(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry['id'] === 'string'
    && entry['id'] !== ''
    && typeof entry['roomId'] === 'string'
    && typeof entry['sequence'] === 'number'
    && Number.isFinite(entry['sequence'])
}

/** A JSON object (the shape a `patch` payload must have). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Reading order: ascending `sequence`, then ascending `at`.
 *
 * `sequence` is the projector's per-room counter and is what the panel orders by; `at` breaks
 * ties so two rows that share a sequence (a hydration/counter reset) still replay in time order.
 * `Array#sort` is stable, so rows identical on both keys keep their file order.
 */
function sortEntries(entries: Iterable<LedgerEntry>): LedgerEntry[] {
  return [...entries].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence
    const leftAt = typeof left.at === 'string' ? left.at : ''
    const rightAt = typeof right.at === 'string' ? right.at : ''
    if (leftAt === rightAt) return 0
    return leftAt < rightAt ? -1 : 1
  })
}

/**
 * A room id is used as a bare filename: no empty string, no path separators, no `..`, no NUL.
 * Everything else (dashes, dots inside the name) is a legitimate id and is left alone.
 */
function isValidRoomId(roomId: unknown): roomId is string {
  if (typeof roomId !== 'string' || roomId === '') return false
  if (roomId.includes('/') || roomId.includes('\\') || roomId.includes('..')) return false
  if (roomId.includes('\u0000')) return false
  return true
}

/** A filename-safe timestamp for a quarantined file (`:` is illegal in Windows paths). */
function fileStamp(): string {
  return new Date().toISOString().replace(/[.:]/gu, '-')
}

/** The `code` of a caught Node fs error, when it has one. */
function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Plain text for a caught error, for a result or a corrupt-callback reason. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
