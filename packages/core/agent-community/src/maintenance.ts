/**
 * Maintenance operations of the Bot Community service.
 *
 * These are the destructive and repair paths — session-log purging, ledger seeding,
 * workspace/room pruning and the one-shot migrations the service runs at startup.
 * They were moved out of `AgentCommunityService` verbatim; the class reaches the
 * service only through `MaintenanceHost`, never through a service import, so the two
 * modules stay acyclic.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { BotId, BotRoom, BotRoomId, BotTask, RoomTaskState } from './types.ts'
import type { LedgerProjector, SeedRoomItem } from './ledger.ts'
import type { PersistedState } from './persistence.ts'
import { SessionRunner, optionalService } from './session-runner.ts'
import { dropBotFromRoom } from './bot-memory.ts'

/**
 * What `Maintenance` needs from `AgentCommunityService`.
 *
 * Deliberately a port rather than a service reference: the extracted class must not
 * import the module that imports it. Every accessor is live — `state` and
 * `defaultWorkspaceCache` are pairs of accessors, and the methods are closures — so the
 * host object may be built during field initialization, before the service's
 * constructor has assigned `ledger`/`sessionsDir`/`statePath`.
 */
export interface MaintenanceHost {
  readonly statePath: string
  readonly sessionsDir: string
  readonly ctx: Context
  readonly ledger: LedgerProjector
  readonly ledgerHydrated: Set<string>
  readonly defaultWorkspaceCache: string | undefined
  get state(): PersistedState
  set state(next: PersistedState)
  enqueueWrite(): void
  sessionIdFor(roomId: string, botId: string): string
  botWorkspaceDir(botId: string): string
  botWorkspaceRoot(): string
  nowIso(): string
  runDurationMs(run: { startedAt?: string | undefined; createdAt: string; finishedAt?: string | undefined }): number
  flushNow(): Promise<void>
  disposeBotAgents(roomId: string, botId: string): void
}

/**
 * The on-disk folder name for a session id.
 *
 * `dsh-session-persistence-jsonl` escapes anything that is unsafe in a path segment —
 * `:` becomes `~003A` — so the folder name is NOT the session id. Comparing a raw id
 * against folder names silently never matches, which is how session logs survived
 * both the startup sweep and deletion.
 */
