/**
 * VisibilityController — hide/restore Bot sessions from the DSH workspace UI.
 *
 * Design (v5 §1 V-9, D-2=(a)):
 *  - meta.cwd stays the Bot's workspace root (not a private container).
 *  - Visibility is entirely managed by the archive set + detachSession.
 *  - Safety time-sequence: unarchive → resume/create → followup → whenIdle
 *                          → settleRun → archive (never with stopActivity).
 *
 * Three concurrent hazards defended here (V-9):
 *  H-1: being archived while a run is active → per-session mutex serialises
 *       run execution against visibility operations.
 *  H-2: reconcile archiving an active session → only archives sessions with
 *       no live agent; catches WorkspaceActiveSessionError and skips.
 *  H-3: detachSession alone doesn't hide from Ungrouped → both detach AND
 *       archive are called.
 *
 * archiveSession is idempotent (already-archived → no-op) so reconcile is safe.
 * archiveSession without stopActivity throws WorkspaceActiveSessionError when
 * the session is busy, which reconcile uses as a signal to skip.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

// Minimal shapes we use from workspaceRegistry; typed narrowly to avoid
// tight coupling with the host runtime's full interface.
interface WorkspaceRegistry {
  list(): ReadonlyArray<{ detachSession(id: string): Promise<void> }>
  archiveSession(id: string, opts?: { stopActivity?: boolean }): Promise<void>
  unarchiveSession(id: string): Promise<void>
  readonly archivedSessionIds: readonly string[]
}

export interface SessionVisibilityRecord {
  readonly sessionId: SessionId
  /** null = successfully hidden; string = last error from hide attempt */
  readonly lastError: string | null
  readonly hiddenAt: string | null
}

/** Per-session lock to prevent concurrent archive/unarchive/run. */
class SessionMutex {
  private readonly locks = new Map<string, Promise<void>>()

  async run<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve()
    let resolve!: () => void
    const next = new Promise<void>(r => { resolve = r })
    this.locks.set(sessionId, next)
    try {
      await prev
      return await fn()
    } finally {
      resolve()
      if (this.locks.get(sessionId) === next) this.locks.delete(sessionId)
    }
  }
}

export class VisibilityController {
  private readonly ctx: Context
  private readonly mutex = new SessionMutex()
  /** Tracks hide failures so the UI can surface them. */
  private readonly visibility = new Map<string, SessionVisibilityRecord>()

  constructor(ctx: Context, opts: { activeSchedules?: ((sessionId: string) => Promise<number>) | undefined } = {}) {
    this.ctx = ctx
    this.activeSchedules = opts.activeSchedules
  }

  /**
   * How many reminders are still waiting to fire in this session.
   *
   * WHY HIDE HAS TO ASK: archiving a session makes DSH emit `workspace/session-stop`, and the
   * schedule service answers that event by DELETING every active task owned by the session
   * (`dsh-schedule` lib/index.js: `ctx.on('workspace/session-stop', … stopSessionTasks)`).
   * A bot that creates a reminder therefore lost it the moment its turn ended and this plugin
   * hid the session — measured on the real host: created 04:23:01 (due 04:25:01), never fired.
   * A session with pending reminders stays admissible; the reminder fires, and once it is gone
   * the next hide archives the session as usual.
   */
  private readonly activeSchedules: ((sessionId: string) => Promise<number>) | undefined

  private registry(): WorkspaceRegistry | undefined {
    return (this.ctx as unknown as { workspaceRegistry?: WorkspaceRegistry }).workspaceRegistry
  }

