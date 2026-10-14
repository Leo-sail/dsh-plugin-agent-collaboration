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
  /** Record a proposal and surface it to the user. */
  proposeGroup(input: {
    roomId: string
    botId: string
    name: string
    memberIds: readonly string[]
    reason: string
  }): void
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

const strList = (args: Record<string, unknown>, key: string): string[] => {
  const raw = args[key]
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

/** JSON Schema for a tool that returns a small object; the model reads the text form. */
const OPEN_OBJECT = { type: 'object', additionalProperties: true } as const

export function registerCollaborationTools(agentCtx: Context, deps: CollaborationToolDeps): void {
  const tools = (agentCtx as unknown as {
    tools?: { register(definition: unknown): void }
  }).tools
  if (tools === undefined || typeof tools.register !== 'function') return

  /**
   * Register one tool.
   *
   * `render` is what the model actually reads, so every tool returns a short,
   * actionable sentence rather than a JSON blob — the model acts on the outcome, and
   * a refusal has to say what to do instead.
   */
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
    tools.register({
      name: spec.name,
      description: spec.description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: spec.properties,
        required: [...spec.required],
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
    run: (args, exec) => {
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
      deps.proposeGroup({
        roomId: who.roomId,
        botId: who.botId,
        name: str(args, 'name') || '协作群聊',
        memberIds: members,
        reason: str(args, 'reason'),
      })
      return {
        value: { ok: true, proposed: true, members },
        text: '已提交给用户确认。不要再调用工具，等待用户决定。',
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
        return { value: { ok: false }, text: 'invite_bot is only available in a group chat' }
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
      + 'leader may call this, at most four bots per call, and never yourself.',
    properties: {
      botIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Member ids to remove, from the room roster. One or several.',
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
      const botIds = strList(args, 'botIds')
      if (botIds.length === 0) return { value: { ok: false }, text: 'botIds is required' }
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
      // nobody asked for. Measured on the real host: the user said only 你好, the question was never
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
}
