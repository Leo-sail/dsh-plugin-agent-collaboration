/**
 * Storage for the long-lived memory scopes — `bot` (one Bot across every room) and `team`
 * (the whole workspace).
 *
 * The pure module (`memory-scopes.ts`) owns the file format; this module owns the files: read one
 * scope, append/update/remove one entry, keep an append-only undo journal per scope, and undo a
 * journaled change. It mirrors the per-room store (`memory-store.ts`): same `- [at] text` lines,
 * same atomic writes (0600 files / 0700 directories), same "a corrupt journal line is skipped,
 * never fatal" rule, and the same "an undo writes a compensating row, so it can be redone" rule.
 *
 * WHAT IS DELIBERATELY DIFFERENT. Entries are addressed by ARRAY INDEX, not by a content-derived
 * id: the memory panel shows "the 3rd line" and hands that index back to edit/delete/revert. The
 * journal therefore records the index together with the text, and undo falls back to a text
 * search when a trim moved the line — the index alone is not stable across appends that trim.
 *
 * ISOLATION. A `bot` write must always name a botId; a missing/blank id is REFUSED rather than
 * falling back to a shared file, and an id containing a path separator is refused too. `team`
 * writes ignore the target: there is exactly one team file. Every path goes through
 * `scopedMemoryPath`, so the two scopes can never share a file even by accident.
 *
 * ERRORS ARE VALUES. Every method returns its answer instead of throwing: a read that cannot be
 * served is an empty array (same contract as the memory store), a write that cannot be performed
 * is `{ ok: false, error }` with a short Chinese sentence the panel can show verbatim.
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from './atomic.ts'
import { appendScopedEntry, parseScopedMemory, renderScopedMemory, scopedMemoryPath } from './memory-scopes.ts'
import type { ScopedMemoryEntry } from './memory-scopes.ts'

/** The scopes this store writes; the per-room scope keeps its own store (`memory-store.ts`). */
export type ScopedMemoryScope = 'bot' | 'team'

/** One entry as a reader (the memory panel) sees it: the line's position plus its content. */
export interface ScopedEntryView {
  readonly index: number
  readonly text: string
  readonly at?: string | undefined
}

/**
 * One row of a scope's undo journal.
 *
 * The journal is APPEND-ONLY JSONL, one file per bot (`bots/<botId>.journal.jsonl`) and one for
 * the team (`team/journal.jsonl`), mode 0600. It is the undo log for the panel, not a second copy
 * of the memory: `before`/`after` carry only the text of the entry that changed and `index` says
 * where it sat. `before` is null/absent for `add`, `after` is null/absent for `remove`.
 *
 * `target` is the botId for `bot` rows and the literal `team` for `team` rows — the one team file
 * ignores the caller-supplied target, so the row records what it actually wrote to.
 */
export interface ScopedJournalRow {
  readonly id: string
  readonly at: string
  readonly scope: ScopedMemoryScope
  readonly target: string
  readonly action: 'add' | 'update' | 'remove'
  readonly index: number
  /** Entry text before the change; null/absent for add. */
  readonly before?: string | null
  /** Entry text after the change; null/absent for remove. */
  readonly after?: string | null
}

/** What one scope currently holds: its entries and its undo history. */
export interface ScopedMemoryView {
  readonly entries: readonly ScopedEntryView[]
  readonly journal: readonly ScopedJournalRow[]
}

/**
 * Answer of {@link MemoryScopeStore.append}.
 *
 * A discriminated union on purpose: `ok:true` always carries the new entry list (so a caller can
 * refresh its mirror without a second read), and `ok:false` always carries the reason — a success
 * without entries or a failure without an error is not representable.
 */
export type ScopedWriteResult =
  | { readonly ok: true; readonly entries: readonly ScopedEntryView[] }
  | { readonly ok: false; readonly error: string }

/**
 * Answer of update / remove / revert: success, or the user-facing Chinese reason it failed.
 *
 * A journal failure after a successful memory write is still `ok:false` (the edit is not
 * undoable), and the message says the memory itself was written — see the methods' doc comments.
 */
export type ScopedMutationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** Two private modes shared by every scope artefact (memory is user/private text on disk). */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** Concrete file locations for one scope; `target` is the botId or the literal `team`. */
interface ScopePaths {
  readonly scope: ScopedMemoryScope
  readonly target: string
  readonly file: string
  readonly journalFile: string
}