  /**
   * Idempotent hide: detach from every workspace AND ensure the session sits in
   * DSH's archive set.
   *
   * DSH's session list shows a session when it is a workspace member or when it
   * is NOT in the archive set. Bot/host sessions run under this plugin's private
   * cwd and are created through the normal agent pipeline, so DSH is willing to
   * list them; archive membership is the only reliable suppression for them.
   * Leaving them out of the archive set is what previously put bot and group
   * sessions on the user's sidebar, so archive unconditionally here.
   *
   * Must be called after settleRun (session is already idle at that point).
   * Never pass stopActivity — that would cancel a running turn.
   */
  async hide(sessionId: SessionId): Promise<void> {
    if (this.activeSchedules !== undefined) {
      let pending = 0
      try {
        pending = await this.activeSchedules(sessionId as unknown as string)
      } catch {
        pending = 0
      }
      if (pending > 0) {
        // Leaving it unarchived keeps the reminder alive; DSH still hides the session from the
        // sidebar because its origin is `subagent` (sessionVisible returns false before it ever
        // consults the archive set), so nothing leaks into the user's session list.
        this.visibility.set(sessionId, {
          sessionId,
          lastError: null,
          hiddenAt: null,
        })
        this.ctx.logger?.info?.(
          `[visibility] ${sessionId} stays unarchived: ${pending} reminder(s) pending`,
        )
        return
      }
    }
    await this.mutex.run(sessionId, async () => {
      const reg = this.registry()
      if (reg === undefined) return
      try {
        const workspaces = reg.list()
        for (const ws of workspaces) {
          try { await ws.detachSession(sessionId) } catch { /* already detached */ }
        }
        if (!reg.archivedSessionIds.includes(sessionId)) {
          await reg.archiveSession(sessionId)
        }
        this.visibility.set(sessionId, {
          sessionId,
          lastError: null,
          hiddenAt: new Date().toISOString(),
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.visibility.set(sessionId, {
          sessionId,
          lastError: msg,
          hiddenAt: null,
        })
        // Non-fatal — log but don't crash the run
        ;(this.ctx as unknown as { logger?: { warn(...a: unknown[]): void } })
          .logger?.warn('[visibility] hide failed for', sessionId, msg)
      }
    })
  }

  /**
   * Restore: make the session runnable again before agents.resume/create.
   *
   * IMPORTANT — this must NOT unarchive. `unarchiveSession` is what makes a
   * session a first-class, listed session again; calling it on a bot session
   * is precisely what pushed bot/group sessions into DSH's sidebar (observed
   * live, and it also made them visible under the Archived filter beforehand).
   *
   * The plugin's own sessions live under its private cwd and are never listed
   * in a workspace, so there is nothing to unarchive for them. A session that
   * genuinely was listed is restored by DSH itself when it is needed.
   */
  async restore(sessionId: SessionId): Promise<void> {
    void sessionId
    // Intentionally a no-op. Kept as a named step because RunExecutor calls it
    // in the V-9 safety sequence (restore → resume/create → followup → …).
  }

  /**
   * Self-check: throw if the session is still in the archive set after restore().
   * The gate is a silent-fail mechanism (blocked, not thrown), so we must self-check.
   */
  assertRunnable(sessionId: SessionId): void {
    const reg = this.registry()
    if (reg === undefined) return
    if (reg.archivedSessionIds.includes(sessionId)) {
      throw new Error(
        `[visibility] refusing to run in archived session ${sessionId} — ` +
        'restore() succeeded but the session is still in archivedSessionIds; ' +
        'this is a bug in the visibility time-sequence',
      )
    }
  }

  /**
   * Full reconcile: archive every known session that has no live agent.
   * Safe to call on startup and after each settleRun to catch missed hides.
   * Skips sessions with a live agent (WorkspaceActiveSessionError → skip, not throw).
   */
  async reconcile(knownSessionIds: readonly string[]): Promise<void> {
    const reg = this.registry()
    if (reg === undefined) return
    for (const sessionId of knownSessionIds) {
      if (reg.archivedSessionIds.includes(sessionId as SessionId)) continue
      await this.mutex.run(sessionId, async () => {
        const regInner = this.registry()
        if (regInner === undefined) return
        // Detach from every workspace, then ensure archive membership — same
        // suppression hide() applies, so a startup reconcile also keeps bot and
        // group sessions out of DSH's session list.
        const workspaces = regInner.list()
        for (const ws of workspaces) {
          try { await ws.detachSession(sessionId) } catch { /* already detached */ }
        }
        try {
          // No stopActivity: if the session is busy, we skip it
          await regInner.archiveSession(sessionId)
          this.visibility.set(sessionId, {
            sessionId: sessionId as SessionId,
            lastError: null,
            hiddenAt: new Date().toISOString(),
          })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          // WorkspaceActiveSessionError or WorkspaceUnknownSessionError → skip
          if (msg.includes('active') || msg.includes('unknown') || msg.includes('Unknown')) return
          this.visibility.set(sessionId, {
            sessionId: sessionId as SessionId,
            lastError: msg,
            hiddenAt: null,
          })
        }
      })
    }
  }

  /** Snapshot of per-session visibility status for diagnostics. */
  listVisibility(): readonly SessionVisibilityRecord[] {
    return Array.from(this.visibility.values())
  }

  /** Count of sessions with a non-null lastError. */
  errorCount(): number {
    let n = 0
    for (const v of this.visibility.values()) {
      if (v.lastError !== null) n++
    }
    return n
  }
}
