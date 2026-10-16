/**
 * LedgerProjector — projects Bot member-session events into a typed 8-entry ledger.
 *
 * Architecture (v5 §5):
 *  - Subscribes to session events for all known member sessions.
 *  - Flushes entries in batches (Config.ledgerFlushMs, default 150ms) to avoid
 *    RPC storm when a fast streaming turn produces hundreds of tokens/events.
 *  - The ledger is the single source of truth for what the group-chat UI shows.
 *    The native session transcript of member sessions is NEVER sent to the client
 *    (red-line 1: RPC responses must not expose roomAgentSessions sessionIds).
 *
 * Entry types:
 *  user         — human message arriving in the room
 *  bot-text     — assistant reply from a member bot (streaming-aware)
 *  bot-reasoning — <thinking> block from a reasoning model (collapsible)
 *  tool-call    — model requested a tool
 *  tool-result  — tool execution finished (raw output, not summarised)
 *  approval     — member session triggered an approval prompt; awaiting user decision
 *  error        — run failed with a specific error
 *  dispatch     — host agent scheduling action (system row, non-bubble)
 */

import { randomUUID } from 'node:crypto'
import type { BotId, BotMessageAttachment, BotRoomId, BotRunId } from './types.ts'

export type LedgerEntryType =
  | 'user'
  | 'bot-text'
  | 'bot-reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'approval'
  | 'question'
  | 'error'
  | 'dispatch'

interface LedgerEntryBase {
  readonly id: string
  readonly roomId: BotRoomId
  readonly at: string
  readonly sequence: number
  /**
   * Bumped on every in-place update. `sequence` stays put for an entry's whole
   * life, so a client that already fetched an entry cannot detect later edits
   * (streaming text, `streaming: false`) from the sequence alone — this is the
   * cursor that moves.
   */
  readonly rev: number
}

export interface LedgerUserEntry extends LedgerEntryBase {
  readonly type: 'user'
  readonly text: string
  readonly senderName: string
  /**
   * Files the user attached, for the bubble to draw. Passed through from the persisted
   * message on both paths — the live push in `sendMessage` and the rebuild in
   * `seedLedgerRoom` — because the panel renders ONLY the ledger: metadata that lives
   * only on `state.messages` would vanish on the next reload.
   */
  readonly attachments?: readonly BotMessageAttachment[] | undefined
}

export interface LedgerBotTextEntry extends LedgerEntryBase {
  readonly type: 'bot-text'
  readonly botId: BotId
  readonly botName: string
  readonly runId?: BotRunId | undefined
  readonly text: string
  /**
   * Wall-clock duration of the run that produced this row, so the panel can render
   * the native "已完成，用时 …" footer without a reload. Only the persisted message
   * carried it before, which is why a freshly finished turn showed no duration
   * until DSH restarted and re-seeded the ledger from state.
   */
  readonly durationMs?: number | undefined
  readonly usage?: {
    readonly inputTokens?: number | undefined
    readonly uncachedInputTokens?: number | undefined
    readonly outputTokens?: number | undefined
    readonly totalTokens?: number | undefined
    readonly cacheReadTokens?: number | undefined
    readonly cacheWriteTokens?: number | undefined
  } | undefined
  /** true while the turn is still streaming */
  readonly streaming: boolean
}

export interface LedgerBotReasoningEntry extends LedgerEntryBase {
  readonly type: 'bot-reasoning'
  readonly botId: BotId
  readonly botName: string
  /** Turn identity: keeps reasoning in the same rendered turn as its answer. */
  readonly runId?: BotRunId | undefined
  readonly text: string
}

export interface LedgerToolCallEntry extends LedgerEntryBase {
  readonly type: 'tool-call'
  readonly botId: BotId
  readonly botName: string
  /** Turn identity: keeps tool cards inside the turn that issued them. */
  readonly runId?: BotRunId | undefined
  readonly callId: string
  readonly name: string
  readonly args: string
}

