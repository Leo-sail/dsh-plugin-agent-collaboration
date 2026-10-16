/**
 * BotConversationPanel — top-level conversation UI for both DM and group rooms.
 * Composes TranscriptArea + ComposerArea + SessionHeader.
 * Data comes from the plugin's own ledger RPC — no DSH session dependency.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import type { CSSProperties } from 'react'
import type { LedgerEntry, AttachmentItem, InFlightMessage } from './types.ts'
import {
  IconChevronDownOutlineRegular, IconPanelLeftOutlineRegular,
} from './NativeIcons.tsx'
import { TranscriptArea } from './TranscriptArea.tsx'
import { ComposerArea } from './ComposerArea.tsx'
import { QuestionComposer, pendingQuestion } from './QuestionComposer.tsx'
import { TaskDockCard, currentRoundTasks, currentRoundTodos, shouldShowTaskDock, type RoomTaskRow } from './TaskDockCard.tsx'
import type { ComposerProps } from './ComposerArea.tsx'
import { QUEUE_LABEL, QUEUE_NOTE, QUEUE_WAIT_PREVIOUS, QUEUE_WAIT_SLOT } from './nativeStrings.ts'

export interface BotInfo { id: string; name: string; avatarSeed?: string | undefined }
export interface RunInfo {
  id: string
  botId: string
  status: string
  /** Run timing, straight from the host's run record. */
  startedAt?: string | undefined
  finishedAt?: string | undefined
  /**
   * When the run was queued.
   *
   * Needed to tell a real wait from a scheduling instant: the host parks a run as
   * `queued` and its executor picks it up on the next tick, so every run passes
   * through `queued` for a moment even when nothing is contending for a slot.
   */
  createdAt?: string | undefined
  /**
   * Why the host parked the run, when it reports a cause. §22.1 requires `queued` to
   * be distinguishable from "stuck", so the panel reads the host's own wording
   * instead of guessing from the status alone. Optional because the field name is
   * the host's to choose — any of the three below is accepted.
   */
  queueReason?: string | undefined
  lastError?: string | undefined
  error?: string | undefined
}

/** Host wording that means "no free Agent slot" (§22.1 LRU overflow). */
const SLOT_PRESSURE_RE = /槽位|slot|容量|capacity|并发|concurren|LRU/i

/**
 * Timer origins for the transcript, keyed by run id.
 *
 * The host stamps `startedAt` when the run leaves the queue, so this is the ONLY
 * source that exists during the thinking phase. The ledger cannot stand in for it:
 * the live projection pushes its first `bot-text` row without an `at` at all, so
 * `Date.parse(entries[0].at)` is NaN exactly while a run is running — which is why
 * the whale swam with no 用时 next to it. Unparseable values are dropped rather
 * than turned into NaN entries, so the ledger fallback still applies.
 */
export function runStartTimes(runs: readonly RunInfo[]): Map<string, number> {
  const starts = new Map<string, number>()
  for (const run of runs) {
    const at = run.startedAt !== undefined ? Date.parse(run.startedAt) : Number.NaN
    if (Number.isFinite(at)) starts.set(run.id, at)
  }
  return starts
}

export interface QueueState {
  /** How many of this room's runs have not started yet. */
  readonly count: number
  /** The host named an Agent-slot shortage, rather than just "another run is busy". */
  readonly waitingForSlot: boolean
  readonly detail: string
}

/**
 * Describe this room's parked runs, or `undefined` when nothing is queued.
 *
 * The point is the two-cause split: a user staring at a bot that has not answered
 * must be able to tell "waiting for a slot" from "stuck", and a banner that only said
 * "运行中" told them neither.
 */
/**
 * How long a run must sit queued before the wait is worth reporting.
 *
 * Every run is created as `queued` and claimed on the executor's next tick (~250ms),
 * so an unqualified "any queued run" test lit the banner for a scheduling instant on
 * every single message — a group of four bots looked serialised when all four in fact
 * started together. Only a wait that outlives a tick is a wait the user needs told
 * about.
 */