type Resolution = { readonly ok: true; readonly paths: ScopePaths } | { readonly ok: false; readonly error: string }

/** Why a body of text is being journaled; the public method fills in the rest of the row. */
interface JournalChange {
  readonly action: ScopedJournalRow['action']
  readonly index: number
  readonly before: string | null
  readonly after: string | null
}

/**
 * Resolve one scope to its files, or explain why the request is not allowed.
 *
 * A `team` request resolves to the single team file whatever target the caller passed. A `bot`
 * request without a botId is refused — silently sharing one bot's memory with every bot is the
 * exact isolation failure this feature exists to prevent. A botId with a path separator is
 * refused for the same reason: `../team` must never be able to name another scope's file.
 */
function resolveScope(root: string, scope: ScopedMemoryScope, target: string | undefined): Resolution {
  try {
    if (scope === 'team') {
      return {
        ok: true,
        paths: {
          scope: 'team',
          target: 'team',
          file: scopedMemoryPath('team', { root }),
          journalFile: join(root, 'team', 'journal.jsonl'),
        },
      }
    }
    if (scope !== 'bot') return { ok: false, error: `未知的记忆作用域「${String(scope)}」。` }
    const botId = typeof target === 'string' ? target.trim() : ''
    if (botId === '') return { ok: false, error: 'Bot 作用域必须指定 botId，已拒绝写入以免串到共享文件。' }
    if (botId === '.' || botId === '..' || botId.includes('/') || botId.includes('\\')) {
      return { ok: false, error: 'botId 不能是路径片段，已拒绝写入。' }
    }
    return {
      ok: true,
      paths: {
        scope: 'bot',
        target: botId,
        file: scopedMemoryPath('bot', { root, botId }),
        journalFile: join(root, 'bots', `${botId}.journal.jsonl`),
      },
    }
  } catch (error: unknown) {
    return { ok: false, error: `记忆路径解析失败：${errorText(error)}` }
  }
}

/** Normalise the append cap: a finite non-negative integer, otherwise "keep nothing". */
function entryLimit(maxEntries: number): number {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) return 0
  return Math.floor(maxEntries)
}

/** Views carry the array position, which is the handle the panel edits/deletes by. */
function toViews(entries: readonly ScopedMemoryEntry[]): ScopedEntryView[] {
  return entries.map((entry, index) => ({
    index,
    text: entry.text,
    ...(entry.at !== undefined ? { at: entry.at } : {}),
  }))
}

/**
 * Locate the entry a journal row is about.
 *
 * The recorded index is tried first; when a trim or a hand edit moved the line, the same text is
 * looked up instead, from the END for `add` (the appended duplicate is the newest row) and from
 * the START for `update`. `-1` means "already gone", which callers treat as an idempotent no-op.
 */
function findEntryIndex(
  entries: readonly ScopedMemoryEntry[],
  index: number,
  text: string,
  direction: 'first' | 'last',
): number {
  if (Number.isInteger(index) && index >= 0 && index < entries.length && entries[index]!.text === text) return index
  if (direction === 'last') {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]!.text === text) return i
    }
    return -1
  }
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i]!.text === text) return i
  }
  return -1
}

/**
 * File-backed storage for the `bot` and `team` scopes.
 *
 * One instance serves a whole memory root (`<home>/agent-community/memory`); there is no
 * constructor I/O, so a fresh instance can be built anywhere a root is known. Reads never throw
 * (a corrupt/missing file is an empty scope); writes report failures instead of pretending the
 * memory was saved.
 */
export class MemoryScopeStore {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  /** One Bot's long-term entries, oldest first. Empty when it has never recorded anything. */
  async readBot(botId: string): Promise<ScopedEntryView[]> {
    const resolution = resolveScope(this.root, 'bot', botId)
    if (!resolution.ok) return []
    return toViews(await this.readEntriesAt(resolution.paths))
  }

  /** The team's entries, oldest first. Empty when the team file is missing or corrupt. */
  async readTeam(): Promise<ScopedEntryView[]> {
    const resolution = resolveScope(this.root, 'team', undefined)
    if (!resolution.ok) return []
    return toViews(await this.readEntriesAt(resolution.paths))
  }

