/**
 * Collaboration tools — the four tools a bot uses to organise group work.
 *
 * These are NATIVE tools registered into the agent's own scope, not entries in this
 * plugin's own tool runner. That matters for three reasons:
 *
 *   · They inherit the native pipeline — `tools/pre-execute` approval, timeouts, the
 *     parallel/exclusive classification, and paired `tool/call`/`tool/result` events —
 *     instead of reimplementing any of it.
 *   · `exec.agent` gives the owning agent, which is how a tool knows WHICH bot is
 *     calling it. Authority (only the leader may assign or finish) is enforced from
 *     that identity rather than from anything the model says about itself.
 *   · `exec.concludeTurn()` exists here, which is what lets `finish_task` end the turn
 *     the moment the report lands, rather than trusting the model to stop afterwards.
 *
 * DEFINITIONS ARE BUILT BY HAND rather than with `defineTool` from
 * `@deepseek-ai/dsh-tools`. That package is not a dependency of this plugin (only the
 * published packages already in `devDependencies` are), and `defineTool` only wraps
 * what is written out below: it validates `timeoutMs` and compiles a parameter DSL to
 * JSON Schema. Handing the registry JSON Schema directly is the same thing without the
 * dependency. `ToolRegistry.register` requires exactly `name`, `parameters`,
 * `output: { schema, render }` and `execute`, which is what each definition supplies.
 *
 * AVAILABILITY IS BY ROOM KIND, and that split is load-bearing:
 *   · `propose_group` exists only in a 1:1. It is how a bot says "this needs more than
 *     me" — offering it inside a group would make a bot spawn a group from within one.
 *   · `invite_bot` / `remove_bot` / `assign_task` / `finish_task` exist only in a group,
 *     because that is where coordination happens.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DeliveredFile, FinishEvidence } from './types.ts'
import { describePresence, type MemberPresenceView } from './presence.ts'

/** What the tools need from the service layer. */
export interface CollaborationToolDeps {
  /** Which bot is calling, resolved from the owning agent's session id. */
  ownerOf(exec: unknown): { roomId: string; botId: string } | undefined
  /** Group vs 1:1, for authority checks. */
  roomKind(roomId: string): 'direct' | 'group' | undefined
  /** The room's leader, or undefined when the room is gone. */
  leaderOf(roomId: string): string | undefined
  /** Current members, for validating invitations and assignments. */
  memberIds(roomId: string): readonly string[]
  /** Every bot that exists, so a proposal can only name live bots. */
  liveBotIds(): readonly string[]
  /**
   * Search this room's memory for entries about a query, with provenance.
   *
   * Returns file path + timestamp + run id so the model can go back to what really happened.
   */
  recall(input: {
    roomId: string
    botId: string
    query: string
  }): Promise<{
    readonly hits: ReadonlyArray<{ readonly text: string; readonly at: string; readonly runId?: string | undefined }>
    /** Matching lines from this Bot's cross-room memory ([Bot 长期记忆]). */
    readonly bot: ReadonlyArray<{ readonly text: string; readonly at?: string | undefined }>
    /** Matching lines from the team-wide rules ([团队记忆]). */
    readonly team: ReadonlyArray<{ readonly text: string; readonly at?: string | undefined }>
    readonly learned: readonly string[]
    readonly path: string
  }>

  /**
   * Record one durable line for the calling bot in the scope it names.
   *
   * The service owns every rule: `room` (default) writes this room's pair partition, `bot` this
   * bot's cross-room memory, `team` the shared team rules — and only the room's LEADER may write
   * the team scope. The dep only carries the answer (and the scope's label) back.
   */
  remember(input: {
    roomId: string
    botId: string
    text: string
    scope: 'room' | 'bot' | 'team'
  }): Promise<{ readonly ok: boolean; readonly reason?: string | undefined; readonly scopeLabel?: string | undefined }>

  /**
   * A bot's display name.
   *
   * Needed because a model names members the way the room does ("fghj"), not by id — the removal
   * path was unreachable until names could be resolved.
   */
  botName(botId: string): string
  /** The room's member ids, in room order — the roster a name is resolved against. */
  memberIds(roomId: string): readonly string[]

  /** Read THIS room's goal (never another room's). */
  roomGoal(input: { roomId: string }): {
    readonly text: string
    /** 'proposed' = a Bot's suggestion awaiting the user; it never auto-continues. */
    readonly status: 'active' | 'paused' | 'done' | 'proposed'
    readonly updatedAt: string
    readonly authorization?: {
      readonly maxRounds: number
      readonly roundsUsed: number
    } | undefined
  } | undefined
  /**
   * Create / edit / pause / resume / finish THIS room's goal.
   *
   * A Bot's `set`/`resume` lands as a PROPOSAL ('proposed') unless the goal is already active
   * under the user's grant; the caller must report that outcome honestly instead of claiming
   * the goal is running.
   */
  setRoomGoal(input: {
    roomId: string
    botId: string
    text?: string | undefined
    status?: 'active' | 'paused' | 'done' | undefined
    action?: 'set' | 'resume' | 'pause' | 'done' | undefined
  }): Promise<{
    readonly ok: boolean
    readonly reason?: string | undefined
    readonly goal?: {
      readonly text: string
      readonly status: 'active' | 'paused' | 'done' | 'proposed'
      readonly updatedAt: string
      readonly authorization?: {
        readonly maxRounds: number
        readonly roundsUsed: number
      } | undefined
    } | undefined
  }>
  /**
   * What the room's members are doing RIGHT NOW, for the leader's dispatch decision.
   *
   * Derived by the service from runs, pending approvals, the task board and the members'
   * inboxes; the ordering rule lives in `presence.ts` so it is testable without a host.
   */
  listBotsPresence(roomId: string): readonly MemberPresenceView[]

  /**
   * S0-4: ask a RUNNING member for a one-line status.
   *
   * Leader-only (the service refuses another caller). `delivered` means the question reached the
   * live turn (it sees the text at its next step); `idle` means the target has no live turn — the
   * tool reports that rather than pretending to have asked.
   */
  requestStatus(input: { roomId: string; leaderId: string; target: string }): Promise<{
    readonly ok: boolean
    readonly status: 'delivered' | 'idle' | 'refused'
    readonly targetName?: string | undefined
    readonly detail?: string | undefined
  }>

  /**
   * S0-6: post one short progress line to the room (grey control row, not a bot reply).
   *
   * Rate-limited by the service (three minutes per bot/room); a refusal is a value, never a
   * throw, because a throttled progress line must not fail the turn.
   */
  progress(input: { roomId: string; botId: string; text: string }): { ok: boolean; reason?: string | undefined }
  /**
   * S1-3: take THIS bot out of the subscription that owns its current thread/task, so the thread
   * returns to normal routing (or to the remaining owners). A value, never a throw.
   */
  handbackThread(input: { roomId: string; botId: string; reason: string }): { ok: boolean; reason?: string | undefined }

  /** Queue work for several members and return immediately (§4.1). */
  dispatch(input: {
    roomId: string
    botId: string
    tasks: ReadonlyArray<{ readonly bot: string; readonly task: string }>
    /** Applies the same "must produce a file" flag to every dispatched task. */
    requiresDeliverables?: boolean | undefined
  }): {
    readonly ok: boolean
    readonly queued: ReadonlyArray<{ readonly botId: string; readonly name: string }>
    readonly refused: ReadonlyArray<{ readonly bot: string; readonly reason: string }>
    readonly reason?: string | undefined
  }

