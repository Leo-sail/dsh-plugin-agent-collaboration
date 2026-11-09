/**
 * knowledge-store.ts — room/team Markdown knowledge on disk (P5-2, storage slice only).
 *
 * WHY THIS EXISTS. A Bot needs shared knowledge that outlives one conversation: how this room
 * works, what the team agreed on. The minimal version the user asked for is deliberately boring —
 * one Markdown file per room or team, human-editable, injected into the prompt by the caller. No
 * vector index, no retrieval, no second source of truth: the file IS the knowledge.
 *
 * LAYOUT (root defaults to `<home>/agent-community/knowledge`):
 *
 *   <root>/rooms/<roomId>.md
 *   <root>/teams/<teamId>.md
 *
 * THE RULES THE PROMPT/UI PATH RELIES ON
 *   · files are private: 0600 in a 0700 directory (knowledge quotes user text verbatim);
 *   · a write is all-or-nothing (`writeFileAtomic`: temp file + rename), so a reader never sees a
 *     half-written document;
 *   · writes are NORMALISED (CRLF → LF, trailing whitespace removed, exactly one final newline), so
 *     a deterministic file is what the diff/UI shows and what the reader gets back;
 *   · a file larger than `maxChars` (default 65536, measured on the caller's text before
 *     normalisation) is REFUSED with a Chinese reason — a prompt fragment must stay bounded;
 *   · empty knowledge is NOT knowledge: a file whose text is blank after `trimEnd()` reads as
 *     `undefined`, so the caller omits the prompt section instead of injecting an empty heading;
 *     the empty document itself is kept on disk (the write path is not a delete path);
 *   · an id is a FILENAME, so empty ids and path separators / `..` / NUL are refused at every
 *     entry point. `pathFor` answers undefined for them, and no method may ever resolve outside
 *     `<root>`.
 *
 * NO METHOD THROWS AT THE CALLER. The constructor does no I/O; a missing directory/file is an
 * empty value (the first use is not damage); an unreadable file is reported through `onCorrupt`
 * and skipped; write/remove failures come back as `{ok:false,error}`. Knowledge is a convenience,
 * never a turn-breaking dependency.
 *
 * @module
 */