function sessionFolderName(sessionId: string): string {
  let out = ''
  for (const ch of sessionId) {
    if (/^[A-Za-z0-9._-]$/.test(ch) || ch === '~') out += ch
    else out += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

export class Maintenance {
  constructor(private readonly host: MaintenanceHost) {}

  /**
   * Rebuild one room's ledger history from the persisted messages.
   *
   * Seeding is per room and idempotent: startup seeds every room that exists
   * then, and a room created later (a fork, or a new bot's DM) is seeded the
   * first time its ledger is read. Without that second path a forked room showed
   * the copied transcript in state but an empty panel, because the ledger is the
   * only thing the panel renders from.
   */
  seedLedgerRoom(roomId: string): number {
    const ordered = this.host.state.messages
      .filter(m => m.roomId === roomId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))

    // Rebuild not just the text rows but the reasoning row and the tool rows too.
    // The ledger is in-memory, so a restart used to drop every "thinking" block and
    // every tool call, leaving only the final answers. The run's reasoning and tool
    // activity are persisted on the message for exactly this reconstruction.
    const items = ordered.flatMap((m) => {
      const base = {
        kind: m.sender.kind === 'user' ? ('user' as const) : ('bot' as const),
        senderName: m.sender.name,
        botId: m.sender.botId,
        runId: m.runId,
      }
      const usage = m.usage !== undefined && m.usage.outputTokens !== undefined
        ? {
          outputTokens: m.usage.outputTokens,
          totalTokens: m.usage.totalTokens,
          ...(m.usage.inputTokens !== undefined ? { inputTokens: m.usage.inputTokens } : {}),
          ...(m.usage.cacheReadTokens !== undefined ? { cacheReadTokens: m.usage.cacheReadTokens } : {}),
          ...(m.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: m.usage.cacheWriteTokens } : {}),
        }
        : undefined

      const rows: SeedRoomItem[] = []
      if (m.sender.kind !== 'user' && m.reasoning !== undefined && m.reasoning !== '') {
        rows.push({ ...base, id: `${m.id}-reasoning`, at: m.createdAt, actor: 'bot-reasoning' as const, text: m.reasoning, reasoning: m.reasoning })
      }
      for (const [n, tool] of (m.toolActivity ?? []).entries()) {
        const callId = `${m.id}-tool-${n}`
        rows.push({ ...base, id: callId, at: m.createdAt, actor: 'tool-call' as const, text: '', callId, name: tool.name, args: tool.detail ?? '' })
        rows.push({ ...base, id: `${callId}-result`, at: m.createdAt, actor: 'tool-result' as const, text: '', callId, ok: tool.status !== 'error', output: tool.detail ?? '' })
      }
      rows.push({ ...base, id: m.id, at: m.createdAt, actor: 'bot-text' as const, text: m.text,
        ...(usage !== undefined ? { usage } : {}),
        // A user row's attachment metadata rides the rebuild too: the panel renders the
        // ledger and nothing else, so metadata kept only on `state.messages` would be
        // visible until the next reload and then disappear.
        ...(m.attachments !== undefined ? { attachments: m.attachments } : {}),
        // Carried so the panel can render the native "已完成，用时 …" footer.
        ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}) })
      return rows
    })
    // ── DURABLE SYSTEM ROWS ─────────────────────────────────────────────────────
    //
    // Notices live on the room (`room.notices`), not in `state.messages`, which is what keeps them
    // out of the unread arithmetic and out of the model prompt. They still have to come back in the
    // right place, so they are merged into the same ordered list and sorted by time with everything
    // else — a notice recorded between two messages must not jump to the end of the transcript.
    //
    // Ids are prefixed: `seedRoom` dedupes by id, and a notice id must never collide with a message
    // id (the message id space is the caller's, not ours).
    const noticeItems: SeedRoomItem[] = (this.host.state.rooms.find(r => r.id === roomId)?.notices ?? [])
      .map(n => ({
        id: `notice-${n.id}`,
        at: n.at,
        kind: 'notice' as const,
        senderName: '',
        text: n.text,
      }))
    const merged = noticeItems.length === 0
      ? items
      : [...items, ...noticeItems].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    return this.host.ledger.seedRoom(roomId as BotRoomId, merged)
  }

  /** Seed every room that exists at startup, before the executor can push. */
  seedLedgerFromState(): void {
    let seeded = 0
    for (const room of this.host.state.rooms) {
      this.host.ledgerHydrated.add(room.id)
      seeded += this.seedLedgerRoom(room.id)
    }
    if (seeded > 0) {
      this.host.ctx.logger?.info?.(`agent-community: restored ${seeded} ledger entries from state`)
    }
  }

  /**
   * Delete the exact session folders for the given ids under every bucket.
   *
   * Exact names only: `session-<id>` and `<id>`. A user conversation never carries a
   * plugin id, so matching precisely is what makes this safe to run unattended.
   */
  async purgeSessionIds(sessionIds: readonly string[], label: string): Promise<void> {
    const wanted = new Set<string>()
    for (const id of sessionIds) {
      if (typeof id === 'string' && id !== '') {
        // BOTH forms: the escaped name the backend actually writes, and the raw id for
        // a store that happened to keep it verbatim.
        wanted.add(sessionFolderName(id))
        wanted.add(`session-${sessionFolderName(id)}`)
        wanted.add(id)
        wanted.add(`session-${id}`)
      }
    }
    if (wanted.size === 0) return
    let buckets: string[]
    try {
      buckets = await readdir(this.host.sessionsDir)
    } catch {
      return
    }
    for (const bucket of buckets) {
      const bucketPath = join(this.host.sessionsDir, bucket)
      let entries: string[]
      try {
        entries = await readdir(bucketPath)
      } catch {
        continue
      }
      for (const name of entries) {
        if (!wanted.has(basename(name))) continue
        await rm(join(bucketPath, name), { recursive: true, force: true }).catch(() => undefined)
        this.host.ctx.logger?.info?.(`agent-community: purged session log ${name} for ${label}`)
      }
    }
  }

  /** Delete one session's on-disk log, wherever its bucket lives. */
  async removeSessionLog(sessionId: string): Promise<void> {
    const wanted = new Set([sessionFolderName(sessionId), `session-${sessionFolderName(sessionId)}`])
    let buckets: string[]
    try {
      buckets = await readdir(this.host.sessionsDir)
    } catch {
      return
    }
    for (const bucket of buckets) {
      const bucketPath = join(this.host.sessionsDir, bucket)
      let entries: string[]
      try {
        entries = await readdir(bucketPath)
      } catch {
        continue
      }
      for (const name of entries) {
        if (!wanted.has(name)) continue
        await rm(join(bucketPath, name), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  /** Session ids in the store whose folder name carries the plugin prefix. */
  async pluginSessionsOnDisk(): Promise<string[]> {
    const out: string[] = []
    let buckets: string[]
    try {
      buckets = await readdir(this.host.sessionsDir)
    } catch {
      return out
    }
    for (const bucket of buckets) {
      let entries: string[]
      try {
        entries = await readdir(join(this.host.sessionsDir, bucket))
      } catch {
        continue
      }
      for (const name of entries) {
        // Folders are `<sessionId>` or `session-<sessionId>`; only the plugin's own
        // prefix is taken, so a user conversation can never be swept by accident.
        const id = name.startsWith('session-') ? name.slice('session-'.length) : name
        // Session directories escape characters that are unsafe in a path segment —
        // `:` becomes `~003A` — so the raw folder name is NOT the session id and had
        // to be decoded before the prefix test could ever match.
        const decoded = id.replace(/~([0-9A-Fa-f]{4})/g, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)))
        // `ac:` is the current scheme; `ac-` is kept so sessions written by a build
        // that used the other separator are still swept instead of lingering.
        if (decoded.startsWith('ac:') || decoded.startsWith('ac-')) out.push(decoded)
      }
    }
    return out
  }

  /**
   * Unarchive every plugin session id still sitting in `archivedSessionIds`.
   *
   * Repair for ids archived by an older build. Safe to run always: sessions are hidden
   * by `origin: 'subagent'`, which `sessionVisible` checks BEFORE the archive set, so
   * unarchiving does not make anything visible — it only stops the admission gate from
   * rejecting the pair's turns.
   */
  async clearArchivedPluginIds(): Promise<void> {
    const registry = (this.host.ctx as unknown as {
      workspaceRegistry?: {
        archivedSessionIds: readonly string[]
        unarchiveSession?(id: string): Promise<void>
      }
    }).workspaceRegistry
    if (registry?.unarchiveSession === undefined) return
    const prefix = SessionRunner.ownedIdPrefix()
    const poisoned = registry.archivedSessionIds
      .map(String)
      .filter(id => id.startsWith(prefix))
    if (poisoned.length === 0) return
    let cleared = 0
    for (const id of poisoned) {
      try {
        await registry.unarchiveSession(id)
        cleared += 1
      } catch (error: unknown) {
        this.host.ctx.logger?.warn?.(`agent-community: could not unarchive ${id}: ${String(error)}`)
      }
    }
    if (cleared > 0) {
      this.host.ctx.logger?.info?.(
        `agent-community: cleared ${cleared} archived bot session id(s) — a leftover `
        + 'archived id blocks every turn for the pair that reuses it',
      )
    }
  }

  /**
   * §17.4 (c): archive every plugin session found in the session store at startup.
   *
   * The derived list only covers rooms and bots that still exist; this covers logs
   * left by a crash, a delete that failed halfway, or an older build. Session folders
   * are the one place the plugin can enumerate what actually exists.
   */
  /**
   * Repair bot sessions left behind by a build that predates origin-hiding.
   *
   * ⚠️ WHY THIS DELETES RATHER THAN ARCHIVES.
   *
   * The old builds hid sessions by ARCHIVING them, and DSH's `archived-session-gate`
   * answers every `agent/pre-step` for an archived session with `{ kind: 'reject' }`.
   * A rejected step ends the turn as `blocked` WITHOUT a model request, so those
   * sessions are not merely hidden — they are permanently mute. Nothing can repair
   * them either: `origin` lives in the session header and is fixed at creation, so a
   * legacy log can never become a `subagent`-origin one.
   *
   * Deleting them is therefore the repair, not a data loss: the room transcript is
   * kept in the ledger, and a fresh session is seeded from it (`seedMessages`), so the
   * bot still knows the conversation. Archiving would be the tempting move and is
   * exactly what breaks the bot.
   */
  async sweepPluginSessions(): Promise<void> {
    const found = await this.pluginSessionsOnDisk()

    // ── CLEAR ARCHIVED PLUGIN IDS, ALWAYS ────────────────────────────────────────
    //
    // This runs unconditionally, even when no stale log exists, because the ids are
    // DETERMINISTIC: `ac:<roomId>:<botId>` is reused by every later session for the
    // same pair. An older build hid sessions by archiving them, and a leftover id in
    // `archivedSessionIds` poisons every future session that reuses it — the
    // archived-session gate then rejects each `agent/pre-step` and the bot goes silent
    // with no model request.
    //
    // Unarchiving cannot re-expose a session: `sessionVisible` tests `origin` first and
    // returns false for `subagent` before consulting the archive set. Visibility and
    // archive state are decoupled, so clearing the flag is pure repair.
    await this.clearArchivedPluginIds()

    if (found.length === 0) return

    const registry = (this.host.ctx as unknown as {
      workspaceRegistry?: {
        archivedSessionIds: readonly string[]
        unarchiveSession?(id: string): Promise<void>
      }
    }).workspaceRegistry
    const archived = new Set((registry?.archivedSessionIds ?? []).map(String))

    let removed = 0
    for (const id of found) {
      // Only an ARCHIVED legacy session is broken; an unarchived one still runs, and
      // if it runs it may as well keep its memory.
      if (!archived.has(id)) continue
      try {
        // Unarchive first so the session is not left referenced as archived after its
        // log is gone, then remove the log itself.
        await registry?.unarchiveSession?.(id)
        await this.removeSessionLog(id)
        removed += 1
      } catch (error: unknown) {
        this.host.ctx.logger?.warn?.(`agent-community: could not repair session ${id}: ${String(error)}`)
      }
    }
    if (removed > 0) {
      this.host.ctx.logger?.info?.(
        `agent-community: removed ${removed} archived bot session(s) left by an older build; `
        + 'they could never run again (the archived-session gate rejects every step) and '
        + 'their bots will re-seed from the room transcript',
      )
    }
  }

  /**
   * Delete the on-disk session logs and per-room artifacts for a room.
   *
   * Matched by EXACT folder name only (`<sessionId>` or `session-<sessionId>`),
   * never by prefix — a fuzzy match could take out the user's own conversations.
   * The plugin's LLM-direct path creates no DSH sessions, so this normally finds
   * nothing and is purely a cleanup guard for logs left by earlier versions.
   */
  async purgeRoomArtifacts(roomId: string, sessionIds: readonly string[]): Promise<void> {
    await this.purgeSessionIds(sessionIds, `room ${roomId}`)
  }

  /**
   * Remove the DSH projection-cache records of sessions that no longer exist.
   *
   * The host keeps a durable fold of every session's projections under
   * `~/.dsh/storages/session_projcache/` (`session_projcache` domain, table `sessions`,
   * one record per session keyed by the session id). Deleting the session LOG is not
   * enough: the cached record still holds derived transcript content from a conversation
   * the user erased — verified on a real profile, where a cleared room's `tokens.json` /
   * `preview.html` text was still readable in the cache file.
   *
   * The service exposes no "forget" call, but the domain it opened is reachable through
   * `storageDomain` and its table has `delete(key)`. Best-effort by design: a missing
   * service, a different domain version, or a refused delete must never break a clear.
   */
  async purgeProjectionCache(sessionIds: readonly string[]): Promise<number> {
    const ids = sessionIds.filter(id => typeof id === 'string' && id !== '')
    if (ids.length === 0) return 0
    type CacheTable = { delete(key: string): Promise<boolean> }
    // GUARDED READ: `storageDomain` is not one of this plugin's injected services, and a
    // bare `this.ctx.storageDomain` throws `cannot get property ... without inject` —
    // which would have taken `clearMessages`/`deleteRoom`/`deleteBot` down with it.
    const domains = optionalService<{ get(name: string): { table(name: string): CacheTable } | undefined }>(
      this.host.ctx, 'storageDomain',
    )
    const domain = domains?.get('session_projcache')
    if (domain === undefined) return 0
    let removed = 0
    // The shipped spec names the table `sessions`; the alternative is cheap insurance
    // against a renamed table in a future version (a wrong name simply deletes nothing).
    for (const tableName of ['sessions', 'session']) {
      let table: CacheTable
      try {
        table = domain.table(tableName)
      } catch {
        continue
      }
      for (const id of ids) {
        try {
          if (await table.delete(id)) removed++
        } catch {
          // Fail-soft: a stale cache row costs a longer replay, never correctness.
        }
      }
    }
    return removed
  }

  /**
   * Everything bound to members who just left a room.
   *
   * A membership write alone leaves four kinds of live residue behind, and each one has
   * bitten this plugin in another form before:
   *   · RUNS     — a removed member's in-flight turn keeps streaming into a room it is no
   *                longer in, and the panel shows a bot answering that is not a member;
   *   · TASKS    — the board keeps cards assigned to somebody who cannot report;
   *   · MAILBOX  — queued hand-offs for a member that will never be woken;
   *   · MEMORY   — the pair's session log and host projection cache still hold the room's
   *                conversation, so a re-invite would resume the conversation it was
   *                kicked out of (this is the same residue class as "清空后仍有内容").
   *
   * The bookkeeping row is dropped too: the session id is deterministic, so a re-invite
   * recreates it against the now-empty log instead of resuming the purged one.
   */
  async cleanupRemovedMembers(
    roomId: string,
    botIds: readonly string[],
    label: string,
  ): Promise<void> {
    if (botIds.length === 0) return
    const gone = new Set<string>(botIds)

    // Stop the work first: dropping rows while a turn is mid-stream leaves the model
    // writing into a room the bot no longer belongs to.
    for (const botId of gone) this.host.disposeBotAgents(roomId, botId)
    const stoppedRuns = this.host.state.runs.filter(
      r => r.roomId === roomId && gone.has(r.botId) && (r.status === 'queued' || r.status === 'running'),
    )

    this.host.state = {
      ...this.host.state,
      runs: this.host.state.runs.map(r =>
        r.roomId === roomId && gone.has(r.botId) && (r.status === 'queued' || r.status === 'running')
          ? { ...r, status: 'cancelled' as const, error: `member removed (${label})`, updatedAt: this.host.nowIso(), finishedAt: this.host.nowIso() }
          : r,
      ),
      mailbox: this.host.state.mailbox.filter(m => !(m.roomId === roomId && gone.has(m.botId))),
    }

    // Release the board: cards assigned to a member who left go back to "open" so the
    // leader can hand them to somebody who is still here.
    const rooms = this.host.state.rooms.map(room => {
      if (room.id !== roomId) return room
      const typed = room as BotRoom & { tasks?: BotTask[]; taskState?: RoomTaskState }
      const tasks = (typed.tasks ?? []).map(t =>
        t.assigneeId !== undefined && gone.has(t.assigneeId)
          ? { ...t, status: 'open' as const, assigneeId: undefined, assigneeName: undefined }
          : t,
      )
      const taskState = typed.taskState === undefined
        ? undefined
        : { ...typed.taskState, assignments: typed.taskState.assignments.filter(a => !gone.has(String(a.botId))) }
      return {
        ...room,
        ...(typed.tasks !== undefined ? { tasks } : {}),
        ...(taskState !== undefined ? { taskState } : {}),
      } as BotRoom
    })
    this.host.state = {
      ...this.host.state,
      rooms,
      roomAgentSessions: this.host.state.roomAgentSessions.filter(s => !(s.roomId === roomId && gone.has(s.botId))),
      // Same residue class as the session log above: a removed member re-invited later must not
      // resume what it knew before it was kicked out of THIS room.
      botMemories: dropBotFromRoom(this.host.state.botMemories, roomId, gone),
    }
    this.host.enqueueWrite()
    await this.host.flushNow()
    const sessionIds = botIds.map(botId => this.host.sessionIdFor(roomId, botId))
    await this.purgeSessionIds(sessionIds, label)
    await this.purgeProjectionCache(sessionIds)
    // The ledger is the panel's render source. Disposing the agent can leave a row stuck
    // on `streaming: true` (no stream `end` ever arrives), which the panel renders as a
    // bot that is still "深度求索中" after it was removed — so the stopped runs are settled
    // explicitly and the reserved live row is released.
    for (const run of stoppedRuns) {
      this.host.ledger.settleRunEntries(run.id, run.roomId, this.host.runDurationMs(run))
    }
    for (const botId of gone) this.host.ledger.releaseLiveRow(roomId, botId)
  }

  /** Session ids a room ever used, from its runs and its messages. */
  sessionIdsOfRoom(roomId: string): string[] {
    const ids = new Set<string>()
    for (const s of this.host.state.roomAgentSessions) {
      if (s.roomId === roomId) ids.add(s.sessionId)
    }
    for (const m of this.host.state.messages) {
      if (m.roomId === roomId && m.sessionId !== undefined && m.sessionId !== '') {
        ids.add(m.sessionId)
      }
    }
    // Every member's derived id, whether or not a run ever registered it: a session
    // folder can outlive the bookkeeping row that pointed at it.
    const room = this.host.state.rooms.find(r => r.id === roomId)
    for (const botId of room?.memberIds ?? []) ids.add(this.host.sessionIdFor(roomId, botId))
    return [...ids]
  }

  /**
   * Erase the conversation text that older builds left in a cleared room's run log.
   *
   * `clearMessages` used to keep every run row as it was, and a run row carries the
   * message it was answering verbatim. The transcript, the ledger, the sessions and the
   * task board were all erased; the user's own words stayed in state.json, in a room
   * whose chat said "发消息开始对话".
   *
   * Scoped deliberately: only rooms that HAVE been cleared (clearCount > 0) and only
   * runs that can no longer be driven (a queued or running run still needs its prompt).
   * A room that was never cleared keeps its log intact.
   */
  stripClearedRunPrompts(): void {
    const cleared = new Set(
      this.host.state.rooms.filter(r => (r.clearCount ?? 0) > 0).map(r => r.id as string),
    )
    if (cleared.size === 0) return
    let stripped = 0
    const runs = this.host.state.runs.map(r => {
      if (!cleared.has(r.roomId) || r.prompt === '') return r
      if (r.status === 'queued' || r.status === 'running') return r
      stripped++
      return { ...r, prompt: '' }
    })
    if (stripped === 0) return
    this.host.state = { ...this.host.state, runs }
    this.host.enqueueWrite()
    this.host.ctx.logger?.info?.(
      `agent-community: cleared the prompt text of ${stripped} historic run(s) in cleared rooms`,
    )
  }

  /**
   * Delete a bot's plugin-managed workspace directory.
   *
   * ONLY when the bot never pointed anywhere else: a workspace the user chose is their
   * data and must survive the bot. The plugin-created directory under
   * `agent-community/workspaces/<botId>` exists because the bot existed, so it goes with
   * it — leaving it behind is how a profile accumulated 828 orphan directories.
   */
  async removeBotWorkspace(bot: { id: BotId; workspace?: string | undefined }): Promise<boolean> {
    const derived = this.host.botWorkspaceDir(bot.id)
    const workspace = bot.workspace ?? ''
    // An empty value means "the plugin's default directory", which IS `derived`.
    if (workspace !== '' && workspace !== derived) return false
    try {
      await rm(derived, { recursive: true, force: true })
      return true
    } catch (error: unknown) {
      this.host.ctx.logger?.warn?.(
        `agent-community: could not remove the workspace of bot ${bot.id}: ${String(error)}`,
      )
      return false
    }
  }

  /**
   * Remove workspaces whose bot no longer exists.
   *
   * Empty by construction — a live bot's directory is created on demand and only bots
   * write into it — so an orphan is deleted only when it holds no files at all. That
   * makes the sweep incapable of destroying something a user put there.
   */
  async pruneOrphanWorkspaces(): Promise<void> {
    const root = this.host.botWorkspaceRoot()
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      return
    }
    const live = new Set<string>(this.host.state.bots.map(b => b.id as string))
    let removed = 0
    for (const name of entries) {
      if (live.has(name)) continue
      const dir = join(root, name)
      try {
        const info = await stat(dir)
        if (!info.isDirectory()) continue
        const inside = await readdir(dir)
        if (inside.length > 0) continue
        await rm(dir, { recursive: true, force: true })
        removed++
      } catch {
        // Fail-soft: a workspace we cannot inspect stays.
      }
    }
    if (removed > 0) {
      this.host.ctx.logger?.info?.(`agent-community: removed ${removed} orphan bot workspace(s)`)
    }
  }

  /**
   * Move bots that share the global default workspace into private directories.
   *
   * Bots created before per-bot isolation all pointed at the same DSH workspace,
   * so files from a direct chat leaked into group chats. This retires that
   * sharing without touching a workspace the user set explicitly.
   */
  migrateBotsToPrivateWorkspaces(): void {
    let moved = 0
    const bots = this.host.state.bots.map((b) => {
      const shared = b.workspace === undefined || b.workspace === '' ||
        b.workspace === this.host.defaultWorkspaceCache
      if (!shared) return b
      const mine = this.host.botWorkspaceDir(b.id)
      if (b.workspace === mine) return b
      moved++
      return { ...b, workspace: mine, updatedAt: this.host.nowIso() }
    })
    if (moved === 0) return
    this.host.state = { ...this.host.state, bots }
    this.host.enqueueWrite()
    this.host.ctx.logger?.info?.(
      `agent-community: gave ${moved} bot(s) a private workspace under ${this.host.botWorkspaceRoot()}`,
    )
  }

  /**
   * Remove direct rooms whose bot no longer exists.
   *
   * Deleting a bot used to strip it from `memberIds` while leaving its direct
   * room and transcript behind, so the deleted bot's conversation stayed visible
   * in the plugin. This retires the rooms created before that was fixed.
   */
  pruneOrphanRooms(): void {
    const alive = new Set(this.host.state.bots.map(b => b.id))
    const orphans = new Set(
      this.host.state.rooms
        .filter(r => r.directBotId !== undefined && !alive.has(r.directBotId))
        .map(r => r.id),
    )
    if (orphans.size === 0) return
    this.host.state = {
      ...this.host.state,
      rooms: this.host.state.rooms.filter(r => !orphans.has(r.id)),
      messages: this.host.state.messages.filter(m => !orphans.has(m.roomId)),
      runs: this.host.state.runs.filter(r => !orphans.has(r.roomId)),
      mailbox: this.host.state.mailbox.filter(m => !orphans.has(m.roomId)),
      roomAgentSessions: this.host.state.roomAgentSessions.filter(s => !orphans.has(s.roomId)),
    }
    this.host.enqueueWrite()
    this.host.ctx.logger?.info?.(
      `agent-community: pruned ${orphans.size} room(s) whose bot was deleted`,
    )
  }
}
