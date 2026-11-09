/**
 * LedgerProjection — turn native `Session` events into Bot Community transcript rows.
 *
 * WHY THIS EXISTS
 * Bot turns used to be driven by a loop this plugin owned, so the transcript was a
 * side effect of that loop: every `ledger.push()` sat next to the streaming code that
 * produced it. Turns now run through native DSH agents, so the content arrives as
 * **session events** instead, and the transcript has to be derived from them.
 *
 * WHAT CHANGES AND WHAT DOES NOT
 * Only the *source* of the data changes. The ledger's shape, the cursor semantics and
 * the whole UI stay exactly as they are — `BotConversationPanel`, `TranscriptArea`,
 * `MessageRows` and `ToolRow` keep reading the same entries.
 *
 * THREE DELIBERATE LIMITS, each guarding a behaviour that was hard to get right:
 *
 *  1. **`user/message` is ignored.** The service pushes user rows when it accepts a
 *     message. Projecting them here as well would double every user message, and the
 *     repair/seed prompts this plugin sends are user-channel messages that must NOT
 *     appear as if the user typed them.
 *  2. **Duration is not written here.** `settleRunEntries` stamps it from the run
 *     record, which is the source that made "已完成，用时 …" reliable — it arrives in
 *     the same snapshot that reports the run finished, with no dependence on ledger
 *     cursor or poll timing. Re-deriving it from turn events would put that back at
 *     risk, so the projection leaves the field alone.
 *  3. **Live frames and committed events both write, but only one wins.** The stream
 *     frames give the typing effect; the committed `assistant/message` is the
 *     authority on the final text. A committed message always overwrites whatever the
 *     stream accumulated, so a dropped or truncated frame cannot corrupt the result.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionRunner } from './session-runner.ts'
import type { LedgerProjector } from './ledger.ts'
import type { RunPublish } from './publish-policy.ts'

/** What the projection needs from the community service. */
export interface LedgerProjectionDeps {
  readonly ledger: LedgerProjector
  /** Display name for a bot, falling back to its id when it is gone. */
  readonly botName: (botId: string) => string
  /** The run currently driving a pair, so rows land inside the right turn. */
  readonly runIdFor: (roomId: string, botId: string) => string | undefined
  /**
   * Whether the current run's turn may appear in the room.
   *
   * COORDINATION IS NOT CONVERSATION. A turn woken by another bot's report is internal
   * machinery: the user did not ask for it and cannot act on it, and its prose restates
   * what the members already said — the duplicate the user reported as "answered twice".
   * Such a run gets NO rows here. What it does owe the user (a `finish_task` report) is
   * published once by `settleRun`, the single delivery path.
   *
   * This is the run's own flag (`BotRun.publish`) read from the live run, so a visible
   * run renders exactly as before. Undefined means "no live run": a title stream, which
   * the `silent` gate below already drops.
   */
  readonly runPublishFor?: (roomId: string, botId: string) => RunPublish | undefined
  /**
   * Legacy fallback for hosts that only know the run's origin.
   *
   * Kept so an older service (or a test that constructs this projection directly) still
   * gets the origin-based rule; `INTERNAL_RUN_ORIGINS` is consulted only when
   * `runPublishFor` does not answer.
   */
  readonly runOriginFor?: (roomId: string, botId: string) => string | undefined
}

/**
 * Runs that exist to move work between bots, never to speak to the user.
 *
 * `a2a` and `bot-message` are peer messages; `team-report` is a member's report reaching the
 * leader. The leader's deliverable does not depend on any of them being rendered: it is posted by
 * `finish_task`, and a user-triggered turn renders normally.
 */
const INTERNAL_RUN_ORIGINS = new Set(['a2a', 'bot-message', 'team-report'])

/** One in-flight model attempt, keyed by its attempt id. */
interface AttemptState {
  readonly roomId: string
  readonly botId: string
  /** Ledger row holding the streamed answer, created lazily on the first delta. */
  textEntryId?: string | undefined
  /** Rows must not be created for this attempt (a non-run stream such as the session title). */
  silent?: boolean | undefined
  /** Ledger row holding the streamed reasoning, created lazily. */
  reasoningEntryId?: string | undefined
  text: string
  reasoning: string
}