export interface LedgerToolResultEntry extends LedgerEntryBase {
  readonly type: 'tool-result'
  readonly botId: BotId
  readonly botName: string
  readonly runId?: BotRunId | undefined
  readonly callId: string
  readonly ok: boolean
  readonly output: string
}

export interface LedgerApprovalEntry extends LedgerEntryBase {
  readonly type: 'approval'
  readonly botId: BotId
  readonly botName: string
  readonly callId: string
  readonly toolName: string
  readonly args: string
  readonly outcome?: 'allowed-once' | 'rejected' | undefined
}

/**
 * A question a bot asked the user, and the answer once it arrives.
 *
 * Its own row type rather than an `approval`: an approval is a yes/no about a tool call,
 * while a question is a prompt with options the user picks from. Both block the bot's turn
 * until the user acts, which is why both live in the transcript next to the turn that asked.
 */
export interface LedgerQuestionEntry extends LedgerEntryBase {
  readonly type: 'question'
  readonly botId: BotId
  readonly botName: string
  readonly questionId: string
  readonly runId?: BotRunId | undefined
  readonly question: string
  /** Selectable answers; empty means free text only. */
  readonly options: readonly string[]
  readonly allowFreeText: boolean
  readonly status: 'pending' | 'answered' | 'skipped' | 'expired'
  readonly answer?: string | undefined
  readonly answeredAt?: string | undefined
}

export interface LedgerErrorEntry extends LedgerEntryBase {
  readonly type: 'error'
  readonly botId: BotId
  readonly botName: string
  readonly message: string
  readonly code?: string | undefined
}

export interface LedgerDispatchEntry extends LedgerEntryBase {
  readonly type: 'dispatch'
  readonly text: string
}

export type LedgerEntry =
  | LedgerUserEntry
  | LedgerBotTextEntry
  | LedgerBotReasoningEntry
  | LedgerToolCallEntry
  | LedgerToolResultEntry
  | LedgerApprovalEntry
  | LedgerQuestionEntry
  | LedgerErrorEntry
  | LedgerDispatchEntry

/**
 * A ledger entry before the projector assigns its identity. Distributing over the
 * union keeps each variant's own fields (e.g. `botId`) checkable at the call site.
 */
/**
 * A ledger entry as callers supply it.
 *
 * `id`, `sequence` and `rev` are assigned by {@link LedgerProjector.push}. `at` is
 * optional there too: `push` stamps it when absent, so every entry carries a time
 * whether or not the caller remembered. Leaving `at` REQUIRED here did not prevent
 * omissions — callers bypassed it with `as never` casts — it only stopped the
 * compiler from noticing that the streaming path never passed one, which left live
 * entries with no timestamp and made the UI's clock and run timer blank.
 */
export type LedgerEntryInput = LedgerEntry extends infer T
  ? T extends LedgerEntry
    ? Omit<T, 'id' | 'sequence' | 'rev' | 'at'> & { readonly at?: string | undefined }
    : never
  : never

/** Minimal bot info needed to annotate ledger entries. */
interface BotInfo {
  readonly id: BotId
  readonly name: string
}

// ── LedgerProjector ───────────────────────────────────────────────────────────

export interface LedgerStateAccessor {
  getBot(id: string): { name: string } | undefined
}

/**
 * LedgerProjector — in-memory store + pub/sub for 8-type ledger entries.
 *
 * Consumers (RunExecutor, sendMessage, ApprovalBridge) call push() to append
 * entries. Clients call listLedger() for pagination and follow() for real-time
 * delivery. Batches subscriber notifications at flushMs (default 150) to avoid
 * per-token RPC storms during streaming turns.
 */