  /**
   * Record a proposal and surface it to the user.
   *
   * Resolves whether the proposal was accepted. The tool reports that answer back to the model
   * instead of always claiming success: a proposal that cannot be recorded (no message to attach
   * it to, one already pending) must not leave the bot waiting for a dialog that will not appear.
   */
  proposeGroup(input: {
    roomId: string
    botId: string
    name: string
    memberIds: readonly string[]
    reason: string
  }): Promise<{ readonly ok: boolean; readonly reason?: string | undefined }>
  /** Recruit a bot into a group. Resolves to an error string when refused. */
  inviteBot(input: { roomId: string; botId: string; reason: string }): Promise<string | undefined>
  /**
   * Take bots out of a group. Authority (leader-only, never yourself) is enforced by the
   * service; this only carries the outcome back to the model.
   */
  removeBots(input: { roomId: string; botIds: readonly string[]; actorId: string; reason: string }): Promise<{
    ok: boolean
    removed: readonly string[]
    refused: ReadonlyArray<{ botId: string; reason: string }>
    error?: string | undefined
  }>
  /**
   * OP-12: record a structured abstention as a VISIBLE notice in the room.
   *
   * Not a failure and NOT the end of the turn: the run continues, the task stays open, and the
   * notice shows the user the reason, what is missing, and who could take it.
   */
  abstain(input: {
    roomId: string
    botId: string
    reason: string
    missing?: readonly string[] | undefined
    suggestedOwner?: string | undefined
  }): Promise<{ readonly ok: boolean; readonly reason?: string | undefined }>
  /** Fan work out to members. Returns what was accepted and what was refused. */
  assignTask(input: {
    roomId: string
    leaderId: string
    botIds: readonly string[]
    task: string
    /**
     * The leader says this work must produce a FILE. Recorded on the assignment so the
     * integrate turn and the adherence scorecard can tell "did not need a file" apart from
     * "needed one and delivered none". It is a REQUIREMENT FLAG, never a hard gate: finish
     * still closes the task when a file is missing (the user's explicit decision).
     */
    requiresDeliverables?: boolean | undefined
  }): { assigned: readonly string[]; refused: readonly string[] }
  /** Declare the task complete; publishes the report as a group message. */
  /**
   * The finish gate + group-task finish (OP-02). Resolves after BOTH ran:
   * `ok:false` means evidence was rejected and the task is still open — the tool must not
   * conclude the turn; `bypassed:true` means the gate let it through after repeated refusals
   * (recorded as unverified), which is a success with a warning.
   */
  finishTask(input: {
    roomId: string
    leaderId: string
    report: string
    evidence: readonly FinishEvidence[]
  }): Promise<{ readonly ok: boolean; readonly reason?: string | undefined; readonly bypassed?: boolean | undefined }>
  /**
   * Send one member a direct message (a2a), and thereby let members talk to each other.
   *
   * WHY THIS EXISTS. The flow the user asked for is leader-decides → decompose → assign → members
   * work AND coordinate → members report → leader aggregates → final delivery. Everything but the
   * middle step existed: `assign_task` hands work DOWN and `finish_task` publishes the leader's
   * verdict, but a member had no way to say anything back — not a progress report to the leader,
   * and not a question to the peer whose half of the work it depends on. The prompt told members
   * to "use task_report", a tool that never existed, which is how the gap stayed invisible.
   */
  messageMember(input: {
    roomId: string
    botId: string
    toName: string
    text: string
  }): Promise<{ ok: boolean; reason?: string | undefined }>
  /**
   * OP-22: hand a file the sender produced to another member of the same group.
   *
   * FILE-FIRST, because a path in an a2a message is meaningless across workspaces: the receiver
   * gets a COPY inside its own workspace (the source stays with the sender), and the handoff is
   * announced to the recipient through the normal member-message path. The service owns both
   * workspace paths, the containment/size checks and the copy; this is only the tool adapter.
   */
  handoffFile(input: {
    roomId: string
    botId: string
    toName: string
    path: string
    note?: string | undefined
  }): Promise<{
    readonly ok: boolean
    readonly reason?: string | undefined
    readonly targetPath?: string | undefined
    readonly size?: number | undefined
  }>
  /**
   * Ask the user a question and wait for the answer.
   *
   * The plugin's own surface replaces the host's `ask_user_question`, which waits on a UI a
   * hidden bot session does not have. Resolves as `expired` when nobody answers.
   */
  askUser(input: {
    roomId: string
    botId: string
    question: string
    options: readonly string[]
    allowFreeText: boolean
  }): Promise<{ status: 'answered' | 'skipped' | 'expired'; answer: string }>
  /** The run that is asking, so the question row lands inside its turn. */
  currentRunId(roomId: string, botId: string): string | undefined
  /**
   * Declare files as deliverables for the user.
   *
   * The service owns path resolution (relative to the bot's workspace), the
   * regular-file checks and the per-turn cap; the tool only carries the verdict back
   * to the model, together with what the room would show.
   */
  deliverFiles(input: {
    roomId: string
    botId: string
    files: ReadonlyArray<{ path: string; description?: string | undefined }>
  }): Promise<{ ok: boolean; files?: readonly DeliveredFile[]; error?: string | undefined }>
  /**
   * Load one skill's body by name.
   *
   * The plugin wraps the host's `skill` tool (which is denied for bot scopes) so that every body
   * arrives with its framing attached — see the tool below.
   */
  loadSkill(roomId: string, name: string): Promise<{ name: string; content: string } | undefined>

  // ── S2-2 chain-of-recall (optional; present only when the deployment enables it) ───────────
  /** True = register the three read-only recall tools below for every bot. */
  readonly recallEnabled?: boolean | undefined
  /** One page of this room's history, oldest→newest; `more` says an older page exists. */
  readHistory?(input: {
    roomId: string
    botId: string
    limit?: number | undefined
    /** Message id to page BEFORE (exclusive); omitted = newest page. */
    before?: string | undefined
    threadId?: string | undefined
    taskId?: string | undefined
  }): Promise<{
    readonly messages: ReadonlyArray<{ readonly id: string; readonly senderName: string; readonly at: string; readonly text: string }>
    readonly more: boolean
    readonly count: number
  }>
  /** One run's summary (status/times/error/report; never the full prompt). */
  readRun?(input: { roomId: string; botId: string; runId: string }): Promise<{
    readonly ok: boolean
    readonly reason?: string | undefined
    readonly run?: {
      readonly id: string
      readonly botName: string
      readonly status: string
      readonly origin: string
      readonly startedAt?: string | undefined
      readonly finishedAt?: string | undefined
      readonly durationMs?: number | undefined
      readonly error?: string | undefined
      readonly finishReport?: string | undefined
    } | undefined
  }>
  /** The room's task board (objective, assignments, finished report). */
  readTask?(input: { roomId: string; botId: string; taskId?: string | undefined }): Promise<{
    readonly ok: boolean
    readonly reason?: string | undefined
    readonly task?: unknown
  }>
}

/** The slice of the tool-execution context this module reads. */
interface ToolExec {
  readonly agent?: { readonly session?: { readonly id?: string } } | undefined
  concludeTurn?(): void
}

/** A text content block, matching what the registry hands the model. */
interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

const obj = (args: unknown): Record<string, unknown> =>
  (args !== null && typeof args === 'object' ? args : {}) as Record<string, unknown>

const str = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === 'string' ? args[key] : ''

/**
 * Strip the `required: true` shorthand out of a property schema, recursively.
 *
 * JSON Schema does not allow a boolean `required` inside a property — it is an array on the
 * OBJECT that owns the properties. The shorthand is convenient at call sites (and is exactly what
 * `defineTool` in the tools package accepts), so it is translated here instead of being passed
 * through: a strict provider rejects the whole request otherwise, which was measured on a live
 * bot — `Invalid schema for function 'agent_community_recall': true is not of type "array"`, one
 * failed request in 200ms, and NO reply in the room at all.
 *
 * Recursive because `items` can carry an object schema of its own (dispatch's task list does).
 */
function normaliseSchema(node: Record<string, unknown>): Record<string, unknown> {
  const { required: flag, properties, items, ...rest } = node
  const out: Record<string, unknown> = { ...rest }
  if (properties !== undefined && typeof properties === 'object' && properties !== null) {
    const requiredNames = Array.isArray(flag) ? flag.filter((name): name is string => typeof name === 'string') : []
    const normalised: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
      const child = (raw ?? {}) as Record<string, unknown>
      if (child['required'] === true && !requiredNames.includes(key)) requiredNames.push(key)
      normalised[key] = normaliseSchema(child)
    }
    out['properties'] = normalised
    out['required'] = requiredNames
  }
  if (items !== undefined && typeof items === 'object' && items !== null) {
    out['items'] = normaliseSchema(items as Record<string, unknown>)
  }
  return out
}

/**
 * Resolve what the model wrote (`name`, name with spaces, or an id) to member ids.
 *
 * A name is what the room shows and what the user says out loud, so it has to work; ids are
 * accepted because a model that has been given one should be able to use it. Matching is
 * case-insensitive and whitespace-trimmed, and an ambiguous name resolves to the first member in
 * room order — the roster is small and the alternative (refusing) helps nobody.
 */
export function resolveMemberRefs(input: {
  readonly refs: readonly string[]
  readonly memberIds: readonly string[]
  readonly nameOf: (id: string) => string
  readonly selfId?: string | undefined
}): { readonly ids: string[]; readonly unresolved: string[] } {
  const ids: string[] = []
  const unresolved: string[] = []
  for (const raw of input.refs) {
    const ref = raw.trim()
    if (ref === '') continue
    const byId = input.memberIds.find(id => id === ref)
    if (byId !== undefined) {
      if (!ids.includes(byId)) ids.push(byId)
      continue
    }
    const lower = ref.toLowerCase()
    const byName = input.memberIds.find(id => input.nameOf(id).trim().toLowerCase() === lower)
      // A longer form ("fghj（你）") still contains the name the user typed.
      ?? input.memberIds.find(id => input.nameOf(id).trim().toLowerCase().includes(lower))
    if (byName !== undefined) {
      if (!ids.includes(byName)) ids.push(byName)
      continue
    }
    unresolved.push(raw)
  }
  return { ids, unresolved }
}