/** The subset of a stream frame this projection reads. */
interface StreamFrame {
  readonly type?: string
  readonly attemptId?: string
  readonly chunk?: { readonly type?: string; readonly text?: string }
}

/** The subset of a session event this projection reads. */
interface SessionEventLike {
  readonly type?: string
  readonly data?: Record<string, unknown>
}

const textOf = (blocks: unknown): string => {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') out += b.text
  }
  return out
}

export class LedgerProjection {
  private readonly deps: LedgerProjectionDeps
  private readonly attempts = new Map<string, AttemptState>()

  constructor(deps: LedgerProjectionDeps) {
    this.deps = deps
  }

  /**
   * Whether the pair's current run is internal (coordination, not an answer).
   *
   * `runPublishFor` is the authoritative answer: it is the run's own flag, so a visible
   * run renders exactly as before. The origin fallback keeps an older host working and is
   * what makes `INTERNAL_RUN_ORIGINS` a rule that is actually consulted rather than a
   * constant that only described the intent.
   */
  private isInternalRun(roomId: string, botId: string): boolean {
    const publish = this.deps.runPublishFor?.(roomId, botId)
    if (publish !== undefined) return publish === 'internal'
    const origin = this.deps.runOriginFor?.(roomId, botId)
    return origin !== undefined && INTERNAL_RUN_ORIGINS.has(origin)
  }

  /**
   * Subscribe to both streams.
   *
   * `global: true` is required: the frames are emitted from each agent's own scoped
   * dispatcher, so a non-global listener would only ever see the first agent.
   */
  install(ctx: Context): () => void {
    const bus = ctx as unknown as {
      on?(
        event: string,
        handler: (payload: unknown) => void,
        opts?: { prepend?: boolean; global?: boolean },
      ): () => void
    }
    if (typeof bus.on !== 'function') return () => { /* noop */ }

    const offFrame = bus.on('agent/assistant-stream', (payload) => {
      const frame = (payload as { frame?: StreamFrame } | undefined)?.frame
      if (frame !== undefined) this.onFrame(frame)
    }, { global: true })

    const offEvent = bus.on('session/event', (...args: unknown[]) => {
      // The listener contract is `(session, event)` — TWO arguments, verified against
      // the host's own event registry (`session/event`: "'(this: Scoped<Session>,
      // session: Session, event: SessionEvent): void'") and against the shipped
      // consumer in `@deepseek-ai/dsh-api-session-controller`, which registers
      // `ctx.on('session/event', (session, event) => …)`.
      //
      // Reading them as ONE array payload (`payload[0]`, `payload[1]`) therefore made
      // `session` undefined on every dispatch and this method returned immediately:
      // no `tool/call`, no `tool/result`, no committed `assistant/message` was ever
      // projected. That is why a running bot showed no tool cards at all — the rows
      // were never created, whatever the UI did. A single array argument is still
      // accepted so a harness that emits `[session, event]` keeps working.
      const [first, second] = args.length === 1 && Array.isArray(args[0])
        ? (args[0] as [unknown, SessionEventLike])
        : (args as [unknown, SessionEventLike])
      const sessionId = (first as { id?: string } | undefined)?.id
      if (typeof sessionId !== 'string' || second === undefined) return
      this.onSessionEvent(sessionId, second)
    }, { global: true })

    return () => {
      offFrame()
      offEvent()
    }
  }

  /**
   * Resolve an attempt id back to its pair.
   *
   * The loop builds it as `` `${sessionId}:${attempt}` `` (verified in
   * `AssistantStreamAttempt`'s constructor), and our session ids are
   * `ac:<roomId>:<botId>`, so dropping the trailing counter recovers the session id
   * and `parseSessionId` recovers the pair.
   */
  private resolveAttempt(attemptId: string): { roomId: string; botId: string } | undefined {
    const cut = attemptId.lastIndexOf(':')
    if (cut < 0) return undefined
    return SessionRunner.parseSessionId(attemptId.slice(0, cut))
  }

