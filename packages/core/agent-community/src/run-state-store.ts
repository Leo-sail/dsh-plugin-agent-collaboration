/**
 * run-state-store.ts — where the durable run checkpoint actually lives (P3-1).
 *
 * WHY THIS EXISTS. `run-state.ts` is a pure value machine, and `runs.ts`/`approval-bridge.ts`
 * only ever looked at it in memory. That left the recovery contract unimplementable: after a DSH
 * restart there is nowhere to read "which approval was in flight, how far did the run get, which
 * side-effect writes does it still owe". This store is the disk half of P3-1: one file per run
 * under `<home>/agent-community/run-state/<runId>.json`, written atomically, never rolled back,
 * and tolerant of whatever a crash or a hand edit left behind.
 *
 * THE RULES THE RECOVERY PATH RELIES ON
 *   · `<root>/<runId>.json`, mode 0600 in a 0700 directory — a snapshot names runs, rooms and bots;
 *   · a write is all-or-nothing (`writeFileAtomic`: temp file + rename), so a reader never sees a
 *     half JSON document;
 *   · revisions are monotonic: an incoming `rev` that is not strictly greater than the in-memory
 *     one is REFUSED as stale (`{ok:false, stale:true}`), so a slow writer cannot roll a run
 *     backwards. The one exception is an identical value: same rev, same bytes is a successful
 *     no-op (`{ok:true}` returning the STORED snapshot), which is what an idempotent retry sends;
 *   · writes are serialised behind one Promise chain, so two writers for the same run can never
 *     interleave a stale check and a rename (the plan's rule: the plugin serialises its own writes);
 *   · a corrupt file is moved aside as `<name>.corrupt-<timestamp>` and reported through
 *     `onCorrupt`, THEN skipped — one bad file must not take the whole recovery scan down;
 *   · `pruneSettled` removes only snapshots whose run actually settled (`settled.at` older than
 *     the cutoff); a live/unknown run is never touched, because deleting it would silently drop
 *     the only recovery evidence.
 *
 * NO METHOD THROWS AT THE CALLER. The constructor does no I/O; `load` treats a missing directory
 * as empty (first run is not damage) and reports unreadable/corrupt files through the callback;
 * `write`/`remove` return `{ok:false,error}` instead of rejecting. `load` is explicit (the service
 * calls it once at startup), and every mutation loads on demand first so a missed startup load can
 * never overwrite a newer snapshot with only the values this process happens to know.
 *
 * @module
 */
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic.ts'
import { isStaleSnapshot, parseRunSnapshot, serializeRunSnapshot } from './run-state.ts'
import type { RunSnapshot } from './run-state.ts'

/** A snapshot names runs, rooms and bots — private by construction. */
const DEFAULT_FILE_MODE = 0o600
const DEFAULT_DIR_MODE = 0o700

/** Options for {@link RunStateStore}. */
export interface RunStateStoreOptions {
  /** 损坏文件回调（用于日志）；不传则静默隔离。 */
  readonly onCorrupt?: ((path: string, reason: string) => void) | undefined
  /** 目录/文件权限（默认 0o700/0o600）。 */
  readonly dirMode?: number | undefined
  readonly fileMode?: number | undefined
}

/** Outcome of a write: a stored value, or an error why it was not stored. */
export type RunStateWriteResult =
  | { readonly ok: true; readonly snapshot: RunSnapshot }
  | { readonly ok: false; readonly error: string; readonly stale?: boolean | undefined }

/**
 * The on-disk snapshot store, mirrored in memory.
 *
 * One instance per plugin data home. `load()` at startup; `write`/`remove`/`pruneSettled` from the
 * service; `snapshots`/`get` for the recovery scan. Snapshot values are immutable by type, so the
 * mirror can hand out the stored references.
 */
export class RunStateStore {
  private readonly root: string
  private readonly fileMode: number
  private readonly dirMode: number
  private readonly onCorrupt: ((path: string, reason: string) => void) | undefined
  private readonly snapshotsById = new Map<string, RunSnapshot>()
  /** The file each in-memory snapshot was loaded from / last written to. */
  private readonly pathsById = new Map<string, string>()
  /** Set once `load()` (or the on-demand load inside a mutation) has read the disk. */
  private loaded = false
  /** Tail of the serialised operation chain; every mutation runs after the previous one settles. */
  private chain: Promise<void> = Promise.resolve()

  constructor(root: string, options: RunStateStoreOptions = {}) {
    this.root = root
    this.fileMode = options.fileMode ?? DEFAULT_FILE_MODE
    this.dirMode = options.dirMode ?? DEFAULT_DIR_MODE
    this.onCorrupt = options.onCorrupt
  }