import { chmod, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from './atomic.ts'

/** A knowledge file names rooms/teams and quotes user text — private by construction. */
const DEFAULT_FILE_MODE = 0o600
const DEFAULT_DIR_MODE = 0o700

/** One knowledge file may not exceed this many characters unless the caller says otherwise. */
const DEFAULT_MAX_CHARS = 65_536

/** Which directory a file belongs to. */
type KnowledgeKind = 'room' | 'team'

/** Options for {@link KnowledgeStore}. */
export interface KnowledgeStoreOptions {
  /** 损坏/不可读文件回调（用于日志）；不传则静默返回 undefined。 */
  readonly onCorrupt?: ((path: string, reason: string) => void) | undefined
  /** 目录权限（默认 0o700）。 */
  readonly dirMode?: number | undefined
  /** 文件权限（默认 0o600）。 */
  readonly fileMode?: number | undefined
  /** 单文件字符上限，默认 65536；超限返回 {ok:false,error}。 */
  readonly maxChars?: number | undefined
}

/** Outcome of a write/remove: the stored size in characters, or why nothing was stored. */
export type KnowledgeWriteResult =
  | { readonly ok: true; readonly chars: number }
  | { readonly ok: false; readonly error: string }

/**
 * File-backed room/team knowledge.
 *
 * One instance serves one knowledge root; there is no cache, so two instances (or two processes)
 * always see the file on disk. Reads never throw (missing = empty, unreadable = `onCorrupt` +
 * undefined); mutations report failures instead of rejecting.
 */
export class KnowledgeStore {
  private readonly root: string
  private readonly onCorrupt: ((path: string, reason: string) => void) | undefined
  private readonly dirMode: number
  private readonly fileMode: number
  private readonly maxChars: number

  constructor(root: string, options: KnowledgeStoreOptions = {}) {
    this.root = root
    this.onCorrupt = options.onCorrupt
    this.dirMode = options.dirMode ?? DEFAULT_DIR_MODE
    this.fileMode = options.fileMode ?? DEFAULT_FILE_MODE
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  }

  /** Room knowledge: `<root>/rooms/<roomId>.md`; missing/blank/illegal id → undefined. */
  async readRoom(roomId: string): Promise<string | undefined> {
    return this.read('room', roomId)
  }

  /** Replace a room's knowledge file. Blank text is a legitimate empty document, not a delete. */
  async writeRoom(roomId: string, content: string): Promise<KnowledgeWriteResult> {
    return this.write('room', roomId, content)
  }

  /** Delete a room's knowledge file; idempotent (already gone is still ok). */
  async removeRoom(roomId: string): Promise<KnowledgeWriteResult> {
    return this.remove('room', roomId)
  }

  /** Team knowledge: `<root>/teams/<teamId>.md`; missing/blank/illegal id → undefined. */
  async readTeam(teamId: string): Promise<string | undefined> {
    return this.read('team', teamId)
  }

  /** Replace a team's knowledge file. Same contract as {@link writeRoom}. */
  async writeTeam(teamId: string, content: string): Promise<KnowledgeWriteResult> {
    return this.write('team', teamId, content)
  }

  /** Delete a team's knowledge file; idempotent. */
  async removeTeam(teamId: string): Promise<KnowledgeWriteResult> {
    return this.remove('team', teamId)
  }

  /** Ids of the room knowledge files, sorted; a missing directory is empty. */
  async listRooms(): Promise<readonly string[]> {
    return this.list('room')
  }

  /** Ids of the team knowledge files, sorted; a missing directory is empty. */
  async listTeams(): Promise<readonly string[]> {
    return this.list('team')
  }

  /**
   * Absolute path of one knowledge file, for diagnostics/UI display.
   *
   * Returns undefined for an illegal id (and an unknown kind): this is the ONLY path constructor,
   * so every read/write/remove goes through the same refusal — an id can never be a path.
   */
  pathFor(kind: 'room' | 'team', id: string): string | undefined {
    if (kind !== 'room' && kind !== 'team') return undefined
    if (idRefusal(id) !== undefined) return undefined
    return join(this.root, kind === 'room' ? 'rooms' : 'teams', `${id}.md`)
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /** Read one file; never rejects. A blank document (after trimEnd) is no knowledge at all. */
  private async read(kind: KnowledgeKind, id: string): Promise<string | undefined> {
    const path = this.pathFor(kind, id)
    if (path === undefined) return undefined
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error: unknown) {
      // A missing file is the common "never taught" case, not damage. Anything else (a directory
      // where the file should be, EACCES) is reported and treated as "no knowledge".
      if (errorCode(error) !== 'ENOENT') this.reportCorrupt(path, `无法读取知识文件：${errorText(error)}`)
      return undefined
    }
    return raw.trimEnd() === '' ? undefined : raw
  }

  /**
   * Write one file: refuse illegal ids/oversized text, create the directory 0700, write atomically
   * with 0600 and normalise the content first. Never rejects.
   */
  private async write(kind: KnowledgeKind, id: string, content: string): Promise<KnowledgeWriteResult> {
    const refusal = idRefusal(id)
    if (refusal !== undefined) return { ok: false, error: refusal }
    if (typeof content !== 'string') return { ok: false, error: '知识内容必须是字符串。' }
    if (content.length > this.maxChars) {
      return { ok: false, error: `知识内容超过上限 ${this.maxChars} 字符。` }
    }
    const path = this.pathFor(kind, id)
    if (path === undefined) return { ok: false, error: '非法 id。' } // unreachable after the checks above
    try {
      await mkdir(dirname(path), { recursive: true, mode: this.dirMode })
      await writeFileAtomic(path, normalizeKnowledge(content), { mode: this.fileMode, dirMode: this.dirMode })
      // A file replaced by rename already carries the temp file's mode; chmod is belt-and-braces
      // for a pre-existing (hand-created) file and is best-effort by design.
      await chmod(path, this.fileMode).catch(() => undefined)
      return { ok: true, chars: content.length }
    } catch (error: unknown) {
      return { ok: false, error: `知识写入失败：${errorText(error)}` }
    }
  }

  /** Delete one file; `rm({force:true})` makes "already gone" the same success. Never rejects. */
  private async remove(kind: KnowledgeKind, id: string): Promise<KnowledgeWriteResult> {
    const refusal = idRefusal(id)
    if (refusal !== undefined) return { ok: false, error: refusal }
    const path = this.pathFor(kind, id)
    if (path === undefined) return { ok: false, error: '非法 id。' } // unreachable after the check above
    try {
      await rm(path, { force: true })
      return { ok: true, chars: 0 }
    } catch (error: unknown) {
      return { ok: false, error: `知识删除失败：${errorText(error)}` }
    }
  }

  /** List `<dir>/*.md` ids, sorted; a missing directory is empty. Never rejects. */
  private async list(kind: KnowledgeKind): Promise<readonly string[]> {
    const dir = join(this.root, kind === 'room' ? 'rooms' : 'teams')
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') this.reportCorrupt(dir, `无法读取知识目录：${errorText(error)}`)
      return []
    }
    const ids: string[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      // Foreign/copy artefacts are skipped rather than shown as knowledge: the list is a UI/scan
      // input, and an id that could not be read back is not a usable entry.
      const id = entry.name.slice(0, -3)
      if (idRefusal(id) !== undefined) continue
      ids.push(id)
    }
    return ids.sort()
  }

  /** Hand an unreadable/damaged path to the caller's logger. A throwing callback must not break us. */
  private reportCorrupt(path: string, reason: string): void {
    if (this.onCorrupt === undefined) return
    try {
      this.onCorrupt(path, reason)
    } catch (error: unknown) {
      this.warn(`知识文件损坏回调抛出异常：${errorText(error)}`)
    }
  }

  /** Diagnostics only; must never be able to break the knowledge path. */
  private warn(message: string): void {
    try {
      process.emitWarning(`agent-community: knowledge: ${message}`)
    } catch {
      // Ignore: warnings are best-effort.
    }
  }
}

/**
 * Normalise one knowledge document.
 *
 * CRLF → LF so a Windows edit and a Unix edit do not produce two different files; `trimEnd()` so a
 * file does not accumulate blank tails round after round; exactly ONE final newline so the file is
 * a well-formed text file that diffs cleanly.
 */
function normalizeKnowledge(content: string): string {
  const lf = content.replace(/\r\n/gu, '\n')
  return `${lf.trimEnd()}\n`
}

/**
 * Why this id may not become a filename, or undefined when it is safe.
 *
 * The id is used as `<id>.md` directly, so the check is the isolation boundary: a slash would
 * escape the rooms/teams directory, `..` would climb out of it, NUL would truncate the path at the
 * syscall. An empty id would address a file called `.md`.
 */
function idRefusal(id: string): string | undefined {
  if (typeof id !== 'string' || id === '') return '非法 id：不能为空。'
  if (id.includes('/') || id.includes('\\')) return '非法 id：不能包含路径分隔符。'
  if (id.includes('..')) return '非法 id：不能包含 ".."。'
  if (id.includes('\u0000')) return '非法 id：不能包含空字符。'
  return undefined
}

/** The `code` of a caught Node fs error, when it has one. */
function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Plain text for a caught error, for an error result or a warning line. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