export interface SeedRoomItem {
      readonly id: string
      readonly at: string
      readonly kind: 'user' | 'bot' | 'notice'
      readonly senderName: string
      readonly botId?: string | undefined
      readonly text: string
      /** Attachment metadata for a user row; see {@link LedgerUserEntry.attachments}. */
      readonly attachments?: readonly BotMessageAttachment[] | undefined
      readonly runId?: string | undefined
      readonly reasoning?: string | undefined
      readonly usage?: {
        inputTokens?: number | undefined
        uncachedInputTokens?: number | undefined
        outputTokens?: number | undefined
        totalTokens?: number | undefined
        cacheReadTokens?: number | undefined
        cacheWriteTokens?: number | undefined
      } | undefined
      /**
       * Which row to rebuild. Defaults to the answer (`bot-text`); the reasoning
       * and tool rows are reconstructed from the message that carried them so a
       * restart does not erase the thinking and tool sections.
       */
      readonly actor?: 'bot-text' | 'bot-reasoning' | 'tool-call' | 'tool-result' | undefined
      readonly callId?: string | undefined
      readonly name?: string | undefined
      readonly args?: string | undefined
      readonly ok?: boolean | undefined
      readonly output?: string | undefined
      /** Wall-clock duration of the run that produced this entry. */
      readonly durationMs?: number | undefined
}

export class LedgerProjector {
  private readonly svc: LedgerStateAccessor
  private readonly byRoom = new Map<string, LedgerEntry[]>()
  private seq = 0
  private readonly subscribers = new Map<string, Set<(batch: LedgerEntry[]) => void>>()
  private pendingBatch = new Map<string, LedgerEntry[]>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private readonly flushMs: number

  constructor(svc: LedgerStateAccessor, opts: { flushMs?: number; onEntry?: ((entry: LedgerEntry) => void) | undefined } = {}) {
    this.svc = svc
    this.flushMs = opts.flushMs ?? 150
    this.onEntry = opts.onEntry
  }

  /**
   * Called for every appended entry, after it is stored.
   *
   * The unread badge hangs off this: what the user SEES in a room is its ledger, and a native run's
   * answer is pushed here as `bot-text` without necessarily becoming a room message. Counting only
   * room messages left the badge empty for the most ordinary case (ask a bot something, it answers);
   * measured live: the run completed and the unread map was still empty.
   */
  private readonly onEntry: ((entry: LedgerEntry) => void) | undefined

  /**
   * Seed a room's history from persisted messages.
   *
   * The projector itself is in-memory (it exists to batch live session events),
   * but the conversation is durable in the community state file. Without this
   * seed, restarting DSH left every room's panel empty even though the bots could
   * still read the same history through the state — the UI simply had nothing to
   * render.
   *
   * Only called once per process, before any live entry is pushed, so it cannot
   * duplicate a message that sendMessage() also pushed to the ledger.
   */
  seedRoom(
    roomId: BotRoomId,
    items: ReadonlyArray<SeedRoomItem>,
  ): number {
    if (items.length === 0) return 0
    // Built as inputs (no id/sequence/rev); the projector state holds entries.
    const list: LedgerEntryInput[] = []
    // One row per message id. A rebuild must never produce two rows for the same
    // message — that rendered as the same chat message appearing twice in the panel.
    const seenIds = new Set<string>()
    for (const item of items) {
      if (seenIds.has(item.id)) continue
      seenIds.add(item.id)
      const base = { id: item.id, roomId, at: item.at, sequence: ++this.seq }
      if (item.kind === 'user') {
        list.push({
          ...base,
          type: 'user',
          text: item.text,
          senderName: item.senderName,
          ...(item.attachments !== undefined ? { attachments: item.attachments } : {}),
        })
      } else if (item.kind === 'notice') {
        // A durable system row (room.notices). Same `dispatch` type the live path pushes, so a
        // rebuilt notice is byte-for-byte the row the user already saw — one renderer, one style.
        list.push({ ...base, type: 'dispatch', text: item.text })
      } else if (item.actor === 'bot-reasoning') {
        list.push({
          ...base,
          type: 'bot-reasoning',
          botId: (item.botId ?? item.senderName) as BotId,
          botName: item.senderName,
          ...(item.runId !== undefined ? { runId: item.runId as BotRunId } : {}),
          text: item.reasoning ?? item.text,
        })
      } else if (item.actor === 'tool-call') {
        list.push({
          ...base,
          type: 'tool-call',
          botId: (item.botId ?? item.senderName) as BotId,
          botName: item.senderName,
          ...(item.runId !== undefined ? { runId: item.runId as BotRunId } : {}),
          callId: item.callId ?? item.id,
          name: item.name ?? '',
          args: item.args ?? '',
        })
      } else if (item.actor === 'tool-result') {
        list.push({
          ...base,
          type: 'tool-result',
          botId: (item.botId ?? item.senderName) as BotId,
          botName: item.senderName,
          ...(item.runId !== undefined ? { runId: item.runId as BotRunId } : {}),
          callId: item.callId ?? item.id,
          ok: item.ok ?? true,
          output: item.output ?? '',
        })
      } else {
        list.push({
          ...base,
          type: 'bot-text',
          botId: (item.botId ?? item.senderName) as BotId,
          botName: item.senderName,
          ...(item.runId !== undefined ? { runId: item.runId as BotRunId } : {}),
          text: item.text,
          streaming: false,
          ...(item.usage !== undefined ? { usage: item.usage } : {}),
          ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
        })
      }
    }
    this.byRoom.set(roomId, list as LedgerEntry[])
    return list.length
  }