export const QUEUE_NOTICE_MS = 1_500

export function describeQueue(runs: readonly RunInfo[], now = Date.now()): QueueState | undefined {
  const queued = runs.filter(r => {
    if (r.status !== 'queued') return false
    // A run the host itself flagged as waiting for a slot is always worth reporting,
    // however recently it was parked — the host knows something the clock does not.
    if (SLOT_PRESSURE_RE.test(`${r.queueReason ?? ''} ${r.lastError ?? ''} ${r.error ?? ''}`)) return true
    // Without a creation time the age is unknowable; fall back to reporting it, since
    // staying silent about a real wait is worse than a brief flash.
    const born = r.createdAt !== undefined ? Date.parse(r.createdAt) : Number.NaN
    if (!Number.isFinite(born)) return true
    return now - born >= QUEUE_NOTICE_MS
  })
  if (queued.length === 0) return undefined
  const waitingForSlot = queued.some(r =>
    SLOT_PRESSURE_RE.test(`${r.queueReason ?? ''} ${r.lastError ?? ''} ${r.error ?? ''}`),
  )
  return {
    count: queued.length,
    waitingForSlot,
    detail: waitingForSlot ? QUEUE_WAIT_SLOT : QUEUE_WAIT_PREVIOUS,
  }
}

export interface BotConversationPanelProps {
  roomId: string
  roomName: string
  isGroup: boolean
  bots: BotInfo[]
  runs: RunInfo[]
  modelGroups: Array<{ id: string; label?: string; models: Array<{ id: string; name?: string }> }>
  /** Skills available to the room's bot. */
  skills?: ReadonlyArray<{ id: string; name: string; description: string; path: string }> | undefined
  /** Load a skill's full text for direct invocation. */
  onLoadSkill: (name: string) => Promise<{ name: string; content: string } | undefined>
  /** Shallow listing of a skill directory, to avoid filesystem exploration. */
  onListSkillFiles: (dir: string) => Promise<Array<{ path: string; isDir: boolean }>>
  /** Populated when the skill RPC failed, so an empty group is explicable. */
  skillsError?: string | undefined
  onSend: (roomId: string, text: string, modelPayload: string, attachments: AttachmentItem[], mentions: string[]) => Promise<void>
  /** The room's task board, straight from the polled snapshot. */
  tasks?: ReadonlyArray<RoomTaskRow> | undefined
  /** The room's current round (its task board's counter), so the dock refreshes per round. */
  round?: number | undefined
  onStop: (roomId: string) => Promise<void>
  onApprove: (callId: string) => Promise<void>
  onReject: (callId: string) => Promise<void>
  /**
   * Answer (or skip) the question a bot is blocked on. Optional: a host that renders the panel
   * without question support simply shows no dialog.
   */
  onAnswerQuestion?: ((questionId: string, answer: string) => Promise<void>) | undefined
  onSkipQuestion?: ((questionId: string) => Promise<void>) | undefined
  onCommand: (roomId: string, cmdId: string, subId?: string) => void
  /** Clear this room's transcript. Must reset the panel's own ledger view. */
  onClear: (roomId: string) => void | Promise<void>
  /**
   * Download this room's transcript.
   *
   * WHY THIS PROP EXISTS. `exportTranscript.ts` was written, imported by ConversationArea — and
   * never called: no button, no command, and not one occurrence of 导出 anywhere in the UI. The
   * feature was unreachable dead code, measured by driving the real panel and finding no control
   * to click. Wiring it to a real button is the whole fix.
   */
  onExport?: (() => void) | undefined
  /** Toggle the room list, mirroring the native top bar's panel-left control. */
  /** Room switcher entries for the title chip's dropdown. */
  listLedger: (roomId: string, opts?: {
    beforeSequence?: number
    afterSequence?: number
    changedAfterSequence?: number
    limit?: number
    /** Ignore cursors and return the room's current rows. */
    force?: boolean
  }) => Promise<LedgerEntry[]>
  /**
   * Fork this conversation's bot from a chosen message. Omitted → no button.
   * Only meaningful for a direct (single-bot) room.
   */
  onFork?: ((messageId: string) => void) | undefined
}

