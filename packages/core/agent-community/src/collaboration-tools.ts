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
import type { DeliveredFile } from './types.ts'

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
    readonly learned: readonly string[]
    readonly path: string
  }>

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
    readonly status: 'active' | 'paused' | 'done'
    readonly updatedAt: string
  } | undefined
  /** Create / edit / pause / resume / finish THIS room's goal. */
  setRoomGoal(input: {
    roomId: string
    botId: string
    text?: string | undefined
    status?: 'active' | 'paused' | 'done' | undefined
  }): Promise<{ readonly ok: boolean; readonly reason?: string | undefined }>
  /** Queue work for several members and return immediately (§4.1). */
  dispatch(input: {
    roomId: string
    botId: string
    tasks: ReadonlyArray<{ readonly bot: string; readonly task: string }>
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
  /** Fan work out to members. Returns what was accepted and what was refused. */
  assignTask(input: {
    roomId: string
    leaderId: string
    botIds: readonly string[]
    task: string
  }): { assigned: readonly string[]; refused: readonly string[] }
  /** Declare the task complete; publishes the report as a group message. */
  finishTask(input: { roomId: string; leaderId: string; report: string }): void
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

  // ── agent_community_recall (room-scoped search) ─────────────────────────────
  add({
    name: 'agent_community_recall',
    description:
      'Search what you have actually done in THIS room (and the lessons in your global memory '
      + 'file) for a keyword. Use it when the injected memory is not enough: it returns the real '
      + 'entries with their run id and time, so you can rely on what happened instead of '
      + 'guessing. Another room\'s memory is not searchable from here.',
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
        lines.push(`· [${hit.at}${hit.runId === undefined ? '' : ` run=${hit.runId}`}] ${hit.text}`)
      }
      if (found.learned.length > 0) {
        lines.push(`· 全局记忆里相关：${found.learned.join(' / ')}`)
      }
      if (lines.length === 0) {
        return { value: { ok: true, hits: [] }, text: `本房间没有与「${query}」相关的记忆（出处：${found.path}）。` }
      }
      return { value: { ok: true, hits: found.hits }, text: `本房间记忆中与「${query}」相关的 ${found.hits.length} 条：\n${lines.join('\n')}\n出处：${found.path}` }
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
      'Set, change, pause, resume or finish the goal of the room you are in. Only the room\'s '
      + 'leader (or the user) may change it in a group; in a 1:1 the bot may. One room only: '
      + 'the room is taken from your own session, and another room\'s goal is unreachable.',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'pause', 'resume', 'done'],
        description: 'get = 读当前房间目标；set = 设定/改写；pause/resume/done = 暂停/继续/完成。',
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
        const label = goal.status === 'active' ? '进行中' : goal.status === 'paused' ? '已暂停' : '已完成'
        return {
          value: { ok: true, goal },
          text: `本房间目标（${label}）：${goal.text}（最后更新 ${goal.updatedAt}）`,
        }
      }
      if (action === 'set' && text === '') {
        return { value: { ok: false }, text: 'action=set 需要给出 text（一句话的目标）。' }
      }
      const status = action === 'set' ? 'active' : action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'done'
      const result = await deps.setRoomGoal({
        roomId: who.roomId,
        botId: who.botId,
        ...(action === 'set' ? { text } : {}),
        status,
      })
      if (!result.ok) {
        return { value: { ok: false }, text: result.reason ?? '目标没有改动。' }
      }
      const verb = action === 'set' ? '已设定本房间目标' : action === 'pause' ? '已暂停本房间目标'
        : action === 'resume' ? '已继续本房间目标' : '已把本房间目标标记为完成'
      return { value: { ok: true, status }, text: `${verb}。它只对这个房间生效。` }
    },
  })

  // ── agent_community_dispatch (group, leader only) ───────────────────────────
  add({
    name: 'agent_community_dispatch',
    description:
      'Hand work to OTHER BOTS IN THIS ROOM — the way to parallelise, instead of opening your '
      + 'own sub-agents (their work is invisible to the room and unaccounted). Queues each '
      + 'member immediately and returns at once: report progress in your own answer this turn, '
      + 'and you will be woken with their reports when they finish. One to four members.',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            bot: { type: 'string', description: 'Member name or id (from the room roster).' },
            task: { type: 'string', description: 'What they should do, and what to produce.' },
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
      const result = deps.dispatch({ roomId: who.roomId, botId: who.botId, tasks })
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
      + 'several, or all. Each assignee starts immediately and reports back when finished.',
    properties: {
      botIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Member ids to assign, from the room roster.',
      },
      task: { type: 'string', description: 'What they should do, and what to produce.' },
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

  // ── finish_task (group only, leader only) ───────────────────────────────────
  add({
    name: 'finish_task',
    description:
      'Declare the group task complete and give the user the final report. This ends your turn '
      + 'immediately — do not call any more tools afterwards.',
    properties: {
      report: {
        type: 'string',
        description: 'The final report: what was done, what was produced, what remains.',
      },
    },
    required: ['report'],
    run: (args, exec) => {
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
      deps.finishTask({ roomId: who.roomId, leaderId: who.botId, report })
      // Ends the turn as soon as this result lands. The native loop has NO turn budget,
      // so without this the model could keep calling tools after declaring completion.
      exec.concludeTurn?.()
      return { value: { ok: true, finished: true }, text: '已汇报并结束本轮。' }
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

  if (failedTools.length > 0) {
    // Reported, never swallowed: a missing tool is why a bot "cannot do X", and the reason
    // (a name the deployment already owns) is not something the model can guess.
    return failedTools
  }
  return []
}