  /**
   * Append an entry; returns the persisted entry with id and sequence filled.
   *
   * The parameter is the pre-identity discriminated union of LedgerEntry rather
   * than `Omit<LedgerEntry, 'id'|'sequence'>`: TypeScript distributes Omit poorly
   * over a union, so every caller's object literal was checked against all eight
   * variants at once and legitimate fields like `botId` were rejected.
   */
  push(entry: LedgerEntryInput): LedgerEntry {
    const { randomUUID } = require('node:crypto') as typeof import('node:crypto')
    // ── A ROW BELONGING TO A RUN HAS A DERIVED ID ─────────────────────────────
    //
    // Random ids let one answer become two rows: the streaming row is created on the attempt's
    // first frame, sometimes before `runIdFor` can name the run, so it carries no runId — and
    // `patchRunText` looks rows up BY runId, finds nothing, and opens a second row for the same
    // text. Measured: one reply rendered twice, one copy with its reasoning and one without,
    // which is exactly that pair. Deriving the id from (run, type, call) makes the projection's
    // row and the settling write the same row by construction.
    const rowRunId = (entry as { runId?: string }).runId
    const rowCallId = (entry as { callId?: string }).callId
    const rowType = (entry as { type?: string }).type
    const full = {
      ...entry,
      // Stamped here, not by callers. Required by LedgerEntryBase, and every consumer
      // that sorts, groups or formats by time depends on it; making callers supply it
      // is what let the streaming path emit timeless entries.
      at: entry.at ?? new Date().toISOString(),
      id: rowRunId !== undefined && rowType !== undefined
        ? `run:${rowRunId}:${rowType}${rowCallId !== undefined ? `:${rowCallId}` : ''}`
        : randomUUID(),
      sequence: ++this.seq,
      rev: 1,
    } as LedgerEntry
    const list = this.byRoom.get(full.roomId) ?? []
    list.push(full)
    this.byRoom.set(full.roomId, list)
    const pending = this.pendingBatch.get(full.roomId) ?? []
    pending.push(full)
    this.pendingBatch.set(full.roomId, pending)
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => this.flushSubscribers(), this.flushMs)
    }
    try {
      this.onEntry?.(full)
    } catch {
      // Never let a badge counter break the conversation.
    }
    return full
  }

  /**
   * Patch an existing entry in-place (e.g. resolve an approval outcome or
   * finalise a streaming bot-text entry). Notifies subscribers immediately.
   */
  patch(id: string, roomId: string, patch: Partial<LedgerEntry>): void {
    const list = this.byRoom.get(roomId)
    if (list === undefined) return
    const idx = list.findIndex(e => e.id === id)
    if (idx < 0) return
    const prev = list[idx]!
    ;(list as LedgerEntry[])[idx] = {
      ...prev,
      ...patch,
      rev: prev.rev + 1,
    } as LedgerEntry
    const subs = this.subscribers.get(roomId)
    if (subs !== undefined) for (const cb of subs) cb([list[idx]!])
  }

  /** Live rows reserved by a run, keyed by `(roomId, botId)`. */
  private readonly reservedLiveRows = new Map<string, string>()

  private static pairKey(roomId: string, botId: string): string {
    return `${roomId}\u0000${botId}`
  }

  /**
   * Open the run's live row BEFORE the turn starts, and hand back its id.
   *
   * The run owns the row from the beginning, which is what makes the transcript
   * deterministic: the streaming projection takes this row over instead of creating one
   * of its own, and the final answer is written to it as well. When both sides created
   * rows independently the same answer could render twice — and the copy the projection
   * made while the run was still queued carried no `runId`, so it looked like a message
   * from nobody.
   */
  reserveLiveRow(roomId: string, botId: string, botName: string, runId: string): string {
    const row = this.push({
      type: 'bot-text',
      roomId: roomId as never,
      botId: botId as never,
      botName,
      runId: runId as never,
      text: '',
      streaming: true,
      at: new Date().toISOString(),
    } as never)
    this.reservedLiveRows.set(LedgerProjector.pairKey(roomId, botId), row.id)
    return row.id
  }

  /**
   * The live row for this pair, for the WHOLE run.
   *
   * Deliberately NOT consumed on read. A turn can make several model attempts — the
   * runner retries when the model answers with reasoning but no text — and each attempt
   * emits its own `start` frame. A one-shot reservation was already spent by the second
   * attempt, so the projection opened ANOTHER row and the same turn rendered twice, once
   * under a row that carried no name. Holding the row for the run's duration is what
   * makes "one turn, one row" true no matter how many attempts it takes.
   */
  liveRowFor(roomId: string, botId: string): string | undefined {
    return this.reservedLiveRows.get(LedgerProjector.pairKey(roomId, botId))
  }

  /**
   * A bot-text row already carrying this run id, if one exists.
   *
   * The LAST line of defence against a duplicated turn. Every row-creating path asks
   * this first, so a row that was created under any circumstance — reserved by the run,
   * opened by the streaming projection, written by the final answer — is reused rather
   * than joined by a second row for the same turn.
   */
  botTextRowForRun(roomId: string, runId: string): string | undefined {
    const list = this.byRoom.get(roomId)
    if (list === undefined) return undefined
    let found: string | undefined
    for (const e of list) {
      if (e.type !== 'bot-text') continue
      if ((e as { runId?: string }).runId === runId) found = e.id
    }
    return found
  }

  /** Release the pair's live row once the run has settled. */
  releaseLiveRow(roomId: string, botId: string): void {
    this.reservedLiveRows.delete(LedgerProjector.pairKey(roomId, botId))
  }

  /**
   * Write a run's FINAL answer onto its rows, creating one if none exists.
   *
   * Streaming is best-effort: `LedgerProjection` paints text as it arrives, but if a
   * delta is missed, dropped, or arrives for an attempt whose row was never created,
   * the turn ends with an empty row stuck on `streaming: true` — which the panel shows
   * as "处理中…" forever even though the model answered. The runner's own return value
   * is authoritative, so it is applied here as a guarantee rather than left to the
   * stream.
   *
   * Patching by `runId` (not by a remembered row id) also means this works no matter
   * which component created the row, and it clears `streaming` in the same write so
   * the turn can never be left looking live.
   */
  patchRunText(
    roomId: string,
    runId: string,
    text: string,
    identity?: { botId: string; botName: string },
  ): void {
    const list = this.byRoom.get(roomId)
    if (list === undefined) {
      // No ledger for the room yet. The answer still has to land, so open one — the
      // alternative is a bot that answered and whose reply is nowhere.
      if (identity === undefined) return
      this.push({
        type: 'bot-text',
        roomId: roomId as never,
        botId: identity.botId as never,
        botName: identity.botName,
        runId: runId as never,
        text,
        streaming: false,
        at: new Date().toISOString(),
      } as never)
      return
    }
    const rows = list.filter(
      (e): e is Extract<LedgerEntry, { type: 'bot-text' }> =>
        e.type === 'bot-text' && (e as { runId?: string }).runId === runId,
    )
    if (rows.length === 0) {
      // ── ADOPT, DO NOT DUPLICATE ──────────────────────────────────────────────
      //
      // A run can already own a row that carries NO `runId`: the streaming projection
      // creates one on the attempt's first frame using whatever `runIdFor` returned at
      // that instant, and for a run still queued that was `undefined`. Creating a
      // second row here therefore rendered the SAME answer twice — once from the
      // adopted stream and once from this write — and the nameless one looked like a
      // message from nobody.
      //
      // So the newest streaming text row for this bot is taken over instead. Only when
      // there is genuinely no row does one get created, which keeps the original fix
      // (an answer is never dropped) without ever duplicating it.
      // The adopted row must carry the runId from now on, or the next write for this
      // run will fail to find it and open yet another row.
      const stampAdopted = (rowId: string): void => {
        const current = (this.byRoom.get(roomId) ?? []).find(e => e.id === rowId)
        if (current !== undefined) (current as { runId?: string }).runId = runId
      }
      void stampAdopted
      const orphan = identity !== undefined
        ? [...list].reverse().find(e =>
            e.type === 'bot-text'
            && (e as { botId?: string }).botId === identity.botId
            && (e as { runId?: string }).runId === undefined
            && (e as { streaming?: boolean }).streaming === true)
        : undefined
      if (orphan !== undefined) {
        this.patch(orphan.id, roomId, {
          text,
          streaming: false,
          runId: runId as never,
        } as Partial<LedgerEntry>)
        return
      }
      // Genuinely nothing to adopt: the answer still has to land, so open a row.
      if (identity === undefined) return
      this.push({
        type: 'bot-text',
        roomId: roomId as never,
        botId: identity.botId as never,
        botName: identity.botName,
        runId: runId as never,
        text,
        streaming: false,
        at: new Date().toISOString(),
      } as never)
      return
    }
    // The LAST text row of the run is its answer; earlier ones were superseded.
    const target = rows[rows.length - 1]!
    this.patch(target.id, roomId, { text, streaming: false } as Partial<LedgerEntry>)
    // Every OTHER row of this run stops looking live too. A row left on
    // `streaming: true` renders as a bot that is permanently 运行中 — which is exactly
    // how a stray row from a non-run stream (the session-title call) appeared, and why
    // a four-bot group showed ten avatars. This is the belt to that braces.
    for (const row of rows) {
      if (row.id === target.id) continue
      if ((row as { streaming?: boolean }).streaming !== true) continue
      this.patch(row.id, roomId, { streaming: false } as Partial<LedgerEntry>)
    }
  }

  /**
   * Write a run's REASONING onto its row, creating one when the stream did not.
   *
   * Same contract as {@link patchRunText} and for the same reason: the reasoning shown
   * to the user must come from the run's own result, not only from stream frames. Frames
   * are the live path; this is the guarantee. It also survives a turn whose stream was
   * intentionally not recorded — the whole attempt stream is skipped when no run is live,
   * which is what stops DSH's session-title call from appearing as a second answer, and
   * that same gate would otherwise take the reasoning with it.
   */
  patchRunReasoning(
    roomId: string,
    runId: string,
    text: string,
    identity: { botId: string; botName: string },
  ): void {
    if (text === '') return
    const list = this.byRoom.get(roomId)
    const existing = list?.find(e =>
      e.type === 'bot-reasoning' && (e as { runId?: string }).runId === runId)
    if (existing !== undefined) {
      this.patch(existing.id, roomId, { text } as Partial<LedgerEntry>)
      return
    }
    this.push({
      type: 'bot-reasoning',
      roomId: roomId as never,
      botId: identity.botId as never,
      botName: identity.botName,
      runId: runId as never,
      text,
      at: new Date().toISOString(),
    } as never)
  }

  /** Stop a run's rows looking live, without touching their text. */
  settleRunText(roomId: string, runId: string): void {
    const list = this.byRoom.get(roomId)
    if (list === undefined) return
    for (const e of list) {
      if (e.type !== 'bot-text') continue
      if ((e as { runId?: string }).runId !== runId) continue
      if ((e as { streaming?: boolean }).streaming !== true) continue
      this.patch(e.id, roomId, { streaming: false } as Partial<LedgerEntry>)
    }
  }

  private flushSubscribers(): void {
    this.flushTimer = undefined
    for (const [roomId, batch] of this.pendingBatch) {
      const subs = this.subscribers.get(roomId)
      if (subs !== undefined && batch.length > 0) {
        for (const cb of subs) cb([...batch])
      }
    }
    this.pendingBatch.clear()
  }

  /**
   * Paginated read in one of three modes:
   *  • `afterSequence` — the forward poll: newest `limit` entries strictly after
   *    the cursor. The panel polls this every few tens of ms, so it must transfer
   *    only the delta rather than the whole room history.
   *  • `beforeSequence` — backwards paging for "load earlier".
   *  • neither — the newest `limit` entries (initial load).
   */
  listLedger(
    roomId: string,
    opts: {
      beforeSequence?: number
      afterSequence?: number
      changedAfterSequence?: number
      limit?: number
      /**
       * Ignore every cursor and return the room's rows as they are now.
       *
       * A re-seed assigns fresh sequence numbers, which can land BELOW a cursor the
       * client already holds; a cursor query then returns rows all older than the
       * cursor and the settled reply is never delivered. A forced read has no such
       * assumption — it is bounded by the room's own size.
       */
      force?: boolean
    } = {},
  ): LedgerEntry[] {
    const all = this.byRoom.get(roomId) ?? []
    const { beforeSequence, afterSequence, changedAfterSequence, limit = 50, force = false } = opts
    if (force) return all.slice(-limit)
    if (changedAfterSequence !== undefined) {
      // ── A CURSOR ABOVE THIS LEDGER'S OWN COUNTER CANNOT BE SATISFIED ─────────
      //
      // Sequences come from an in-memory counter, so a plugin reload starts them
      // again from 1 while the panel keeps the cursor it already held. Every row the
      // room then has is BELOW that cursor, `sequence >= cursor` matched nothing, and
      // the client was answered with an empty page forever: the transcript froze on
      // the pre-reload rows and the user's own messages never appeared — exactly the
      // "I sent a greeting and it never showed up" report. Re-seeding a room does the
      // same thing to a lesser degree.
      //
      // The counter is the authority on what this ledger can possibly hold, so a
      // cursor beyond it proves the client is stale rather than idle. Answer with the
      // newest rows; the client re-merges by id, so a needless re-send is harmless.
      if (changedAfterSequence > this.seq) return all.slice(-limit)
      // Inclusive on the boundary: the entry at the cursor may itself have been
      // patched (streaming text grows, then `streaming` flips to false), and the
      // client re-merges by id, so re-sending it is how edits arrive at all.
      return all.filter(e => e.sequence >= changedAfterSequence).slice(0, limit)
    }
    if (afterSequence !== undefined) {
      return all.filter(e => e.sequence > afterSequence).slice(0, limit)
    }
    const filtered = beforeSequence !== undefined ? all.filter(e => e.sequence < beforeSequence) : all
    return filtered.slice(-limit)
  }

  /**
   * Subscribe to new entries for a room starting from `cursor` (exclusive).
   * Immediately delivers any buffered entries after cursor. Returns a disposer.
   */
  follow(roomId: string, cursor: number, cb: (entries: LedgerEntry[]) => void): () => void {
    let subs = this.subscribers.get(roomId)
    if (subs === undefined) { subs = new Set(); this.subscribers.set(roomId, subs) }
    subs.add(cb)
    const since = (this.byRoom.get(roomId) ?? []).filter(e => e.sequence > cursor)
    if (since.length > 0) cb(since)
    return () => {
      const s = this.subscribers.get(roomId)
      if (s !== undefined) { s.delete(cb); if (s.size === 0) this.subscribers.delete(roomId) }
    }
  }

  /** Resolve a bot name from the state accessor (used by ApprovalBridge). */
  botName(botId: string): string {
    return this.svc.getBot(botId)?.name ?? botId
  }

  /**
   * Force every streaming entry of one run to settled.
   *
   * A run can end through several paths (completion, throw, silent early
   * return, retry, cancellation). Rather than rely on each of them remembering
   * to finalise, this is called whenever a run settles, so no entry can be left
   * flagged `streaming: true` — which is what pinned the panel on「深度求索中」
   * until the room was reloaded.
   */
  settleRunEntries(runId: string, roomId: BotRoomId, durationMs?: number): number {
    const list = this.byRoom.get(roomId)
    if (list === undefined) return 0
    let settled = 0
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!
      // Only bot-text rows carry both `runId` and `streaming`.
      if (e.type !== 'bot-text' || e.runId !== runId) continue
      // Stamp the duration on every row of the run, not just the streaming one: the
      // panel reads it from the turn's first bot-text row, and a run that produced
      // no streamed text still needs the footer.
      const next = {
        ...e,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(e.streaming === true ? { streaming: false } : {}),
        rev: e.rev + 1,
      } as LedgerEntry
      ;(list as LedgerEntry[])[i] = next
      if (e.streaming === true || durationMs !== undefined) settled++
    }
    if (settled > 0) {
      const subs = this.subscribers.get(roomId)
      if (subs !== undefined) {
        for (const cb of subs) cb(list.filter(e => e.type === 'bot-text' && e.runId === runId))
      }
    }
    return settled
  }

  /** Whether any bot-text row for this run already carries a duration. */
  roomHasRunDuration(roomId: BotRoomId, runId: string): boolean {
    const list = this.byRoom.get(roomId)
    if (list === undefined) return false
    return list.some(e => e.type === 'bot-text' && e.runId === runId && e.durationMs !== undefined)
  }

  /**
   * A run's tool calls, in call order, for persistence onto the settled message.
   *
   * The tool cards are projected FROM SESSION EVENTS, which are process-local: the
   * ledger is in-memory and is only rebuilt from `state.messages` at startup, so without
   * this the tool section of a turn disappeared on the next reload while the answer and
   * the reasoning survived. `seedLedgerRoom` already knows how to rebuild those rows from
   * `toolActivity` — nothing had ever filled it in for the native-agent path.
   *
   * `detail` is the tool's own output, truncated: it is a display summary, and a tool
   * result can be hundreds of kilobytes.
   */
  toolActivityFromRun(
    roomId: string,
    runId: string,
  ): Array<{ name: string; status: string; detail?: string }> {
    const list = this.byRoom.get(roomId)
    if (list === undefined) return []
    const out: Array<{ name: string; status: string; detail?: string }> = []
    for (const call of list) {
      if (call.type !== 'tool-call' || call.runId !== runId) continue
      const result = list.find(
        (e): e is Extract<LedgerEntry, { type: 'tool-result' }> =>
          e.type === 'tool-result' && e.runId === runId && e.callId === call.callId,
      )
      const detail = result?.output ?? ''
      out.push({
        name: call.name,
        // No result yet means the call was still in flight when the run closed (a stop,
        // or a failed run) — reported as such rather than silently successful.
        status: result === undefined ? 'running' : result.ok ? 'ok' : 'error',
        ...(detail === '' ? {} : { detail: detail.length > 1000 ? `${detail.slice(0, 1000)}…` : detail }),
      })
    }
    return out
  }

  /** Remove all entries for a room (called by clearMessages). */
  clearRoom(roomId: string): void {
    this.byRoom.delete(roomId)
    this.pendingBatch.delete(roomId)
    this.subscribers.delete(roomId)
  }
}