const PAGE_SIZE = 50

/**
 * Order transcript rows by when they happened.
 *
 * `sequence` alone is not safe: it is a ledger-internal counter, and any path that
 * renumbers rows (a re-seed from persisted state) breaks the correspondence with the
 * real send order — a tool row was once sorted above the user message that preceded
 * it. `at` is the actual event time, so it orders correctly regardless of numbering.
 */
/** Stable empty list: a fresh array every render would defeat memoized children. */
const EMPTY_TASKS: ReadonlyArray<RoomTaskRow> = []

/**
 * When the room's current round began: the newest user turn in the ledger.
 *
 * The ledger is the panel's single render source, so this needs no extra data — and it is
 * exactly the boundary the task dock needs in order to drop the previous round's todos
 * (taking the newest `todo_write` unconditionally is why the card never went away).
 */
function roundStartOf(entries: ReadonlyArray<LedgerEntry>): string | undefined {
  let newest: string | undefined
  for (const entry of entries) {
    if (entry.type !== 'user') continue
    const at = String((entry as { at?: string }).at ?? '')
    if (at !== '' && (newest === undefined || at > newest)) newest = at
  }
  return newest
}

function byTimeThenSequence(a: LedgerEntry, b: LedgerEntry): number {
  const ta = Date.parse(a.at)
  const tb = Date.parse(b.at)
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
  return a.sequence - b.sequence
}

