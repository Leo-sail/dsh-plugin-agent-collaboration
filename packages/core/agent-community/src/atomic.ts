/**
 * Atomic file writes and advisory locks — the plugin's own, so the plugin does not depend on a
 * DSH package to write a file.
 *
 * WHY NOT `@deepseek-ai/dsh-atomic-write`. These two helpers are the only thing the plugin ever
 * used from it, and using them meant the plugin only loaded when THAT package was present at the
 * version the host happened to ship. Writing two small functions is cheaper than a version
 * requirement on the host: the plugin now installs and loads against any DSH, and the files it
 * writes are still written the safe way (temp file + rename, PID-stamped lock).
 *
 * The semantics are what the state writer needs:
 *
 *   · a write is visible WHOLE or not at all (temp + rename, never a partial file);
 *   · a lock records its owner's PID, so a lock left by a killed process can be recognised as a
 *     corpse instead of blocking every later write;
 *   · waiting is BOUNDED — a permanently held lock surfaces as a logged failure, not a Promise
 *     that never settles (the plugin serialises its writes behind that Promise).
 *
 * @module
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Options shared by the write helpers. */
export interface WriteOptions {
  /** File mode for the written file (0o600 keeps bot prompts and room history private). */
  readonly mode?: number | undefined
  /** Mode for directories created on the way. */
  readonly dirMode?: number | undefined
}

/**
 * Write `data` so readers see either the old contents or the new ones, never a half file.
 *
 * The temporary file is created in the SAME directory: `rename` is only atomic within a
 * filesystem, and the plugin's state lives next to its temps by construction.
 */
export async function writeFileAtomic(path: string, data: string, options: WriteOptions = {}): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, ...(options.dirMode !== undefined ? { mode: options.dirMode } : {}) })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await writeFile(tmp, data, { encoding: 'utf8', ...(options.mode !== undefined ? { mode: options.mode } : {}) })
    await rename(tmp, path)
  } catch (error: unknown) {
    // Never leave a temp file behind: a stale `.tmp-*` next to state.json looks like damage.
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** How often the lock is re-tried while it is held by somebody else. */
const RETRY_MS = 25

/**
 * Run `operation` while holding an advisory lock on `path`.
 *
 * The lock is `${path}.lock` and contains the owner's PID. Waits at most `waitMs` (default 5s)
 * and then throws, naming the lock file — a stuck write must be visible, not silent.
 */
export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: { readonly waitMs?: number | undefined } = {},
): Promise<T> {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + (options.waitMs ?? 5_000)
  await mkdir(dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      // `wx` is the whole mechanism: exactly one creator wins, and the file appears with our
      // PID already in it (written below) rather than empty-then-filled where possible.
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(String(process.pid), 'utf8')
      } finally {
        await handle.close()
      }
      break
    } catch (error: unknown) {
      const code = (error as { code?: string }).code
      if (code !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        const owner = await readLockOwner(lockPath)
        throw new Error(
          `could not lock ${lockPath} within ${options.waitMs ?? 5_000}ms`
          + (owner === undefined ? ' (no owner recorded)' : ` (held by pid ${owner})`),
        )
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_MS))
    }
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

/** The PID recorded in a lock file, or undefined when it is empty/unreadable. */
export async function readLockOwner(lockPath: string): Promise<number | undefined> {
  try {
    const raw = (await readFile(lockPath, 'utf8')).trim()
    if (raw === '') return undefined
    const pid = Number.parseInt(raw, 10)
    return Number.isFinite(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

/** Age of a lock file in milliseconds, or undefined when it does not exist. */
export async function lockAgeMs(lockPath: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs
  } catch {
    return undefined
  }
}

/** Join a lock path the way this module names them, for callers that inspect it. */
export function lockPathFor(path: string): string {
  return `${join(path)}.lock`
}