const strList = (args: Record<string, unknown>, key: string): string[] => {
  const raw = args[key]
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

/** JSON Schema for a tool that returns a small object; the model reads the text form. */
const OPEN_OBJECT = { type: 'object', additionalProperties: true } as const

export function registerCollaborationTools(
  agentCtx: Context,
  deps: CollaborationToolDeps,
): ReadonlyArray<{ readonly name: string; readonly reason: string }> {
  const tools = (agentCtx as unknown as {
    tools?: { register(definition: unknown): void }
  }).tools
  if (tools === undefined || typeof tools.register !== 'function') {
    return [{ name: '(all)', reason: 'this agent scope has no tools service' }]
  }

  /**
   * Register one tool.
   *
   * `render` is what the model actually reads, so every tool returns a short,
   * actionable sentence rather than a JSON blob — the model acts on the outcome, and
   * a refusal has to say what to do instead.
   */
  const failedTools: Array<{ name: string; reason: string }> = []
  const add = (spec: {
    name: string
    description: string
    properties: Record<string, unknown>
    required: readonly string[]
    run(
      args: Record<string, unknown>,
      exec: ToolExec,
    ): { value: unknown; text: string } | Promise<{ value: unknown; text: string }>
  }): void => {
    // ── ONE COLLISION MUST NOT COST THE OTHER TOOLS ─────────────────────────────
    //
    // `tools.register` throws when the name is already taken IN THIS SCOPE, and this scope is
    // the agent's — where the deployment preset has already mounted its own tools. Observed on
    // a real install: the bot lost `agent_community_dispatch`, `agent_community_goal` and
    // `agent_community_recall` (every tool registered after the clashing one) and the host
    // surfaced the collision as a plugin failure, which the user saw as "the plugin broke my
    // session". A refused name is now recorded and the rest still register; the room's tools are
    // independent of each other, so there is no reason for one to take the others down.
    try {
      registerOne(spec)
    } catch (error: unknown) {
      failedTools.push({ name: spec.name, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const failed: Array<{ name: string; reason: string }> = []

  const registerOne = (spec: {
    name: string
    description: string
    properties: Record<string, unknown>
    required: readonly string[]
    run(
      args: Record<string, unknown>,
      exec: ToolExec,
    ): { value: unknown; text: string } | Promise<{ value: unknown; text: string }>
  }): void => {
    tools.register({
      name: spec.name,
      description: spec.description,
      // ── THE SCHEMA MUST BE VALID JSON SCHEMA, NOT JUST LOOK LIKE IT ───────────
      //
      // Two shorthands are in use at the call sites, and only one of them is JSON Schema:
      // the top-level `required: [...]` list, and a per-property `required: true` (the shape
      // `defineTool` accepts in the tools package). Passing the second one through put
      // `"required": true` INSIDE a property schema, which a strict provider rejects before the
      // model ever sees the turn:
      //
      //   Invalid schema for function 'agent_community_recall': true is not of type "array"
      //
      // Observed in a bot session: the request failed in 200ms and the room showed NO reply at all —
      // every tool is sent with every request, so ONE malformed tool silences the bot completely.
      // Normalise here, at the single place every tool goes through.
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.entries(spec.properties).map(([key, raw]) => [key, normaliseSchema((raw ?? {}) as Record<string, unknown>)]),
        ),
        // A property marked `required: true` counts as required even when the caller forgot the
        // list; the union keeps both spellings working.
        required: [...new Set([
          ...spec.required,
          ...Object.entries(spec.properties)
            .filter(([, raw]) => (raw as { required?: unknown } | undefined)?.required === true)
            .map(([key]) => key),
        ])],
      },
      output: {
        schema: OPEN_OBJECT,
        render: (_args: unknown, value: unknown): TextBlock[] => [
          { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
        ],
      },
      // `await` is load-bearing: `invite_bot` reaches an async service, and without
      // it the tool would report success before the membership write had happened.
      execute: async (raw: unknown, exec: unknown) => {
        const { value, text } = await spec.run(obj(raw), (exec ?? {}) as ToolExec)
        return { ...(value as Record<string, unknown>), message: text }
      },
    })
  }

  /** Resolve the caller and its room, refusing anything that cannot be placed. */
  const caller = (
    exec: ToolExec,
  ): { roomId: string; botId: string; kind: 'direct' | 'group' } | string => {
    const owner = deps.ownerOf(exec)
    if (owner === undefined) return 'this tool requires an owning agent session'
    const kind = deps.roomKind(owner.roomId)
    if (kind === undefined) return 'the room no longer exists'
    return { ...owner, kind }
  }

  // ── agent_community_remember (room / bot / team scope) ──────────────────────
  //
  // The Bot's own write path for memory. `scope` is explicit because the three partitions answer
  // different questions: this room's work (room), this Bot's cross-room preference (bot), and a
  // rule the whole team shares (team). The service refuses the team scope for anyone but the
  // room's leader — a member writing team-wide rules would be one bot editing every other bot's
  // prompt.
  add({
    name: 'agent_community_remember',
    description:
      'Remember ONE durable line. scope=room (default): a decision/constraint about THIS room. '
      + 'scope=bot: a preference that should hold for you in EVERY room (answer in Chinese, verify '
      + 'before acting). scope=team: a rule the whole team should follow — only the room leader '
      + 'may write it. Keep it to one short sentence; the room/owner is taken from your own '
      + 'session, so there is no room or bot to specify.',
    properties: {
      text: { type: 'string', required: true, description: 'One short sentence to remember.' },
      scope: {
        type: 'string',
        enum: ['room', 'bot', 'team'],
        description: 'room = this room (default), bot = your long-term memory, team = shared team rules (leader only).',
      },
    },
    required: ['text'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      const text = str(args, 'text').trim()
      if (text === '') return { value: { ok: false }, text: '要记住的内容不能为空。' }
      const scope = str(args, 'scope').trim() === '' ? 'room' : str(args, 'scope').trim()
      if (scope !== 'room' && scope !== 'bot' && scope !== 'team') {
        return { value: { ok: false }, text: 'scope 只能是 room、bot 或 team。' }
      }
      // Awaited: `stored: true` must mean the file is on disk. Reporting success before the
      // write lands is how a bot confidently "remembers" nothing.
      const result = await deps.remember({ roomId: who.roomId, botId: who.botId, text, scope })
      // EVERY branch carries `value` AND `text`: the tool registry's spec requires the pair, and
      // a branch that returned only `text` made the whole tool fail to typecheck.
      return result.ok
        ? {
            value: { stored: true, scope },
            text: `已记住（${result.scopeLabel ?? scope}）。`,
          }
        : {
            value: { stored: false, error: result.reason ?? '无法写入记忆' },
            text: result.reason ?? '无法写入记忆',
          }
    },
  })

  // ── agent_community_recall (three-scope search) ─────────────────────────────
  add({
    name: 'agent_community_recall',
    description:
      'Search what you actually remember for a keyword: THIS room (and the lessons in your global '
      + 'memory file), your own long-term memory, and the team-wide rules. Use it when the '
      + 'injected memory is not enough: it returns the real entries with their run id and time, '
      + 'so you can rely on what happened instead of guessing. Another room\'s memory is not '
      + 'searchable from here.',
    properties: {
      query: { type: 'string', required: true, description: 'Keyword or phrase to look for.' },
    },
    required: ['query'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      const query = str(args, 'query').trim()
      if (query === '') return { value: { ok: false }, text: 'query 不能为空。' }
      const found = await deps.recall({ roomId: who.roomId, botId: who.botId, query })
      const lines: string[] = []
      for (const hit of found.hits) {
        lines.push(`· [本房间 ${hit.at}${hit.runId === undefined ? '' : ` run=${hit.runId}`}] ${hit.text}`)
      }
      for (const hit of found.bot) {
        lines.push(`· [Bot 长期记忆${hit.at === undefined ? '' : ` ${hit.at}`}] ${hit.text}`)
      }
      for (const hit of found.team) {
        lines.push(`· [团队记忆${hit.at === undefined ? '' : ` ${hit.at}`}] ${hit.text}`)
      }
      if (found.learned.length > 0) {
        lines.push(`· 全局记忆里相关：${found.learned.join(' / ')}`)
      }
      if (lines.length === 0) {
        return { value: { ok: true, hits: [] }, text: `本房间、Bot 长期记忆和团队记忆里都没有与「${query}」相关的条目（本房间出处：${found.path}）。` }
      }
      return {
        value: { ok: true, hits: found.hits, botHits: found.bot, teamHits: found.team },
        text: `与「${query}」相关的记忆：\n${lines.join('\n')}\n本房间出处：${found.path}`,
      }
    },
  })

  // ── NO `get_goal` REGISTRATION, ON PURPOSE ─────────────────────────────────
  //
  // This used to register a tool named `get_goal` to re-point the host's goal tool at the room.
  // It cannot work: `tools.register` refuses a name that already exists in the scope, and the
  // deployment preset mounts `get_goal` per agent — so the registration threw, and (before the
  // per-tool guard above) took the rest of the room's tools with it. Observed on a real install:
  // `tool "get_goal" is already registered (for a per-agent variant, register through that
  // agent's agent.ctx instead)`.
  //
  // The room's goal is therefore read through `agent_community_goal` (`action: "get"`), which is
  // a name nothing else owns. The host's `get_goal` stays visible and answers about DSH's session
  // goal — the prompt tells the bot which is which (see `bots:goal` in bot-prompt.ts).

  // ── agent_community_goal (room-scoped) ──────────────────────────────────────
  add({
    name: 'agent_community_goal',
    description:
      'Read, propose, pause or finish the goal of the room you are in. Only the room\'s leader '
      + '(or the user) may change it in a group; in a 1:1 the bot may. AUTO-RUN IS THE USER\'S '
      + 'DECISION: your `set`/`resume` is recorded as a PROPOSAL (status "proposed") — it becomes '
      + 'the room\'s active goal only after the user confirms it in the panel. The plugin then '
      + 'continues the goal automatically for at most the number of rounds the user granted '
      + '(default 3); update the goal text with progress as you work — that never resets the '
      + 'budget. One room only: the room is taken from your own session.',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'pause', 'resume', 'done'],
        description: 'get = 读当前房间目标；set = 设定/改写（单聊中会落为待用户确认的提议）；'
          + 'pause/resume/done = 暂停/继续/完成。',
      },
      text: { type: 'string', description: 'action=set 时的目标内容（一句话）。' },
    },
    required: ['action'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      const action = str(args, 'action')
      const text = str(args, 'text').trim()
      if (action === 'get') {
        // The room's goal is read through THIS tool: the host already owns the name `get_goal`
        // in the agent scope (see the note above), so a separate read tool cannot exist.
        const goal = deps.roomGoal({ roomId: who.roomId })
        if (goal === undefined) {
          return { value: { ok: true, goal: null }, text: '本房间目前没有设定目标。' }
        }
        const label = goal.status === 'active' ? '进行中'
          : goal.status === 'paused' ? '已暂停'
            : goal.status === 'proposed' ? '待用户确认' : '已完成'
        const budget = goal.authorization === undefined
          ? ''
          : `；用户已授权自动续跑：已用 ${goal.authorization.roundsUsed}/${goal.authorization.maxRounds} 轮`
        return {
          value: { ok: true, goal },
          text: `本房间目标（${label}）：${goal.text}（最后更新 ${goal.updatedAt}）${budget}`,
        }
      }
      if (action === 'set' && text === '') {
        return { value: { ok: false }, text: 'action=set 需要给出 text（一句话的目标）。' }
      }
      const status = action === 'pause' ? 'paused' : action === 'done' ? 'done' : 'active'
      const result = await deps.setRoomGoal({
        roomId: who.roomId,
        botId: who.botId,
        ...(action === 'set' ? { text } : {}),
        status,
        action: action === 'pause' || action === 'done' || action === 'resume' ? action : 'set',
      })
      if (!result.ok) {
        return { value: { ok: false }, text: result.reason ?? '目标没有改动。' }
      }
      const resulting = result.goal?.status ?? status
      const budget = result.goal?.authorization
      // ── REPORT THE OUTCOME HONESTLY ──────────────────────────────────────────
      //
      // A "proposed" result is NOT an active goal: saying "已设定" made the model believe it
      // had granted itself automatic continuation, which is exactly the loop the user
      // reported ("it starts working without me"). The wording below is what the model reads.
      if (resulting === 'proposed') {
        const last = result.goal?.text ?? text
        return {
          value: { ok: true, status: 'proposed', goal: result.goal },
          text: '已提交目标建议，等待用户在面板确认；在确认前不会自动续跑。'
            + `目标建议：${last}。本轮请按用户当前的要求正常收尾，不要假设它会自动继续。`,
        }
      }
      if (resulting === 'active') {
        const line = budget === undefined
          ? '用户尚未授权轮次，不会自动续跑。'
          : `用户已授权自动续跑：已用 ${budget.roundsUsed}/${budget.maxRounds} 轮。`
        return {
          value: { ok: true, status: 'active', goal: result.goal },
          text: action === 'set'
            ? `已更新目标文本（${line}）。它只对这个房间生效。`
            : `本房间目标已是进行中（${line}）。`,
        }
      }
      if (resulting === 'paused') {
        return { value: { ok: true, status: 'paused', goal: result.goal }, text: '已暂停本房间目标：不会自动续跑。' }
      }
      return { value: { ok: true, status: 'done', goal: result.goal }, text: '已把本房间目标标记为完成。' }
    },
  })

  // ── agent_community_abstain (any room) ──────────────────────────────────────
  add({
    name: 'agent_community_abstain',
    description:
      'SAY WHAT YOU CANNOT DO, STRUCTURED — before it becomes a silent failure. Use it when you '
      + 'cannot finish a piece: missing information/files/access, a job that belongs to another '
      + 'bot, or a requirement that conflicts with your boundaries. State the reason, what is '
      + 'missing, and who you suggest could take it over. This is NOT a failure and it does NOT '
      + 'end the task: the note is recorded as a visible room notice for the user, and you keep '
      + 'your turn — continue with what you CAN do, or ask for help with message_member.',
    properties: {
      reason: {
        type: 'string',
        required: true,
        description: 'Why you cannot complete this piece — one concrete sentence.',
      },
      missing: {
        type: 'array',
        items: { type: 'string' },
        description: 'What is missing: files, data, permission, another member\'s output. At most 5, each ≤120 chars.',
      },
      suggestedOwner: {
        type: 'string',
        description: 'A member name or role who could take this over (optional, ≤60 chars).',
      },
    },
    required: ['reason'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      const reason = str(args, 'reason').trim()
      if (reason === '') {
        return { value: { ok: false }, text: 'reason 不能为空：请说明为什么这一项做不到。' }
      }
      const missing = strList(args, 'missing')
        .map(entry => entry.trim())
        .filter(entry => entry !== '')
      const suggestedOwner = str(args, 'suggestedOwner').trim()
      const result = await deps.abstain({
        roomId: who.roomId,
        botId: who.botId,
        reason,
        missing,
        ...(suggestedOwner !== '' ? { suggestedOwner } : {}),
      })
      if (!result.ok) {
        return { value: { ok: false }, text: result.reason ?? '弃权说明没有记录成功。' }
      }
      return {
        value: { ok: true },
        text: '已记录你的说明（用户能在群里看到这条 notice）。这不是失败，也没有结束任务：'
          + '继续做你能做的部分；需要支援就用 message_member 说明。',
      }
    },
  })

  // ── agent_community_dispatch (group, leader only) ───────────────────────────
  add({
    name: 'agent_community_dispatch',
    description:
      'Hand work to OTHER BOTS IN THIS ROOM — the way to parallelise, instead of opening your '
      + 'own sub-agents (their work is invisible to the room and unaccounted). Queues each '
      + 'member immediately and returns at once: report progress in your own answer this turn, '
      + 'and you will be woken with their reports when they finish. One to four members. '
      + 'If a task must produce a file, say so in its task text AND set requires_files: true; '
      + 'the member must call agent_community_deliver before it finishes — a file path written '
      + 'in prose is not a delivery.',
    properties: {
      requires_files: {
        type: 'boolean',
        description: 'true when the dispatched work must produce a file the user can receive.',
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            bot: { type: 'string', description: 'Member name or id (from the room roster).' },
            task: {
              type: 'string',
              description:
                'What they should do, and what to produce. Name any file the user must receive; '
                + 'the member is expected to deliver it with agent_community_deliver.',
            },
          },
          required: ['bot', 'task'],
        },
        description: 'One entry per member: who does what.',
      },
    },
    required: ['tasks'],
    run: (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      const raw = Array.isArray(args['tasks']) ? args['tasks'] : []
      const tasks = raw
        .map((t) => {
          const item = (t ?? {}) as Record<string, unknown>
          return { bot: typeof item['bot'] === 'string' ? item['bot'] : '', task: typeof item['task'] === 'string' ? item['task'] : '' }
        })
        .filter(t => t.bot !== '' || t.task !== '')
      if (tasks.length === 0) {
        return { value: { ok: false }, text: 'tasks 不能为空：请给出要交给谁、做什么。' }
      }
      const result = deps.dispatch({
        roomId: who.roomId,
        botId: who.botId,
        tasks,
        ...(args['requires_files'] === true ? { requiresDeliverables: true } : {}),
      })
      if (!result.ok) {
        const why = result.refused.map(r => `${r.bot}：${r.reason}`).join('；')
        return { value: { ok: false, refused: result.refused }, text: `${result.reason ?? '派工失败。'}${why === '' ? '' : ` ${why}`}` }
      }
      const names = result.queued.map(q => q.name).join('、')
      const why = result.refused.length === 0 ? '' : `；未派出的：${result.refused.map(r => `${r.bot}（${r.reason}）`).join('、')}`
      return {
        value: { ok: true, queued: result.queued.map(q => q.botId), refused: result.refused },
        text: `已把 ${result.queued.length} 件活交给：${names}。它们完成后系统会唤醒你，本轮请先向用户说明已分派什么${why}。`,
      }
    },
  })

  // ── agent_community_list_bots (any member, current room) ───────────────────
  //
  // The leader's dispatch decision needs the state, not just the roster: handing a second
  // task to a member that is mid-turn, queued, or blocked on a user approval is the failure
  // this tool exists to prevent. The state is derived (runs / approvals / board / inbox) by
  // the service and ordered by `presence.ts`; this tool only renders it.
  add({
    name: 'agent_community_list_bots',
    description:
      'Show what every member of THIS room is doing right now: 空闲 / 工作中 / 排队中 / 等审批 / '
      + '等别的 Bot, plus their open task (if any), pending approvals and unread inbox count. '
      + 'Call it before dispatch/assign_task so you do not hand a second job to a busy member.',
    properties: {},
    required: [],
    run: (_args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      const members = deps.listBotsPresence(who.roomId)
      if (members.length === 0) {
        return { value: { ok: true, bots: [] }, text: '本房间还没有成员。' }
      }
      const idle = members.filter(member => member.state === 'idle')
      const lines = members.map(member => describePresence(member))
      return {
        value: { ok: true, bots: members },
        text: [
          `本房间 ${members.length} 位成员当前状态：`,
          ...lines,
          idle.length === 0
            ? '现在没有空闲成员：派工会排队，等它们完成后再派。'
            : `空闲可派工：${idle.map(member => member.name).join('、')}。`,
        ].join('\n'),
      }
    },
  })

  // ── agent_community_request_status (group, leader only) ────────────────────
  //
  // S0-4: the leader's one way to ask a BUSY member where it stands without waiting for the
  // member to finish. A long task used to look identical to a stuck one: the leader could see
  // `working` but had no way to tell "still thinking" from "dead". The question is injected into
  // the live turn (no new run, no slot), so the answer arrives as the member's normal output.
  add({
    name: 'agent_community_request_status',
    description:
      'Ask a member that is CURRENTLY running a task for a one-line status (what it is doing, '
      + 'whether it is stuck, what it needs). The question is injected into its running turn; it '
      + 'does not create a new run and does not interrupt it. Only the group leader may call it. '
      + 'If the member has no live turn the result says so — use list_bots to see who is running.',
    properties: {
      bot: { type: 'string', description: 'The running member to ask: its NAME or id.' },
      reason: { type: 'string', description: 'Optional one-line reason shown in the room log.' },
    },
    required: ['bot'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      if (who.kind !== 'group') {
        return { value: { ok: false }, text: 'request_status 只能在群里用：单聊没有需要追问的成员。' }
      }
      const target = str(args, 'bot')
      if (target === '') return { value: { ok: false }, text: 'bot is required (a member name or id).' }
      const result = await deps.requestStatus({
        roomId: who.roomId,
        leaderId: who.botId,
        target,
      })
      if (!result.ok) {
        return { value: { ok: false, status: result.status }, text: result.detail ?? '询问未发出。' }
      }
      const name = result.targetName ?? target
      return {
        value: { ok: true, status: result.status, target: result.targetName },
        text: result.status === 'delivered'
          ? `已询问「${name}」的进度：它在当前这一轮的下一次思考时会看到问题，不需要你等它整轮跑完。`
          : `「${name}」现在没有在跑的任务（${result.detail ?? '空闲'}），没有可询问的进度。`,
      }
    },
  })

  // ── agent_community_progress (any member, one grey line) ────────────────────
  //
  // S0-6: the bot's own way to say "I am doing X, it will take a while" WITHOUT ending the turn.
  // A long task used to be silent until it finished, so the room showed 处理中… with no idea
  // whether work was happening. The line is a control row, not a reply: it is not published as
  // the bot's answer and does not count as delivery.
  add({
    name: 'agent_community_progress',
    description:
      'Post ONE short progress line to the room while you work on a long task, e.g. "正在跑测试，预计 3 分钟" '
      + 'or "已经在后台编译，先处理下一项". It is a grey progress row, not your final answer, so keep it to one '
      + 'sentence and do not repeat it: the room allows one line per Bot every few minutes. Use it after moving '
      + 'long work to a background job; the final result must still be delivered in your normal reply.',
    properties: {
      text: { type: 'string', description: 'One sentence: what you are doing and roughly how long it takes.' },
    },
    required: ['text'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      const text = str(args, 'text')
      if (text === '') return { value: { ok: false }, text: 'text 不能为空：写一句你在做什么、还要多久。' }
      const result = deps.progress({ roomId: who.roomId, botId: who.botId, text })
      if (!result.ok) return { value: { ok: false }, text: result.reason ?? '进度没有发布。' }
      return { value: { ok: true }, text: '已在房间留下一条灰色进度提示（不是你的最终答复）。' }
    },
  })

  // ── agent_community_handback (S1-3, any member) ─────────────────────────────
  //
  // A thread/task can have owners (S1-3 subscriptions). When a follow-up arrives that this bot is
  // not the right owner for, it hands the thread back instead of answering outside its remit:
  // the subscription drops this bot (other owners keep it) and the leader gets a visible notice.
  add({
    name: 'agent_community_handback',
    description:
      'Hand back the thread/task you are currently working on when a follow-up reaches you that you '
      + 'should not own (out of scope, or another member is the right owner). This removes YOU from '
      + 'the thread subscription and leaves a visible note for the leader; the thread then routes to '
      + 'the remaining owners or to normal routing. Use abstain instead when you have nothing to add '
      + 'but the thread is still yours. One short sentence for the reason.',
    properties: {
      reason: { type: 'string', description: 'Why this thread should not be yours (one sentence).' },
    },
    required: ['reason'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      const result = deps.handbackThread({
        roomId: who.roomId,
        botId: who.botId,
        reason: str(args, 'reason'),
      })
      if (!result.ok) return { value: { ok: false }, text: result.reason ?? '交回失败。' }
      return {
        value: { ok: true },
        text: '已把这条线程交回；之后这条线程不再默认由你处理（房间会留一条说明）。',
      }
    },
  })

  // ── propose_group (1:1 only) ────────────────────────────────────────────────
  add({
    name: 'propose_group',
    description:
      'Propose that the user start a GROUP CHAT for the current task, naming the bots that '
      + 'should take part. Use it when the task genuinely needs capabilities you do not have. '
      + 'The user decides: on approval a group is created and the task moves there; on refusal '
      + 'you must finish the task alone. Call it at most once, then stop working.',
    properties: {
      name: { type: 'string', description: 'Short group name.' },
      memberIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Bot ids to invite, from the [可协作的 bot] roster. Include yourself.',
      },
      reason: { type: 'string', description: 'One sentence telling the user why.' },
    },
    required: ['name', 'memberIds', 'reason'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      if (who.kind !== 'direct') {
        return { value: { ok: false }, text: 'propose_group is only available in a one-to-one chat' }
      }
      // Only LIVE bots may be proposed. Filtering here — rather than repairing a stale
      // proposal later — is what makes "confirm a bot that was deleted" impossible.
      const live = new Set(deps.liveBotIds())
      const members = [...new Set([who.botId, ...strList(args, 'memberIds')])].filter((id) => live.has(id))
      if (members.length < 2) {
        return {
          value: { ok: false },
          text: 'a group needs at least one other bot; none of the named bots exist',
        }
      }
      const recorded = await deps.proposeGroup({
        roomId: who.roomId,
        botId: who.botId,
        name: str(args, 'name') || '协作群聊',
        memberIds: members,
        reason: str(args, 'reason'),
      })
      if (!recorded.ok) {
        return {
          value: { ok: false, proposed: false },
          text: recorded.reason ?? '这个房间现在不能记录建群提议，请直接回答用户。',
        }
      }
      return {
        value: { ok: true, proposed: true, members },
        // The wording matters more than it looks. This used to read "已提交给用户确认。不要再调用工具，
        // 等待用户决定。" and a model answered the user with 两条路都被挡住了…没能建群 while the group was
        // in fact created seconds later — it read "等待" as "blocked". The tool result must say, in as
        // many words, that this is SUCCESS and what the truthful sentence to the user is.
        text: '✅ 建群建议已提交成功，这不是失败。请只告诉用户：已提交建群建议，等你在面板上确认，'
          + '确认后群会自动建好、成员即刻到位。不要再尝试其他建群方式，不要报告“做不到”，也不要再调用工具。',
      }
    },
  })

  // ── invite_bot (group only) ─────────────────────────────────────────────────
  add({
    name: 'invite_bot',
    description:
      'Pull a bot that is NOT yet in this group into it, when part of the work suits them. The '
      + 'bot joins immediately and can be named in later rounds. At most four per turn.',
    properties: {
      botId: { type: 'string', description: 'Id of the bot to invite.' },
      reason: { type: 'string', description: 'One sentence saying what they will do.' },
    },
    required: ['botId', 'reason'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      if (who.kind !== 'group') {
        return {
          value: { ok: false },
          text: 'invite_bot 只能在群里用。单聊里要拉人一起干活，用 propose_group 提交建群建议，'
            + '不要对用户报告“没有权限、做不到”。',
        }
      }
      const target = str(args, 'botId')
      if (target === '') return { value: { ok: false }, text: 'botId is required' }
      if (!deps.liveBotIds().includes(target)) {
        return { value: { ok: false }, text: `bot "${target}" does not exist` }
      }
      const refused = await deps.inviteBot({ roomId: who.roomId, botId: target, reason: str(args, 'reason') })
      if (refused !== undefined) return { value: { ok: false }, text: refused }
      return {
        value: { ok: true, invited: target, members: deps.memberIds(who.roomId) },
        text: '已加入本群。现在可以把他写进 assign_task 了。',
      }
    },
  })

  // ── assign_task (group only, leader only) ───────────────────────────────────
  add({
    name: 'remove_bot',
    description:
      'Take one or more bots OUT of this group — for example a member that went off track, '
      + 'duplicated work, or is no longer needed. Their running turn is stopped, their share '
      + 'of the task board goes back to the pool, and they forget this room. Only the group '
      + 'leader may call this, at most four bots per call. YOU MAY REMOVE YOURSELF: when the '
      + 'user asks for the coordinator to be removed, that is the coordinator\'s call to '
      + 'execute — leadership then passes to the first remaining member.',
    properties: {
      botIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Members to remove: their NAME or their id. One or several.',
      },
      reason: { type: 'string', description: 'One short sentence for the room log.' },
    },
    required: ['botIds', 'reason'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      if (who.kind !== 'group') {
        return { value: { ok: false }, text: 'remove_bot is only available in a group chat' }
      }
      // The same authority rule as assign_task: membership is coordination. The service
      // re-checks this — a tool is a convenience wrapper, not the boundary.
      const leader = deps.leaderOf(who.roomId)
      if (leader !== undefined && leader !== who.botId) {
        return { value: { ok: false }, text: 'only the group leader may remove members' }
      }
      const refs = strList(args, 'botIds')
      if (refs.length === 0) return { value: { ok: false }, text: 'botIds is required' }
      // ── NAMES ARE THE NATURAL INPUT, SO RESOLVE THEM ─────────────────────────
      //
      // Observed in a group: the user asked to remove a member, the model passed the
      // member's NAME (what the room shows, and what the user typed), and the service answered
      // "not a member of this group" — because this tool only ever accepted ids. The dispatch
      // tool has resolved names from the start; this one must too, or the removal path is
      // unreachable by the only wording a human would use.
      const resolved = resolveMemberRefs({
        refs,
        memberIds: deps.memberIds(who.roomId),
        nameOf: (id) => deps.botName(id),
        selfId: who.botId,
      })
      if (resolved.unresolved.length > 0) {
        const roster = deps.memberIds(who.roomId).map(id => deps.botName(id)).join('、')
        return {
          value: { ok: false, unresolved: resolved.unresolved },
          text: `认不出这些成员：${resolved.unresolved.join('、')}。本群成员是：${roster}（用名字或 id 都行）。`,
        }
      }
      const botIds = resolved.ids
      const result = await deps.removeBots({
        roomId: who.roomId,
        botIds,
        actorId: who.botId,
        reason: str(args, 'reason'),
      })
      if (!result.ok) {
        const refused = result.refused.map(r => `${r.botId}: ${r.reason}`).join('; ')
        return {
          value: { ok: false, removed: result.removed, refused: result.refused },
          text: [result.error ?? 'remove_bot was refused', refused].filter(t => t !== '').join(' — '),
        }
      }
      const names = result.removed.join('、')
      const refusedText = result.refused.length > 0
        ? `；未移除：${result.refused.map(r => `${r.botId}（${r.reason}）`).join('、')}`
        : ''
      return {
        value: { ok: true, removed: result.removed, refused: result.refused, members: deps.memberIds(who.roomId) },
        text: `已将 ${names} 移出本群${refusedText}。他们手上的任务已回到待认领。`,
      }
    },
  })

  add({
    name: 'ask_user_question',
    description:
      'Ask the USER something you cannot decide alone, and wait for their answer. Use it when a '
      + 'choice changes what you build (which方向、哪个方案、是否继续) — not for small decisions you '
      + 'can make yourself. Give two to four concrete options so answering takes one click; the '
      + 'user may also type something else. The turn pauses until they answer, and if they never '
      + 'do you are told to proceed on your own judgement.',
    properties: {
      question: { type: 'string', description: 'One clear question, in the user\'s language.' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Two to four short options to pick from. Optional when only free text makes sense.',
      },
      allowFreeText: {
        type: 'boolean',
        description: 'Whether the user may type an answer instead of picking an option. Defaults to true.',
      },
    },
    required: ['question'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      const question = str(args, 'question').trim()
      if (question === '') return { value: { ok: false }, text: 'question is required' }
      // Options are capped: a question with ten choices is a form, not a question, and the
      // card is a single row of buttons.
      const options = strList(args, 'options').map(o => o.trim()).filter(o => o !== '').slice(0, 4)
      const allowFreeText = args['allowFreeText'] !== false
      if (options.length === 0 && !allowFreeText) {
        return { value: { ok: false }, text: 'give at least one option or allow a free-text answer' }
      }
      const outcome = await deps.askUser({
        roomId: who.roomId,
        botId: who.botId,
        question,
        options,
        allowFreeText,
      })
      if (outcome.status === 'answered') {
        return {
          value: { ok: true, answered: true, answer: outcome.answer },
          text: `用户回答：${outcome.answer}\n按这个回答继续。`,
        }
      }
      // ⚠️ NEVER tell the model to proceed on its own when nobody answered.
      //
      // The previous text said "用你自己的判断继续，并在回复里说明你替他做的选择" — so a bot that asked
      // "想让我先做哪个？" and got no answer took that as permission and built a whole deliverable
      // nobody asked for. Observed on the host: the user said only 你好, the question was never
      // answered (and the run was cancelled), and the bot wrote an entire brand package
      // (aurora-brand/tokens.css + three banner pages) before anyone could stop it.
      //
      // An unanswered question means "stop and wait": say what you are waiting for, propose what you
      // would do, and end the turn. Starting unrequested work is the failure mode this text exists to
      // prevent, so both branches must forbid it explicitly.
      return {
        value: { ok: true, answered: false, status: outcome.status },
        text: outcome.status === 'skipped'
          ? '用户跳过了这个问题，这**不代表授权你自行开工**。用一句话说明你在等什么、以及你准备怎么做，'
            + '然后结束这一轮，等用户的下一步指令。不要开始用户没有要求的实现工作。'
          : '用户还没有回答（等待超时）。**不要自行开工**：用一句话说明你在等什么、你准备怎么做，'
            + '然后结束这一轮。不要开始用户没有要求的实现工作。',
      }
    },
  })

  // ── skill (wraps the host tool, adds the framing) ────────────────────────────
  add({
    name: 'skill',
    description:
      'Load one skill\'s instructions by name, when the thing the USER asked for needs it. A skill is '
      + 'a METHOD you may use — loading one is not an instruction to start work, and a skill\'s own '
      + 'description of what it can produce is not a task list.',
    properties: {
      name: { type: 'string', description: 'Skill name, exactly as listed in [可用技能].' },
    },
    required: ['name'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      const name = str(args, 'name').trim()
      if (name === '') return { value: { ok: false }, text: 'name is required' }
      const loaded = await deps.loadSkill(who.roomId, name)
      if (loaded === undefined) {
        return { value: { ok: false, found: false }, text: `没有找到技能「${name}」。可用技能见 [可用技能]。` }
      }
      // ⚠️ THE FRAMING IS THE POINT OF THIS TOOL.
      //
      // Skills are capability manuals, and their opening lines advertise what they can produce
      // ("Actions: design, create, generate banner…"). Fed in bare, that reads as a to-do list:
      // measured live, a bot greeted with 你好 loaded two skills and then built a whole brand package
      // nobody asked for. Every body therefore arrives wrapped — method, not order — and the boundary
      // is restated next to it, where the model is actually looking.
      return {
        value: { ok: true, found: true, name: loaded.name },
        text: [
          `以下为技能「${loaded.name}」的方法说明（工具说明）。`,
          '它只说明"这件事怎么做"，不代表用户要求你执行它；本轮只做用户明确要求的那件事。',
          '',
          loaded.content,
        ].join('\n'),
      }
    },
  })

  add({
    name: 'assign_task',
    description:
      'Hand work to one or more members of this group. You decide how many bots take part — one, '
      + 'several, or all. Each assignee starts immediately and reports back when finished. '
      + 'If the work must produce a FILE the user can receive, set requires_files: true so the '
      + 'summary turn and the adherence score know a file was required (the member must call '
      + 'agent_community_deliver; a path written in prose is not a delivery).',
    properties: {
      botIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Member ids to assign, from the room roster.',
      },
      task: { type: 'string', description: 'What they should do, and what to produce.' },
      requires_files: {
        type: 'boolean',
        description: 'true when this work must produce a file the user can receive.',
      },
    },
    required: ['botIds', 'task'],
    run: (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      if (who.kind !== 'group') {
        return { value: { ok: false }, text: 'assign_task is only available in a group chat' }
      }
      // Only the leader coordinates. Without this, a member could reassign the group's
      // work while the leader is still planning it.
      const leader = deps.leaderOf(who.roomId)
      if (leader !== undefined && leader !== who.botId) {
        return { value: { ok: false }, text: 'only the group leader may assign work' }
      }
      const botIds = strList(args, 'botIds')
      if (botIds.length === 0) {
        return { value: { ok: false }, text: 'botIds must name at least one member' }
      }
      const result = deps.assignTask({
        roomId: who.roomId,
        leaderId: who.botId,
        botIds,
        task: str(args, 'task'),
        ...(args['requires_files'] === true ? { requiresDeliverables: true } : {}),
      })
      return {
        value: {
          ok: true,
          assigned: result.assigned,
          ...(result.refused.length > 0 ? { refused: result.refused } : {}),
        },
        text: result.refused.length > 0
          ? '被拒绝的成员不在本群，先用 invite_bot 邀请。'
          : '已分派，等待成员汇报。不要再重复分派同一件事。',
      }
    },
  })

  // ── message_member (any member, group only) ─────────────────────────────────
  add({
    name: 'message_member',
    description:
      'Send a direct message to one other member of this group — the leader when you report '
      + 'progress or finish your part, or a peer whose work touches yours. The recipient is woken '
      + 'by it. Use it instead of talking about them in the room.',
    properties: {
      to: { type: 'string', description: 'The member name, from the room roster.' },
      text: { type: 'string', description: 'What they need to know, or what you need from them.' },
    },
    required: ['to', 'text'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      if (who.kind !== 'group') {
        return { value: { ok: false }, text: 'message_member is only available in a group chat' }
      }
      const to = str(args, 'to').trim()
      const text = str(args, 'text').trim()
      if (to === '') return { value: { ok: false }, text: 'to is required' }
      if (text === '') return { value: { ok: false }, text: 'text is required' }
      const result = await deps.messageMember({
        roomId: who.roomId,
        botId: who.botId,
        toName: to,
        text,
      })
      if (!result.ok) {
        return {
          value: { ok: false, ...(result.reason !== undefined ? { reason: result.reason } : {}) },
          text: `没有送到「${to}」：${result.reason ?? '不在本群。用群里现有成员的名字。'}`,
        }
      }
      return { value: { ok: true, to }, text: `已直接发给「${to}」。` }
    },
  })

  // ── agent_community_handoff_file (any member, group only) ───────────────────
  add({
    name: 'agent_community_handoff_file',
    description:
      'Hand a file you actually produced to another member of this group — FILE-FIRST, because '
      + 'a path in a chat message points at a file the other bot cannot open. The recipient gets '
      + 'a COPY in its own workspace and is woken with the new path; your own file stays where '
      + 'it is (nothing is moved or deleted). Use this instead of re-describing the artifact in '
      + 'prose whenever the next step needs the real file: draft, dataset, deck, image, report. '
      + 'The file must be inside your workspace and at most 32MB.',
    properties: {
      toName: {
        type: 'string',
        required: true,
        description: 'The member name from the room roster — not a bot id and not yourself.',
      },
      path: {
        type: 'string',
        required: true,
        description: 'The file you produced: relative to your workspace, or an absolute path inside it.',
      },
      note: {
        type: 'string',
        description: 'One line telling the recipient what to do with the file (optional).',
      },
    },
    required: ['toName', 'path'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      if (who.kind !== 'group') {
        return { value: { ok: false }, text: 'agent_community_handoff_file is only available in a group chat' }
      }
      const toName = str(args, 'toName').trim()
      const path = str(args, 'path').trim()
      const note = str(args, 'note').trim()
      if (toName === '') return { value: { ok: false }, text: 'toName is required' }
      if (path === '') return { value: { ok: false }, text: 'path is required' }
      const result = await deps.handoffFile({
        roomId: who.roomId,
        botId: who.botId,
        toName,
        path,
        ...(note !== '' ? { note } : {}),
      })
      if (!result.ok) {
        return {
          value: { ok: false, ...(result.reason !== undefined ? { reason: result.reason } : {}) },
          text: `文件没有交接成功：${result.reason ?? '检查文件名与成员名字，然后重试。'}`,
        }
      }
      return {
        value: { ok: true, targetPath: result.targetPath, size: result.size },
        text: `已把文件交接给「${toName}」，副本在它的工作区：${result.targetPath ?? ''}。`
          + '源文件仍在你这里，没有被移动或删除；对方已被通知。',
      }
    },
  })

  // ── finish_task (group only, leader only) ───────────────────────────────────
  add({
    name: 'finish_task',
    description:
      'Declare the group task complete and give the user the final report. This ends your turn '
      + 'immediately — do not call any more tools afterwards. FINISHING IS EVIDENCE-GATED: '
      + 'report and evidence are BOTH required, and the host checks every evidence item before '
      + 'the task is closed. Give 1-8 items: a real file (relative to your workspace, or '
      + 'absolute; optional sha256), a message that exists in THIS room, or a task-board '
      + 'assignment that has been reported/done. A rejected finish returns the reason and the '
      + 'task stays open — fix the evidence and call again; do not describe work you cannot '
      + 'point at.',
    properties: {
      report: {
        type: 'string',
        description: 'The final report: what was done, what was produced, what remains.',
      },
      evidence: {
        type: 'array',
        // NOT `minItems: 1`, and evidence is NOT in `required` below: schema rejection would
        // happen before the run body, so the gate's rejection counter could never advance and
        // a model that keeps omitting evidence would loop without the deadlock guard. The body
        // passes an empty list to the gate, which rejects it with a fixable reason and lets the
        // third attempt bypass (with a visible "unverified" notice).
        maxItems: 8,
        description: '1-8 verifiable items. The host rejects paths/messages/tasks it cannot '
          + 'confirm, and repeats are rejected. Missing evidence is a gate rejection, not a '
          + 'schema error, so finish_task always returns an actionable reason.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['file', 'message', 'task'] },
            // file variant
            path: { type: 'string', description: 'file：相对你的 workspace，或绝对路径' },
            sha256: { type: 'string', description: 'file 可选：hex sha256 完整性校验' },
            // message variant
            messageId: { type: 'string', description: 'message：本房间内的消息 id' },
            runId: { type: 'string', description: 'message 可选：消息必须属于该 run' },
            // task variant
            taskId: { type: 'string', description: 'task：本房间任务板上已回报完成的任务 id' },
          },
          required: ['kind'],
        },
      },
    },
    required: ['report'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      if (who.kind !== 'group') {
        return { value: { ok: false }, text: 'finish_task is only available in a group chat' }
      }
      const leader = deps.leaderOf(who.roomId)
      if (leader !== undefined && leader !== who.botId) {
        return { value: { ok: false }, text: 'only the group leader may declare the task complete' }
      }
      const report = str(args, 'report')
      if (report.trim() === '') return { value: { ok: false }, text: 'report is required' }
      // Evidence is parsed leniently here: the GATE is the authority on validity (it returns
      // every problem at once), so the tool only guarantees the shape it passes on.
      const rawEvidence = Array.isArray(args['evidence']) ? args['evidence'] as readonly unknown[] : []
      const evidence: FinishEvidence[] = []
      for (const item of rawEvidence) {
        if (item === null || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const kind = typeof record['kind'] === 'string' ? record['kind'] : ''
        const text = (key: string): string | undefined =>
          typeof record[key] === 'string' ? (record[key] as string).trim() : undefined
        if (kind === 'file') {
          const path = text('path')
          if (path === undefined) continue
          evidence.push({ kind: 'file', path, ...(text('sha256') !== undefined ? { sha256: text('sha256')! } : {}) })
        } else if (kind === 'message') {
          const messageId = text('messageId')
          if (messageId === undefined) continue
          evidence.push({ kind: 'message', messageId, ...(text('runId') !== undefined ? { runId: text('runId')! } : {}) })
        } else if (kind === 'task') {
          const taskId = text('taskId')
          if (taskId === undefined) continue
          evidence.push({ kind: 'task', taskId })
        } else {
          // Keep an unknown kind so the gate can report it precisely (instead of silently
          // dropping the item and then complaining about the count).
          evidence.push({ kind } as unknown as FinishEvidence)
        }
      }
      if (evidence.length === 0) {
        return {
          value: { ok: false, reason: 'evidence is required' },
          text: '未完成：finish_task 需要至少 1 条证据（file/message/task）。任务仍未关闭，请补齐证据后再调用。',
        }
      }
      const result = await deps.finishTask({ roomId: who.roomId, leaderId: who.botId, report, evidence })
      if (!result.ok) {
        return {
          value: { ok: false, reason: result.reason ?? 'evidence rejected' },
          text: '未完成：完成证据未通过校验。' + (result.reason !== undefined ? `原因：${result.reason}. ` : '')
            + '任务仍未关闭；请修正/补齐证据后再次调用 finish_task（文件 path、本房间消息 messageId、或已回报完成的任务 taskId）。',
        }
      }
      // Only a PASSED (or explicitly bypassed) finish may end the turn: the native loop has
      // NO turn budget, so without this the model could keep calling tools after finishing.
      exec.concludeTurn?.()
      return {
        value: { ok: true, finished: true, ...(result.bypassed === true ? { bypassed: true } : {}) },
        text: result.bypassed === true
          ? '已结束本轮：证据门连续未通过，本次按 bypassed 放行（标记为未验证）。'
          : '证据已通过校验，已汇报并结束本轮。',
      }
    },
  })

  // ── agent_community_deliver (files for the user) ───────────────────────────
  //
  // The room's own equivalent of DSH's `present`, but registered natively here: the bot
  // preset does not mount the host's present tool, and a hidden bot session has no DSH
  // card of its own to write to. Same contract as present — existing regular files only,
  // relative paths against the workspace, absolute paths allowed — so the model's habit
  // transfers unchanged.
  add({
    name: 'agent_community_deliver',
    description:
      'Declare files you have already created as final deliverables for the user. Use it when the '
      + 'user needs a separate file (documents, spreadsheets, slide decks, images, reports); prefer '
      + 'your final reply when that suffices. The user opens the current files; their contents are '
      + 'not copied. Paths are relative to your workspace or absolute. Declare the 1-2 most '
      + 'important files, at most 4 per call.',
    properties: {
      files: {
        type: 'array',
        required: true,
        description: 'The deliverables; usually the 1-2 most important files, at most 4 per call.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: {
              type: 'string',
              required: true,
              description: 'Path of an existing regular file. Relative paths use the bot workspace.',
            },
            description: { type: 'string', description: 'Brief description for the user.' },
          },
        },
      },
    },
    required: ['files'],
    run: async (args, exec) => {
      const who = caller(exec)
      if (typeof who === 'string') return { value: { ok: false }, text: who }
      const raw = args['files']
      const files: Array<{ path: string; description?: string }> = []
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item === null || typeof item !== 'object') continue
          const entry = item as Record<string, unknown>
          const path = typeof entry['path'] === 'string' ? entry['path'].trim() : ''
          if (path === '') continue
          const description = typeof entry['description'] === 'string'
            ? entry['description'].trim()
            : ''
          files.push(description === '' ? { path } : { path, description })
        }
      }
      if (files.length === 0) {
        return { value: { ok: false }, text: 'files 至少要有 1 个文件（每项 { path, description }）。' }
      }
      const result = await deps.deliverFiles({ roomId: who.roomId, botId: who.botId, files })
      if (!result.ok) return { value: { ok: false }, text: result.error ?? '交付失败。' }
      const names = (result.files ?? []).map(file => file.name)
      return {
        value: { ok: true, files: result.files ?? [] },
        text: `已交付 ${names.length} 个文件：${names.join('、')}。用户会在你这条回复下方看到文件卡片。`,
      }
    },
  })

  // ── S2-2 CHAIN-OF-RECALL: three read-only tools ─────────────────────────────
  //
  // The history window leaves stubs with ids; these tools are how a bot expands one. They are
  // read-only, bound to the caller's OWN room (via `ownerOf`), and registered only when the
  // deployment enables the feature — a room that does not need recall should not pay the tool
  // schema tokens for it.
  if (deps.recallEnabled === true && deps.readHistory !== undefined) {
    add({
      name: 'agent_community_read_history',
      description:
        'Read ONE page of this room\'s earlier messages, for when the history window shows a '
        + '"更早消息·stub" line you need the full text of. Newest page by default; pass `before` '
        + '(a message id from the stub or a previous page) to page older. Optional `threadId` / '
        + '`taskId` narrow the page to one thread/task. Read-only; only this room is visible.',
      properties: {
        limit: { type: 'number', description: 'Messages per page (1-20, default 8).' },
        before: { type: 'string', description: 'Return messages older than this message id.' },
        threadId: { type: 'string', description: 'Only messages of this thread.' },
        taskId: { type: 'string', description: 'Only messages of this task.' },
      },
      required: [],
      run: async (args, exec) => {
        const who = caller(exec)
        if (typeof who === 'string') return { value: { ok: false }, text: who }
        const page = await deps.readHistory!({
          roomId: who.roomId,
          botId: who.botId,
          ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
          ...(typeof args['before'] === 'string' && args['before'] !== '' ? { before: args['before'] } : {}),
          ...(typeof args['threadId'] === 'string' && args['threadId'] !== '' ? { threadId: args['threadId'] } : {}),
          ...(typeof args['taskId'] === 'string' && args['taskId'] !== '' ? { taskId: args['taskId'] } : {}),
        })
        if (page.count === 0) {
          return { value: { ok: true, messages: [], more: false }, text: '这一页没有更早的消息了。' }
        }
        const lines = page.messages.map(m => `[#${m.id.slice(0, 8)}] ${m.senderName} · ${m.at}\n${m.text}`)
        return {
          value: { ok: true, messages: page.messages, more: page.more },
          text: `${lines.join('\n\n')}${page.more
            ? `\n\n（还有更早的：用 before=最后一页最旧一条的 id 继续翻）`
            : ''}`,
        }
      },
    })
  }
  if (deps.recallEnabled === true && deps.readRun !== undefined) {
    add({
      name: 'agent_community_read_run',
      description:
        'Read one run\'s summary in THIS room (status, times, duration, error, finish report). '
        + 'Use it to check what an earlier turn actually did instead of re-reading the transcript.',
      properties: {
        runId: { type: 'string', required: true, description: 'Run id (from a message or a stub).' },
      },
      required: ['runId'],
      run: async (args, exec) => {
        const who = caller(exec)
        if (typeof who === 'string') return { value: { ok: false }, text: who }
        const runId = typeof args['runId'] === 'string' ? args['runId'].trim() : ''
        if (runId === '') return { value: { ok: false }, text: 'runId 不能为空。' }
        const result = await deps.readRun!({ roomId: who.roomId, botId: who.botId, runId })
        if (!result.ok || result.run === undefined) {
          return { value: { ok: false }, text: result.reason ?? '找不到这个 run。' }
        }
        return {
          value: { ok: true, run: result.run },
          text: JSON.stringify(result.run, null, 2),
        }
      },
    })
  }
  if (deps.recallEnabled === true && deps.readTask !== undefined) {
    add({
      name: 'agent_community_read_task',
      description:
        'Read the room\'s task board: the current objective, who was assigned what, and the '
        + 'finished report when there is one. Read-only; this room only.',
      properties: {
        taskId: { type: 'string', description: 'Optional task id; omitted = the room\'s current board.' },
      },
      required: [],
      run: async (args, exec) => {
        const who = caller(exec)
        if (typeof who === 'string') return { value: { ok: false }, text: who }
        const result = await deps.readTask!({
          roomId: who.roomId,
          botId: who.botId,
          ...(typeof args['taskId'] === 'string' && args['taskId'] !== '' ? { taskId: args['taskId'] } : {}),
        })
        if (!result.ok) return { value: { ok: false }, text: result.reason ?? '房间没有任务板。' }
        return { value: { ok: true, task: result.task }, text: JSON.stringify(result.task, null, 2) }
      },
    })
  }

  if (failedTools.length > 0) {
    // Reported, never swallowed: a missing tool is why a bot "cannot do X", and the reason
    // (a name the deployment already owns) is not something the model can guess.
    return failedTools
  }
  return []
}