export function BotConversationPanel({
  roomId, roomName, isGroup, bots, runs, modelGroups, skills, onLoadSkill, onListSkillFiles, skillsError,
  onSend, onStop, onApprove, onReject, onAnswerQuestion, onSkipQuestion, onCommand, onClear, listLedger, onFork, tasks, round,
}: BotConversationPanelProps) {
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [queue, setQueue] = useState<InFlightMessage[]>([])
  const [busy, setBusy] = useState(false)
  // Ledger fetch failures were swallowed by empty catch blocks, which made a broken
  // RPC indistinguishable from an empty room. Surface the failure instead.
  const [ledgerError, setLedgerError] = useState<string | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement>(null)
  // Use a ref so the polling interval always sees the latest entries without
  // being re-created on every entries update (which would restart the timer).
  const entriesRef = useRef<LedgerEntry[]>([])
  useEffect(() => { entriesRef.current = entries }, [entries])

  const isRunning = runs.some(r =>
    (isGroup ? true : bots.some(b => b.id === r.botId)) &&
    (r.status === 'running' || r.status === 'queued')
  )

  // §22.1: visible queue state. Computed from the run records rather than from the
  // ledger, because a queued run has produced no ledger row yet — which is precisely
  // why "no answer" looked identical to "stuck" before.
  const queueState = describeQueue(runs)
  /** A bot is blocked on this question: it takes the composer's place until answered. */
  const question = pendingQuestion(entries)

  // Load ledger on mount and when roomId changes
  const loadInitial = useCallback(async () => {
    try {
      const data = await listLedger(roomId, { limit: PAGE_SIZE })
      // Merge by id instead of replacing the array.
      //
      // The host re-seeds a room's ledger rows when a run settles (so the persisted
      // reply, including its duration, reaches the client) and those rows get FRESH
      // sequence numbers. A hard replace therefore reordered the whole transcript in
      // one commit — visible as the message list flashing and a row appearing to
      // duplicate. Merging keeps every row we already hold and updates it in place.
      setEntries(prev => {
        const byId = new Map(prev.map(e => [e.id, e]))
        for (const e of data) byId.set(e.id, e)
        return Array.from(byId.values()).sort(byTimeThenSequence)
      })
      setHasEarlier(data.length >= PAGE_SIZE)
      setLedgerError(undefined)
    } catch (e) {
      setLedgerError(e instanceof Error ? e.message : String(e))
    }
  }, [roomId, listLedger])

  useEffect(() => {
    setEntries([])
    setQueue([])
    void loadInitial()
  }, [roomId, loadInitial])

  // Poll for new entries. The interval is deliberately very short because a room's
  // own message must appear the moment it is sent. That is only affordable because
  // the poll is cursor-based: it asks the host for entries strictly after the last
  // sequence it holds, so each tick transfers just the delta rather than the whole
  // room history.
  // IMPORTANT: entries must NOT be in the deps array — it causes the interval
  // to restart on every update. Use entriesRef to read the latest value instead.
  useEffect(() => {
    let mounted = true
    let inFlight = false
    const tick = async () => {
      if (!mounted || inFlight) return
      inFlight = true
      try {
        const current = entriesRef.current
        const cursor = current[current.length - 1]?.sequence ?? 0
        // Inclusive cursor: the entry AT the cursor may have been patched since the
        // last poll (streaming text grows, then `streaming` flips to false). Asking
        // for sequence > cursor would never re-deliver it, leaving the turn stuck
        // on "thinking…" until a full reload. Merging by id makes re-sends harmless.
        //
        // `force: true` while a run is live. The host gives a room's rows FRESH
        // sequence numbers when it re-seeds them from persisted messages, and those
        // numbers can land BELOW the cursor this client already holds — a cursor
        // query then returns rows that are all older than the cursor, so the settled
        // reply and its duration were never delivered. The panel showed the turn as
        // unfinished until the reader left the room (which re-mounted it with a zero
        // cursor). Asking for the whole room while it is live is bounded by the
        // room's own size and removes the ordering assumption entirely.
        const data = await listLedger(
          roomId,
          isRunning
            ? { limit: 1000, force: true }
            : { changedAfterSequence: cursor, limit: 300 },
        )
        if (!mounted) return
        setLedgerError(undefined)
        if (data.length > 0) {
          setEntries(prev => {
            const idMap = new Map(prev.map(e => [e.id, e]))
            let changed = false
            for (const e of data) {
              const before = idMap.get(e.id)
              // `rev` is bumped by the host on every in-place update (`types.ts`), so an identical
              // re-send is detectable without deep comparison. Returning the SAME array when nothing
              // changed is what keeps React from re-rendering the whole transcript on every tick —
              // the merge used to rebuild and re-sort the room on each poll regardless.
              if (before !== undefined && (before as { rev?: number }).rev === (e as { rev?: number }).rev) continue
              idMap.set(e.id, e)
              changed = true
            }
            if (!changed) return prev
            return Array.from(idMap.values()).sort(byTimeThenSequence)
          })
        }
      } catch (e) {
        if (mounted) setLedgerError(e instanceof Error ? e.message : String(e))
      } finally {
        inFlight = false
      }
    }
    // ── POLLING COST ────────────────────────────────────────────────────────────────────────────
    // 25 ms while a run was live meant forty ledger RPCs per second, per open room, each carrying a
    // 15 s deadline — with the panel's own snapshot poll on top. The call is cursor-based
    // (`changedAfterSequence`), so nothing is missed by asking less often: 250 ms still reads as
    // live typing, and 1 s idle is indistinguishable from instant for a settled transcript.
    const every = isRunning ? 250 : 1000
    const interval = setInterval(() => {
      // A hidden tab (or a minimised window) needs no updates at all; the next visible tick
      // catches up because the cursor is unchanged.
      if (typeof document !== 'undefined' && document.hidden === true) return
      void tick()
    }, every)
    const onVisible = (): void => { if (typeof document !== 'undefined' && document.hidden === false) void tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { mounted = false; clearInterval(interval); document.removeEventListener('visibilitychange', onVisible) }
  }, [roomId, isRunning, listLedger])

  // Force a FULL reload the moment a run stops being live.
  //
  // The incremental tick above advances a cursor derived from the newest entry it
  // already holds, so the final state of the turn — the settled text, its duration,
  // and the settle that clears `streaming` — could be missed: the panel then showed
  // the turn as still running until the reader left the room and came back, which
  // re-mounted the component and reloaded from scratch. A run ending is exactly the
  // moment the panel must re-read, so do it explicitly.
  // Count of runs that have reached a terminal state. Each new one re-reads the
  // ledger in full.
  //
  // Watching only the live->idle transition missed replies: two bots can settle in
  // the same tick, and a run that starts and finishes between two snapshot samples
  // never flips the flag at all. The panel then showed no answer until the reader
  // left the room and came back (which re-mounted it). A monotonic settled count is
  // a signal that cannot be skipped.
  const settledRuns = runs.filter(r => r.status !== 'running' && r.status !== 'queued').length
  const seenSettled = useRef(settledRuns)
  useEffect(() => {
    if (settledRuns <= seenSettled.current) { seenSettled.current = settledRuns; return }
    seenSettled.current = settledRuns
    // Re-read now, and once more shortly after.
    //
    // The incremental poll stops the moment the snapshot reports the run as idle, so
    // the settled row (streaming cleared, duration stamped) could arrive with nobody
    // listening: the turn kept showing the whale and its live timer, and no duration,
    // until the reader left the room. The immediate read closes that window; the
    // delayed one covers a settle that lands a beat after the snapshot.
    void loadInitial()
    const t = setTimeout(() => { void loadInitial() }, 400)
    return () => clearTimeout(t)
  }, [settledRuns, loadInitial])

  // Load earlier entries (pagination)
  const handleLoadEarlier = useCallback(async () => {
    if (loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const firstSeq = entries[0]?.sequence
      const data = await listLedger(roomId, { ...(firstSeq !== undefined ? { beforeSequence: firstSeq } : {}), limit: PAGE_SIZE })
      if (data.length > 0) {
        setEntries(prev => [...data, ...prev])
        setHasEarlier(data.length >= PAGE_SIZE)
      } else {
        setHasEarlier(false)
      }
    } catch { /* ignore */ }
    finally { setLoadingEarlier(false) }
  }, [loadingEarlier, entries, roomId, listLedger])

  // Find pending approval from latest entries
  const pendingApproval = entries.slice().reverse().find(e => e.type === 'approval' && e.outcome === undefined)

  // Send handler
  const handleSend = useCallback(async (text: string, modelPayload: string, attachments: AttachmentItem[], mentions: string[]) => {
    if (busy) return
    const id = Math.random().toString(36).slice(2)
    setQueue(q => [...q, { id, text }])
    setBusy(true)
    try {
      await onSend(roomId, text, modelPayload, attachments, mentions)
    } finally {
      setQueue(q => q.filter(m => m.id !== id))
      setBusy(false)
    }
  }, [busy, roomId, onSend])

  // Stop handler
  const handleStop = useCallback(async () => {
    await onStop(roomId)
  }, [roomId, onStop])

  // Approve/reject
  const handleApprove = useCallback(async (callId: string) => {
    await onApprove(callId)
  }, [onApprove])

  const handleReject = useCallback(async (callId: string) => {
    await onReject(callId)
  }, [onReject])

  // Queue management (local only — no server queue yet)
  const handleEditQueue = useCallback((id: string, text: string) => {
    setQueue(q => q.map(m => m.id === id ? { ...m, text } : m))
  }, [])
  const handleRemoveQueue = useCallback((id: string) => {
    setQueue(q => q.filter(m => m.id !== id))
  }, [])
  const handleSteerQueue = useCallback((_id: string) => {
    // Steer = send immediately; for now same as normal send
  }, [])

  // Command handler
  const handleCommand = useCallback((cmdId: string, subId?: string) => {
    onCommand(roomId, cmdId, subId)
  }, [roomId, onCommand])

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex', flexDirection: 'column',
        height: '100%', minHeight: 0,
        // The panel is a flex item of the page's grid column; without `min-width: 0`
        // its automatic minimum is content-based, so one over-wide child could widen
        // the whole panel (and push right-aligned content out of view) instead of
        // being clipped inside the transcript.
        minWidth: 0, maxWidth: '100%', overflow: 'hidden',
        background: 'var(--dsw-alias-bg-base)',
      }}
    >
      {/* Header */}
      <SessionHeader
        name={roomName}
        isGroup={isGroup}
        isRunning={isRunning}
        onStop={handleStop}
        onClear={() => {
          // Reset the local view and the poll cursor FIRST: the cursor is derived
          // from the last known sequence, so clearing entries makes the next poll
          // re-read from zero instead of re-merging the pre-clear rows back in.
          setEntries([])
          setHasEarlier(false)
          void Promise.resolve(onClear(roomId)).then(() => loadInitial()).catch(() => undefined)
        }}
      />

      {/* Ledger RPC failure — never silently show an empty room for a broken fetch */}
      {ledgerError !== undefined && (
        <div style={{
          flexShrink: 0,
          padding: '6px 12px',
          fontSize: 12,
          lineHeight: '18px',
          fontFamily: 'monospace',
          color: 'var(--dsw-alias-state-error-primary)',
          background: 'var(--dsw-alias-bg-base)',
          borderBottom: '0.5px solid var(--dsw-alias-state-error-primary)',
          overflowWrap: 'anywhere',
        }}>
          消息加载失败（listLedger）：{ledgerError}
        </div>
      )}

      {/* Queue banner (§22.1). A parked run has no transcript row yet, so without
          this the room is silent and the user cannot tell a waiting bot from a
          broken one. `role="status"` because it announces a state change. */}
      {queueState !== undefined && (
        <div className="ac-queue-banner" role="status" data-reason={queueState.waitingForSlot ? 'agent-slots' : 'previous-run'}>
          <span className="ac-queue-pill">
            <span className="ac-queue-dot" aria-hidden="true" />
            {QUEUE_LABEL}{queueState.count > 1 ? ` ${queueState.count}` : ''}
          </span>
          <span className="ac-queue-detail">{queueState.detail}</span>
          <span className="ac-queue-note">{QUEUE_NOTE}</span>
        </div>
      )}

      {/* Main area. `display:flex` is load-bearing: TranscriptArea sizes itself
          with `flex:1; min-height:0`, which only resolves inside a flex parent —
          without it the transcript's height collapses and the message list can no
          longer scroll. `position:relative` is added on top so the absolutely
          positioned rail slot has a containing block; the rail overlays the
          transcript instead of taking a flex column, matching the native layout. */}
      <div style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* §24.8: the leader's final report is projected into the ledger as an
            ordinary `bot-text` row, so it renders HERE like any other group message.
            A dedicated leader surface is explicitly not wanted — nothing in this
            panel special-cases the leader, and nothing should. */}
        <TranscriptArea
          entries={entries}
          onLoadEarlier={handleLoadEarlier}
          loadingEarlier={loadingEarlier}
          hasEarlier={hasEarlier}
          bots={bots.map(b => ({ id: b.id, name: b.name, avatarSeed: b.avatarSeed }))}
          onFork={isGroup ? undefined : onFork}
          skillNames={new Set((skills ?? []).map(sk => sk.name))}
          liveRunIds={new Set(runs.filter(r => r.status === 'running' || r.status === 'queued').map(r => r.id))}
          /* A user stop settles the run as `interrupted` (cancel writes `cancelled`).
             Native labels those 已停止 and hides the duration, so the transcript needs
             the reason explicitly — an absent duration is not evidence of a stop. */
          stoppedRunIds={new Set(runs.filter(r => r.status === 'interrupted' || r.status === 'cancelled').map(r => r.id))}
          /* Durations straight from the run record: available the moment the snapshot
             reports the run finished, with no dependency on the ledger at all. */
          runDurations={new Map(runs.flatMap(r => {
            const a = r.startedAt !== undefined ? Date.parse(r.startedAt) : Number.NaN
            const b = r.finishedAt !== undefined ? Date.parse(r.finishedAt) : Number.NaN
            return Number.isFinite(a) && Number.isFinite(b) && b > a
              ? [[r.id, Math.max(1000, b - a)] as const] : []
          }))}
          /* Timer origins, same source. While the model thinks, the turn has no usable
             ledger row at all, so `entries[0]` was undefined and the deep-diving row
             rendered without its 用时 — the run record is the only authority then. */
          runStarts={runStartTimes(runs)}
        />
      </div>

      {/* Task dock (§ native `conversation.input.dock`): the room's CURRENT round plus each
          bot's live todo list, docked above the composer and OUTSIDE the transcript's scroll
          area, so folding it never moves the reading position. It is a live-work surface:
          once the round is done and nothing is running it hides itself again. */}
      {(() => {
        const roundTasks = currentRoundTasks(tasks ?? EMPTY_TASKS, round)
        const roundTodos = currentRoundTodos(entries, roundStartOf(entries))
        // Live-ness only decorates the card (the dot); whether it appears at all is decided by
        // whether this round has real work — see shouldShowTaskDock.
        const running = runs.some(r => r.status === 'running' || r.status === 'queued')
        if (!shouldShowTaskDock({ tasks: roundTasks, todos: roundTodos, running })) return null
        return <TaskDockCard tasks={roundTasks} todos={roundTodos} running={running} />
      })()}

      {/* QUESTION TAKES OVER THE INPUT BOX while a bot is blocked on it — the answer is typed
          where every other message is typed, and the composer returns once it is answered. */}
      {question !== undefined ? (
        <QuestionComposer
          view={question}
          onAnswer={onAnswerQuestion ?? (() => undefined)}
          onSkip={onSkipQuestion ?? (() => undefined)}
        />
      ) : (
      /* Composer */
      <ComposerArea
        roomId={roomId}
        isGroup={isGroup}
        bots={bots}
        isRunning={isRunning}
        {...(pendingApproval !== undefined ? { pendingApproval } : {})}
        queue={queue}
        modelGroups={modelGroups}
        {...(skills !== undefined ? { skills } : {})}
        onLoadSkill={onLoadSkill}
        onListSkillFiles={onListSkillFiles}
        {...(skillsError !== undefined ? { skillsError } : {})}
        onSend={handleSend}
        onStop={handleStop}
        onApprove={handleApprove}
        onReject={handleReject}
        onEditQueue={handleEditQueue}
        onRemoveQueue={handleRemoveQueue}
        onSteerQueue={handleSteerQueue}
        onCommand={handleCommand}
      />
      )}
    </div>
  )
}