  /**
   * Read every snapshot into the in-memory mirror. Idempotent and NEVER rejects.
   *
   * A missing directory is an empty store (the first run must not look corrupt). A file that is
   * not a {@link RunSnapshot} — torn JSON, a foreign document — is quarantined as
   * `<file>.corrupt-<timestamp>` and reported; the other files still load. When the same runId
   * appears in two files (only possible through a manual copy), the higher `rev` wins.
   */
  async load(): Promise<void> {
    await this.enqueue(async () => {
      try {
        await this.readFromDisk()
      } catch (error: unknown) {
        // Defensive: `readFromDisk` already contains its own failures, but a load must never reject.
        this.warn(`读取运行快照失败：${errorText(error)}`)
        this.loaded = true
      }
    })
  }

  /** The in-memory mirror after the last load/write, sorted by runId for a stable scan order. */
  snapshots(): readonly RunSnapshot[] {
    return [...this.snapshotsById.values()].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
  }

  /** One run's snapshot, or undefined when this store has never seen it. */
  get(runId: string): RunSnapshot | undefined {
    return this.snapshotsById.get(runId)
  }

  /**
   * Persist one snapshot, enforcing monotonic revisions.
   *
   * - identical to the stored value → `{ok:true}` no-op returning the STORED snapshot (an
   *   idempotent retry must not rewrite the file);
   * - `rev` not strictly greater than the stored one (or not a finite integer) → `{ok:false,
   *   stale:true}` and NOTHING is written, so a slow writer cannot roll a run backwards;
   * - otherwise an atomic 0600 write, and the mirror updates only after the write succeeded.
   *
   * All writes are serialised across the store, which is strictly stronger than the per-run
   * ordering the stale check needs. Never rejects: IO failures come back as `{ok:false,error}`.
   */
  async write(snapshot: RunSnapshot): Promise<RunStateWriteResult> {
    return this.enqueue(async () => {
      try {
        if (!this.loaded) await this.readFromDisk()
        const refusal = runIdRefusal(snapshot.runId)
        if (refusal !== undefined) return { ok: false, error: refusal }
        const current = this.snapshotsById.get(snapshot.runId)
        if (current !== undefined) {
          const incomingJson = serializeRunSnapshot(snapshot)
          const currentJson = serializeRunSnapshot(current)
          // Same rev + same bytes: the caller re-sent the value already stored. Answer success with
          // the stored snapshot (not a second copy of the incoming object) and touch no file.
          if (incomingJson === currentJson) return { ok: true, snapshot: current }
          if (isStaleSnapshot(snapshot.rev, current.rev)) {
            return {
              ok: false,
              stale: true,
              error: `快照版本过期：运行 ${snapshot.runId} 已保存 rev ${current.rev}，收到 rev ${snapshot.rev}，拒绝回退。`,
            }
          }
        }
        const path = this.pathFor(snapshot.runId)
        await writeFileAtomic(path, serializeRunSnapshot(snapshot), { mode: this.fileMode, dirMode: this.dirMode })
        this.snapshotsById.set(snapshot.runId, snapshot)
        this.pathsById.set(snapshot.runId, path)
        return { ok: true, snapshot }
      } catch (error: unknown) {
        return { ok: false, error: `运行快照写入失败：${errorText(error)}` }
      }
    })
  }

  /**
   * Delete one run's snapshot file and drop it from the mirror.
   *
   * Idempotent: removing a run this store does not know is `{ok:true}` (the file is force-removed
   * in case it exists on disk but was not loaded). A path-unsafe runId is refused. Never rejects.
   */
  async remove(runId: string): Promise<{ ok: boolean; error?: string | undefined }> {
    return this.enqueue(async () => {
      try {
        if (!this.loaded) await this.readFromDisk()
        const refusal = runIdRefusal(runId)
        if (refusal !== undefined) return { ok: false, error: refusal }
        for (const path of this.pathsFor(runId)) {
          try {
            await rm(path, { force: true })
          } catch (error: unknown) {
            return { ok: false, error: `运行快照删除失败：${errorText(error)}` }
          }
        }
        this.snapshotsById.delete(runId)
        this.pathsById.delete(runId)
        return { ok: true }
      } catch (error: unknown) {
        return { ok: false, error: `运行快照删除失败：${errorText(error)}` }
      }
    })
  }