  /**
   * Every Bot that has a long-term file, keyed by botId.
   *
   * Only `bots/*.md` is data: journal files (`.jsonl`), atomic-write temps (`*.tmp-*`) and any
   * other file a human dropped in are skipped. A missing directory is an empty map, not an error.
   */
  async loadAllBots(): Promise<Map<string, ScopedEntryView[]>> {
    const out = new Map<string, ScopedEntryView[]>()
    let botIds: string[]
    try {
      const items = await readdir(join(this.root, 'bots'), { withFileTypes: true })
      botIds = items
        .filter(item => item.isFile() && item.name.length > 3 && item.name.endsWith('.md'))
        .map(item => item.name.slice(0, -3))
        .sort()
    } catch {
      return out
    }
    for (const botId of botIds) {
      const resolution = resolveScope(this.root, 'bot', botId)
      if (!resolution.ok) continue
      out.set(botId, toViews(await this.readEntriesAt(resolution.paths)))
    }
    return out
  }

  /**
   * Append one entry to one scope, keeping the newest `maxEntries` entries.
   *
   * Empty text is refused (a blank line parses back as nothing, so "forget" is `remove`, not an
   * empty append). After the memory write succeeds the add is journaled with the PRE-write length
   * as its index, so {@link revert} can delete the right line even after a trim. A journal write
   * failure does not fail the append — the memory is the authoritative artefact (the same choice
   * `memory-store.append` makes); it is only reported as a warning.
   */
  async append(
    scope: ScopedMemoryScope,
    target: string | undefined,
    entry: ScopedMemoryEntry,
    maxEntries: number,
  ): Promise<ScopedWriteResult> {
    const resolution = resolveScope(this.root, scope, target)
    if (!resolution.ok) return resolution
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (text === '') return { ok: false, error: '记忆内容不能为空。' }
    const at = typeof entry.at === 'string' && entry.at.trim() !== '' ? entry.at.trim() : undefined
    const cleanEntry: ScopedMemoryEntry = at === undefined ? { text } : { text, at }
    try {
      const before = await this.readEntriesAt(resolution.paths)
      const next = appendScopedEntry(before, cleanEntry, entryLimit(maxEntries))
      await writeFileAtomic(resolution.paths.file, renderScopedMemory(resolution.paths.scope, next), {
        mode: FILE_MODE,
        dirMode: DIR_MODE,
      })
      try {
        await this.appendJournal(resolution.paths, {
          action: 'add',
          index: before.length,
          before: null,
          after: text,
        })
      } catch (error: unknown) {
        this.warn(`could not journal an added scoped entry: ${errorText(error)}`)
      }
      return { ok: true, entries: toViews(next) }
    } catch (error: unknown) {
      return { ok: false, error: `记忆写入失败：${errorText(error)}` }
    }
  }