// ── SessionHeader (native top bar) ───────────────────────────────────────────

const clearBtn: CSSProperties = {
  height: 28, flexShrink: 0, padding: '0 10px',
  display: 'inline-flex', alignItems: 'center',
  border: '0.5px solid var(--dsw-alias-border-l3)',
  borderRadius: 'var(--dsw-radius-sm, 4px)',
  background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12, cursor: 'pointer',
}

// ── SessionHeader ─────────────────────────────────────────────────────────────

function SessionHeader({
  name, isGroup, isRunning, onStop, onClear, onExport,
}: {
  name: string
  isGroup: boolean
  isRunning: boolean
  onStop: () => void
  onClear: () => void
  onExport?: (() => void) | undefined
}) {
  const iconBtn: CSSProperties = {
    width: 28, height: 28, flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', borderRadius: 'var(--dsw-radius-sm, 4px)',
    background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer', padding: 0,
  }

  return (
    <div style={{
      flexShrink: 0, position: 'relative',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 8, padding: '14px 12px 10px',
      background: 'var(--dsw-alias-bg-base)',
    }}>
      {/* Right: run control and clear, nothing else. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        {isRunning && (
          <button type="button" onClick={onStop} style={{ ...iconBtn, color: 'var(--dsw-alias-state-error-primary)' }} aria-label="停止">
            <svg width={10} height={10} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              <rect x="1" y="1" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        )}
        {/* Direct control, no overflow menu — the user asked for the clear action
            itself in the bar rather than hidden behind a "···". */}
        {onExport !== undefined && (
          <button type="button" onClick={onExport} style={clearBtn}>导出</button>
        )}
        <button type="button" onClick={onClear} style={clearBtn}>清空消息</button>
      </div>
    </div>
  )
}