  private onFrame(frame: StreamFrame): void {
    const attemptId = frame.attemptId
    if (typeof attemptId !== 'string') return

    if (frame.type === 'start') {
      const owner = this.resolveAttempt(attemptId)
      if (owner === undefined) return

      // ── ONLY A RUN'S OWN STREAM BECOMES A REPLY ────────────────────────────────
      //
      // DSH issues an EXTRA model call per session to generate its title
      // (`session/title-llm-request`), and this observer is installed with
      // `{ global: true }`, so that stream reached it too and was recorded as another
      // answer from the same bot — the same reply twice in a 1:1, and nine avatars for
      // four bots in a group (four replies plus four title streams plus one).
      //
      // A title request happens when no run is live for the pair, so requiring a live
      // run admits exactly the streams that are an answer. This is also why the
      // duplicate survived every earlier fix: none of them were looking at WHICH
      // requests produce frames.
      // `silent` marks an attempt whose rows must NOT be created — DSH's session-title
      // call, and any run whose `publish` is `internal` (its prose is coordination; the
      // delivery it may owe the user is published once by `settleRun`).
      // It is deliberately NOT an early `return`: returning dropped the whole
      // attempt, and since the gate is evaluated at the `start` frame that also took the
      // run's own LIVE stream with it. The answer and the reasoning still arrived, but
      // only after the turn settled, when `patchRunText`/`patchRunReasoning` wrote them
      // from the result — so the model appeared to produce nothing while it was working,
      // and 思考过程 only showed up once it had finished.
      const silent = this.deps.runIdFor(owner.roomId, owner.botId) === undefined
        || this.isInternalRun(owner.roomId, owner.botId)

      const state: AttemptState = { ...owner, text: '', reasoning: '', silent }

      // ── THE LIVE ROW, CREATED WHEN THE TURN STARTS ─────────────────────────
      //
      // One empty `bot-text` row carrying this run's id, pushed before the model has
      // produced anything.
      //
      // The UI derives a turn's identity — and therefore whether to draw the whale and
      // its "用时 X 秒" timer — from the `runId` on the group's ledger rows, and it
      // treats a row with `streaming: true` as proof the turn is live. Rows used to
      // appear only once text arrived, so a bot that reasoned or called tools before
      // writing anything had NO row for that whole stretch: no whale, no timer, and
      // the work section collapsed. That is why the indicator showed for some bots and
      // not others in the same group — it depended on whether text came early.
      //
      // The row is empty on purpose: an empty text block renders as no bubble, but it
      // carries `runId` and `streaming`. `writeStream` then patches this very row, so
      // no duplicate turn is created.
      // A SILENT attempt opens NO row at all — and this is the ONLY place that can
      // enforce that, because the row is created HERE, before `writeStream` (where the
      // check used to live) is ever reached.
      //
      // Missing it left an empty row with `streaming: true` for every session-title call:
      // `writeStream` skipped it so no text ever arrived, and `finalizeStream` skipped it
      // so `streaming` was never cleared. The panel renders exactly that as a bot that is
      // permanently 运行中 — which is what the extra avatars were (4 real replies plus 6
      // ghost rows in a four-bot group).
      if (state.silent === true) {
        // Registered so its frames are routed to this attempt and discarded, rather than
        // falling through to the run's own row.
        this.attempts.set(attemptId, state)
        return
      }

      // TAKE OVER the row the run already reserved, when there is one. Creating a
      // second row is what rendered a single answer twice.
      const reserved = this.deps.ledger.liveRowFor(state.roomId, state.botId)
      if (reserved !== undefined) {
        state.textEntryId = reserved
        this.attempts.set(attemptId, state)
        return
      }
      const runId = this.deps.runIdFor(state.roomId, state.botId)
      // LAST RESORT before opening a row: one may already exist for this run — reserved
      // by the run itself, or written by an earlier attempt whose reservation had been
      // released. Reusing it is what keeps a turn to a single row.
      const existing = runId !== undefined
        ? this.deps.ledger.botTextRowForRun(state.roomId, runId)
        : undefined
      if (existing !== undefined) {
        state.textEntryId = existing
        this.attempts.set(attemptId, state)
        return
      }
      const row = this.deps.ledger.push({
        type: 'bot-text',
        roomId: state.roomId as never,
        botId: state.botId as never,
        botName: this.deps.botName(state.botId),
        ...(runId !== undefined ? { runId } : {}),
        text: '',
        streaming: true,
      } as never)
      state.textEntryId = row.id

      this.attempts.set(attemptId, state)
      return
    }

    const state = this.attempts.get(attemptId)
    if (state === undefined) return

    if (frame.type === 'end') {
      this.finalizeStream(state)
      this.attempts.delete(attemptId)
      return
    }

    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk === undefined || typeof chunk.text !== 'string' || chunk.text === '') return