  /**
   * Replace one entry's text, keeping its `at`.
   *
   * The index is the handle: it must address an existing line. Editing to the same text is a
   * success no-op and is not journaled (an undo row for a change that did not happen would make
   * the panel's undo list lie). A journal write failure after a successful edit is REPORTED,
   * because the edit would otherwise look undoable when it is not.
   */
  async update(
    scope: ScopedMemoryScope,
    target: string | undefined,
    index: number,
    text: string,
  ): Promise<ScopedMutationResult> {
    const resolution = resolveScope(this.root, scope, target)
    if (!resolution.ok) return resolution
    const clean = typeof text === 'string' ? text.trim() : ''
    if (clean === '') return { ok: false, error: '记忆内容不能为空。' }
    if (!Number.isInteger(index) || index < 0) return { ok: false, error: '记忆条目索引无效。' }
    try {
      const entries = await this.readEntriesAt(resolution.paths)
      const before = entries[index]
      if (before === undefined) return { ok: false, error: '记忆条目不存在。' }
      if (before.text === clean) return { ok: true }
      const next = entries.map((entry, position) => position === index
        ? { text: clean, ...(entry.at !== undefined ? { at: entry.at } : {}) }
        : entry)
      await this.writeEntries(resolution.paths, next)
      try {
        await this.appendJournal(resolution.paths, {
          action: 'update',
          index,
          before: before.text,
          after: clean,
        })
      } catch (error: unknown) {
        return { ok: false, error: `记忆已更新，但撤销记录写入失败：${errorText(error)}` }
      }
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, error: `记忆写入失败：${errorText(error)}` }
    }
  }

  /**
   * Delete one entry and journal its text, so {@link revert} can put it back.
   *
   * The out-of-range answer is the panel's "this line moved, reload" signal. Like
   * {@link update}, a journal failure after a successful delete is reported: losing the audit row
   * silently would make the delete look undoable when it is not.
   */
  async remove(scope: ScopedMemoryScope, target: string | undefined, index: number): Promise<ScopedMutationResult> {
    const resolution = resolveScope(this.root, scope, target)
    if (!resolution.ok) return resolution
    if (!Number.isInteger(index) || index < 0) return { ok: false, error: '记忆条目索引无效。' }
    try {
      const entries = await this.readEntriesAt(resolution.paths)
      const removed = entries[index]
      if (removed === undefined) return { ok: false, error: '记忆条目不存在。' }
      const next = [...entries.slice(0, index), ...entries.slice(index + 1)]
      await this.writeEntries(resolution.paths, next)
      try {
        await this.appendJournal(resolution.paths, {
          action: 'remove',
          index,
          before: removed.text,
          after: null,
        })
      } catch (error: unknown) {
        return { ok: false, error: `记忆已删除，但撤销记录写入失败：${errorText(error)}` }
      }
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, error: `记忆写入失败：${errorText(error)}` }
    }
  }

  /**
   * One scope's undo rows, oldest first.
   *
   * The file is append-only; a half-written tail (a crash) or any corrupt line a human left is
   * SKIPPED rather than fatal. Rows are also checked against the scope and target, so a stray row
   * can never make one scope's history visible in another.
   */
  async journal(scope: ScopedMemoryScope, target: string | undefined): Promise<readonly ScopedJournalRow[]> {
    const resolution = resolveScope(this.root, scope, target)
    if (!resolution.ok) return []
    return this.readJournalAt(resolution.paths)
  }

  /**
   * Undo one journal row, and journal the undo as a compensating row so it can be redone.
   *
   * The inverse follows the action: an `add` is deleted; an `update` gets its `before` text back;
   * a `remove` is re-inserted at its recorded index (an entry has no id here, so a restored line
   * comes back with its text and position but without its `at` — the journal records text only).
   * The compensating row has the INVERSE action and carries before/after the other way round, so
   * feeding it to this method again toggles the change — including after a reload.
   *
   * IDEMPOTENT: when the entry the row refers to is already gone or already in the target state
   * (a second call, a hand-edited file) this returns `ok:true` without writing a row. An unknown
   * journal id is a refusal, because there is nothing to invert.
   */
  async revert(
    scope: ScopedMemoryScope,
    target: string | undefined,
    journalId: string,
  ): Promise<ScopedMutationResult> {
    const resolution = resolveScope(this.root, scope, target)
    if (!resolution.ok) return resolution
    const id = typeof journalId === 'string' ? journalId.trim() : ''
    if (id === '') return { ok: false, error: '撤销记录不存在。' }
    try {
      const row = (await this.readJournalAt(resolution.paths)).find(candidate => candidate.id === id)
      if (row === undefined) return { ok: false, error: '撤销记录不存在。' }
      const entries = await this.readEntriesAt(resolution.paths)
      if (row.action === 'add') {
        const text = row.after ?? ''
        if (text === '') return { ok: true }
        const index = findEntryIndex(entries, row.index, text, 'last')
        if (index < 0) return { ok: true } // already reverted (or the file was hand-edited)
        const next = [...entries.slice(0, index), ...entries.slice(index + 1)]
        await this.writeEntries(resolution.paths, next)
        return await this.journalCompensation(resolution.paths, {
          action: 'remove',
          index,
          before: text,
          after: null,
        })
      }
      if (row.action === 'update') {
        const after = row.after ?? ''
        const before = row.before ?? ''
        if (after === '' || before === '') return { ok: true }
        const index = findEntryIndex(entries, row.index, after, 'first')
        if (index < 0) return { ok: true }
        const next = entries.map((entry, position) => position === index
          ? { text: before, ...(entry.at !== undefined ? { at: entry.at } : {}) }
          : entry)
        await this.writeEntries(resolution.paths, next)
        return await this.journalCompensation(resolution.paths, {
          action: 'update',
          index,
          before: after,
          after: before,
        })
      }
      // remove: put the line back where it was. Same text anywhere already counts as restored.
      const text = row.before ?? ''
      if (text === '') return { ok: true }
      if (entries.some(entry => entry.text === text)) return { ok: true }
      const index = Number.isInteger(row.index) && row.index >= 0 && row.index <= entries.length
        ? row.index
        : entries.length
      const next = [...entries.slice(0, index), { text }, ...entries.slice(index)]
      await this.writeEntries(resolution.paths, next)
      return await this.journalCompensation(resolution.paths, {
        action: 'add',
        index,
        before: null,
        after: text,
      })
    } catch (error: unknown) {
      return { ok: false, error: `记忆撤销失败：${errorText(error)}` }
    }
  }

  /** Write one compensating row after a successful revert; a failure is reported, not hidden. */
  private async journalCompensation(paths: ScopePaths, change: JournalChange): Promise<ScopedMutationResult> {
    try {
      await this.appendJournal(paths, change)
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, error: `记忆已撤销，但撤销记录写入失败：${errorText(error)}` }
    }
  }

  /** The scope's entries; a missing or unreadable file is an empty scope (read contract). */
  private async readEntriesAt(paths: ScopePaths): Promise<ScopedMemoryEntry[]> {
    try {
      return parseScopedMemory(await readFile(paths.file, 'utf8'))
    } catch {
      return []
    }
  }

  /** Render and atomically replace the scope file (0600, directory 0700). */
  private async writeEntries(paths: ScopePaths, entries: readonly ScopedMemoryEntry[]): Promise<void> {
    await writeFileAtomic(paths.file, renderScopedMemory(paths.scope, entries), { mode: FILE_MODE, dirMode: DIR_MODE })
  }

  /** Append one JSONL row (O_APPEND); throws so the caller decides whether that is fatal. */
  private async appendJournal(paths: ScopePaths, change: JournalChange): Promise<void> {
    const row: ScopedJournalRow = {
      id: randomUUID(),
      at: new Date().toISOString(),
      scope: paths.scope,
      target: paths.target,
      action: change.action,
      index: change.index,
      before: change.before,
      after: change.after,
    }
    // APPEND, not read-modify-write: a crash leaves at most a half line (which `journal` skips),
    // and two writers cannot erase each other's rows the way a whole-file rewrite would.
    await mkdir(dirname(paths.journalFile), { recursive: true, mode: DIR_MODE })
    await appendFile(paths.journalFile, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: FILE_MODE })
    // A journal created by an older build keeps its own mode; tighten it on every write.
    await chmod(paths.journalFile, FILE_MODE).catch(() => undefined)
  }

  /** A scope's journal rows, skipping corrupt/half-written lines and foreign rows. */
  private async readJournalAt(paths: ScopePaths): Promise<ScopedJournalRow[]> {
    let text: string
    try {
      text = await readFile(paths.journalFile, 'utf8')
    } catch {
      return []
    }
    const rows: ScopedJournalRow[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let value: unknown
      try {
        value = JSON.parse(trimmed)
      } catch {
        continue // a half-written tail is not data
      }
      if (!isScopedJournalRow(value)) continue
      if (value.scope !== paths.scope || value.target !== paths.target) continue
      rows.push(value)
    }
    return rows
  }

  /** A journal/cleanup failure is reported, never thrown. */
  private warn(message: string): void {
    try {
      process.emitWarning(`agent-community: memory scopes: ${message}`)
    } catch {
      // Diagnostics must never be able to break the memory subsystem.
    }
  }
}

/** Shape check for one journal line: a corrupt or future row is skipped, never trusted. */
function isScopedJournalRow(value: unknown): value is ScopedJournalRow {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row['id'] === 'string'
    && typeof row['at'] === 'string'
    && (row['scope'] === 'bot' || row['scope'] === 'team')
    && typeof row['target'] === 'string'
    && (row['action'] === 'add' || row['action'] === 'update' || row['action'] === 'remove')
    && typeof row['index'] === 'number'
    && Number.isInteger(row['index'])
    && (row['before'] === undefined || row['before'] === null || typeof row['before'] === 'string')
    && (row['after'] === undefined || row['after'] === null || typeof row['after'] === 'string')
}

/** Plain text for a caught error, for the user-facing/error-log line only. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