  /**
   * Remove snapshots of runs that settled BEFORE `cutoffIso`; return how many were removed.
   *
   * Only a run whose phase is terminal AND which recorded `settled.at` is eligible: a live,
   * unknown or half-settled snapshot is the only recovery evidence there is, so it is never
   * pruned. A delete failure is logged and does NOT throw (the file stays for the next sweep);
   * an unparseable cutoff removes nothing. Never rejects.
   */
  async pruneSettled(cutoffIso: string): Promise<number> {
    return this.enqueue(async () => {
      try {
        if (!this.loaded) await this.readFromDisk()
        const cutoff = Date.parse(cutoffIso)
        if (Number.isNaN(cutoff)) return 0
        let removed = 0
        for (const snapshot of [...this.snapshotsById.values()]) {
          // "settled/interrupted" means the PHASE, and the record must actually carry the
          // settlement time: a live or half-settled run is never pruned.
          if (snapshot.phase !== 'settled' && snapshot.phase !== 'interrupted') continue
          const settledAt = snapshot.settled?.at
          if (settledAt === undefined) continue
          const settledMs = Date.parse(settledAt)
          // Unparseable/equal timestamps are kept: "< cutoff" only, never "<= cutoff".
          if (Number.isNaN(settledMs) || settledMs >= cutoff) continue
          let failed = false
          for (const path of this.pathsFor(snapshot.runId)) {
            try {
              await rm(path, { force: true })
            } catch (error: unknown) {
              failed = true
              this.warn(`无法清理过期运行快照 ${snapshot.runId}：${errorText(error)}`)
              break
            }
          }
          if (failed) continue
          this.snapshotsById.delete(snapshot.runId)
          this.pathsById.delete(snapshot.runId)
          removed += 1
        }
        return removed
      } catch (error: unknown) {
        this.warn(`清理过期运行快照失败：${errorText(error)}`)
        return 0
      }
    })
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  /** The canonical file for one run. Callers validate the runId with {@link runIdRefusal} first. */
  private pathFor(runId: string): string {
    return join(this.root, `${runId}.json`)
  }

  /**
   * Every file that may hold this run: the canonical name plus the path it was loaded from (equal
   * unless a duplicate file carried a higher rev — see the load contract).
   */
  private pathsFor(runId: string): string[] {
    const canonical = this.pathFor(runId)
    const tracked = this.pathsById.get(runId)
    return tracked === undefined || tracked === canonical ? [canonical] : [tracked, canonical]
  }

  /**
   * Scan `<root>/*.json` into the mirror. Never throws: every failure is reported and skipped.
   *
   * The mirror is replaced only after the scan reached its end, so one unreadable file cannot
   * leave half a mirror behind (the recovery scan reads `snapshots()` as one consistent view).
   */
  private async readFromDisk(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: this.dirMode })
    } catch (error: unknown) {
      // A root that cannot be created (occupied by a file, permissions) makes the store empty; the
      // writes will report the real failure later, with the path they tried.
      this.warn(`无法创建运行快照目录 ${this.root}：${errorText(error)}`)
    }
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') this.warn(`无法读取运行快照目录 ${this.root}：${errorText(error)}`)
      this.replaceMirror(new Map(), new Map())
      this.loaded = true
      return
    }
    const next = new Map<string, RunSnapshot>()
    const nextPaths = new Map<string, string>()
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const path = join(this.root, name)
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') continue // vanished between readdir and read; not damage
        await this.quarantine(path, `无法读取：${errorText(error)}`)
        continue
      }
      const snapshot = parseRunSnapshot(raw)
      if (snapshot === undefined) {
        await this.quarantine(path, '内容不是可用的运行快照')
        continue
      }
      const previous = next.get(snapshot.runId)
      // Same run in two files: keep the higher revision (equal rev keeps the first name read).
      if (previous === undefined || snapshot.rev > previous.rev) {
        next.set(snapshot.runId, snapshot)
        nextPaths.set(snapshot.runId, path)
      }
    }
    this.replaceMirror(next, nextPaths)
    this.loaded = true
  }

  /** Swap in a freshly scanned mirror (used only at the end of a successful scan). */
  private replaceMirror(snapshots: Map<string, RunSnapshot>, paths: Map<string, string>): void {
    this.snapshotsById.clear()
    for (const [runId, snapshot] of snapshots) this.snapshotsById.set(runId, snapshot)
    this.pathsById.clear()
    for (const [runId, path] of paths) this.pathsById.set(runId, path)
  }

  /** Report a damaged file and move it aside; a failed rename is not fatal (the file is skipped). */
  private async quarantine(path: string, reason: string): Promise<void> {
    this.reportCorrupt(path, reason)
    const stamp = new Date().toISOString().replace(/[.:]/gu, '-')
    try {
      await rename(path, `${path}.corrupt-${stamp}`)
    } catch (error: unknown) {
      this.warn(`无法隔离损坏的运行快照 ${path}：${errorText(error)}`)
    }
  }

  /** Hand a corrupt file to the caller's logger. A throwing callback must not break the scan. */
  private reportCorrupt(path: string, reason: string): void {
    if (this.onCorrupt === undefined) return
    try {
      this.onCorrupt(path, reason)
    } catch (error: unknown) {
      this.warn(`运行快照损坏回调抛出异常：${errorText(error)}`)
    }
  }

  /** Append one operation behind the previous one so reads and writes never interleave. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    // The chain must never stay rejected: the next queued operation still has to run.
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  /** Diagnostics only; must never be able to break the recovery path. */
  private warn(message: string): void {
    try {
      process.emitWarning(`agent-community: run-state: ${message}`)
    } catch {
      // Ignore: warnings are best-effort.
    }
  }
}

/** Why this runId may not become a filename, or undefined when it is safe. */
function runIdRefusal(runId: string): string | undefined {
  if (runId === '') return '非法 runId：不能为空。'
  if (runId.includes('/') || runId.includes('\\')) return '非法 runId：不能包含路径分隔符。'
  if (runId.includes('..')) return '非法 runId：不能包含 ".."。'
  if (runId.includes('\u0000')) return '非法 runId：不能包含空字符。'
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