    if (chunk.type === 'text-delta') {
      state.text += chunk.text
      this.writeStream(state, 'text')
    } else if (chunk.type === 'reasoning-delta') {
      state.reasoning += chunk.text
      this.writeStream(state, 'reasoning')
    }
  }

  /** Push-or-patch the live row for one channel. */
  private writeStream(state: AttemptState, channel: 'text' | 'reasoning'): void {
    // A silent attempt is tracked so its frames cannot be mistaken for the run's, but it
    // never opens a row: that is what the session-title call used to do, rendering as a
    // second identical reply.
    if (state.silent === true) return
    const runId = this.deps.runIdFor(state.roomId, state.botId)
    const name = this.deps.botName(state.botId)
    if (channel === 'text') {
      if (state.textEntryId === undefined) {
        const entry = this.deps.ledger.push({
          type: 'bot-text',
          roomId: state.roomId,
          botId: state.botId,
          botName: name,
          ...(runId !== undefined ? { runId } : {}),
          text: state.text,
          streaming: true,
        } as never)
        state.textEntryId = entry.id
        return
      }
      // Re-assert liveness on every patch while the run is live, not just at the
      // `start` frame. A row that was already settled by an earlier attempt's `end`
      // frame (see `finalizeStream`) must come back to life as soon as the NEXT step
      // streams into it — otherwise a multi-step turn renders as finished text with no
      // whale, no 用时 and a collapsed work section while the bot is still working.
      this.deps.ledger.patch(state.textEntryId, state.roomId, {
        text: state.text,
        ...(runId !== undefined ? { streaming: true } : {}),
      } as never)
      return
    }
    if (state.reasoningEntryId === undefined) {
      const entry = this.deps.ledger.push({
        type: 'bot-reasoning',
        roomId: state.roomId,
        botId: state.botId,
        botName: name,
        ...(runId !== undefined ? { runId } : {}),
        text: state.reasoning,
      } as never)
      state.reasoningEntryId = entry.id
      return
    }
    this.deps.ledger.patch(state.reasoningEntryId, state.roomId, { text: state.reasoning } as never)
  }

  /** Stop showing the live indicator once the whole RUN is over. */
  private finalizeStream(state: AttemptState): void {
    if (state.silent === true) return
    if (state.textEntryId === undefined) return
    // ── AN `end` FRAME IS PER ATTEMPT, NOT PER TURN ────────────────────────────
    //
    // The host emits one `start`/`end` pair per model attempt, and a turn that calls
    // tools runs several (`reasoning → tool call → reasoning → answer`). Clearing
    // `streaming` here therefore declared the turn finished after its FIRST step, and
    // the panel — which keys every live affordance off that flag — folded 思考过程 and
    // 工作步骤 away while the bot was still working. Nothing re-set it afterwards:
    // `writeStream` patches only the text, so the turn stayed visually dead for the
    // rest of the run. Only the run settling may clear the flag.
    if (this.deps.runIdFor(state.roomId, state.botId) !== undefined) return
    this.deps.ledger.patch(state.textEntryId, state.roomId, { streaming: false } as never)
  }

  /** Project one durable session event. */
  private onSessionEvent(sessionId: string, event: SessionEventLike): void {
    const owner = SessionRunner.parseSessionId(sessionId)
    if (owner === undefined) return
    const { roomId, botId } = owner
    const data = event.data ?? {}
    const runId = this.deps.runIdFor(roomId, botId)
    const name = this.deps.botName(botId)
    // ── A SECOND WRITER, THE SAME RULE ─────────────────────────────────────────
    //
    // The `silent` gate above covers stream frames; committed session events (the final
    // answer, tool cards) are a second, independent writer. An internal run must not
    // leave a turn behind through either path — otherwise the integrate turn's prose and
    // its `finish_task` tool card still render as a second answer, which is precisely the
    // duplicate this change removes.
    if (runId !== undefined && this.isInternalRun(roomId, botId)) return

    switch (event.type) {
      // The committed message is the authority on the final text, so it always wins
      // over whatever the live frames accumulated.
      case 'assistant/message': {
        const message = data['message'] as { content?: unknown } | undefined
        const text = textOf(message?.content)
        if (text.trim() === '') return
        this.replaceLiveText(roomId, botId, name, text, runId)
        return
      }
      case 'tool/call': {
        this.deps.ledger.push({
          type: 'tool-call',
          roomId,
          botId,
          botName: name,
          ...(runId !== undefined ? { runId } : {}),
          callId: String(data['callId'] ?? ''),
          name: String(data['name'] ?? ''),
          args: typeof data['arguments'] === 'string' ? data['arguments'] : '',
        } as never)
        return
      }
      case 'tool/result': {
        const message = data['message'] as
          | { toolCallId?: unknown; content?: unknown; isError?: unknown }
          | undefined
        this.deps.ledger.push({
          type: 'tool-result',
          roomId,
          botId,
          botName: name,
          ...(runId !== undefined ? { runId } : {}),
          callId: String(message?.toolCallId ?? ''),
          ok: message?.isError !== true,
          output: textOf(message?.content),
        } as never)
        return
      }
      default:
        // Everything else is log-only or owned by another writer. In particular:
        // `user/message` is SKIPPED on purpose — the service already pushed the user
        // row, and this plugin's own repair/seed prompts ride the user channel.
        return
    }
  }

  /**
   * Write the committed answer, reusing the live row when there is one so the turn
   * keeps a single answer row instead of one per phase.
   */
  private replaceLiveText(
    roomId: string,
    botId: string,
    name: string,
    text: string,
    runId: string | undefined,
  ): void {
    for (const [, state] of this.attempts) {
      if (state.roomId !== roomId || state.botId !== botId || state.textEntryId === undefined) continue
      // `streaming` is DELIBERATELY left alone.
      //
      // `assistant/message` is committed at the end of EVERY STEP, and a turn runs
      // several: reasoning → tool call → reasoning → answer. Clearing the flag here
      // therefore declared the turn finished after its first step, and the panel — which
      // keys every live affordance off it — collapsed the work section, hiding the
      // reasoning and the tool cards for the rest of the turn. Only the run settling may
      // clear it (`patchRunText`, `settleRunText`, `finalizeStream`).
      this.deps.ledger.patch(state.textEntryId, roomId, { text } as never)
      return
    }
    // No live row: the attempt started before this process observed it (a resumed agent,
    // or a frame the listener missed). Reuse any row this run already has — pushing
    // unconditionally was another way a single turn acquired two rows.
    const existing = runId !== undefined
      ? this.deps.ledger.botTextRowForRun(roomId, runId)
      : undefined
    if (existing !== undefined) {
      this.deps.ledger.patch(existing, roomId, { text } as never)
      return
    }
    this.deps.ledger.push({
      type: 'bot-text',
      roomId,
      botId,
      botName: name,
      ...(runId !== undefined ? { runId } : {}),
      text,
      // A committed message mid-turn does not end the turn: the run is still live, so
      // the row must stay live. The run settling is what clears it.
      streaming: runId !== undefined,
    } as never)
  }
}
