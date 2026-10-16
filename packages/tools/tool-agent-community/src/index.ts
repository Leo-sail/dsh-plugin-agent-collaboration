/** Model-facing tools for Agent Community — Bot and room management. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from './dsh-compat.ts'
// Type-only: pulls in the `ctx.agentCommunity` declaration merge without
// creating a runtime edge (the Service itself is provided by the core package).
import type {} from '@dsh-plugin-agent-community/agent-community'

export const name = 'plugin-tool-agent-community'
export const inject = ['agents', 'agentCommunity', 'tools'] as const

export interface Config {
  readonly maxListResults?: number
}

export const Config: z<Config> = z.object({
  maxListResults: z.number().step(1).min(1).default(50),
})

function caller(agent: Agent | undefined, toolName: string): Agent {
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/**
 * Refuse a `room_id` that is not the room the calling Bot is working in.
 *
 * A Bot's session names exactly one room, and a tool parameter must never widen that: without this
 * check a bot running in group A could read or post into group B (or into somebody's 1:1) simply by
 * naming it — measured in the host, where `postBotMessage` resolved the sender from the session but
 * never compared the session's room with the requested one. The user's rule for this plugin is
 * explicit: 不能将单聊中的任务发到群聊内，也不能将群聊内的任务发到单聊中，也不能将A群聊的任务发到B群聊中.
 *
 * A caller with NO plugin session (the user's own agent, or the panel) is not restricted: there is
 * no bot identity to protect, and the user may legitimately address any room.
 */
function assertOwnRoom(ctx: Context, agent: Agent, roomId: string, toolName: string): void {
  const own = ctx.agentCommunity.roomForSession(agent.session.id)
  // `undefined` = the caller is not a plugin bot (the user's own agent, the panel): the user may
  // address any room. The host enforces the same rule again where the session is authoritative
  // (see room-guard.ts `crossRoomError`) — a tool-level check alone would be one refactor away
  // from being bypassed.
  if (own === undefined || own === roomId) return
  throw new Error(
    `${toolName}: 你只能在自己所在的房间操作（当前房间 ${own}），不能对其它房间读写；`
    + '跨房间的任务请由用户转发，或由用户在界面上把 Bot 拉进那个房间。',
  )
}

// `{ type: 'json' as const }` lets the `O` type parameter infer as
// `JsonValueSchemaSpec`, so `InferValue<O>` becomes `JsonValue` and `execute`
// can return any JSON-safe value.  Per-tool object shapes would give a tighter
// `execute` return type but also a tighter `render` — since the values come
// straight from service methods whose interfaces already enforce correctness, the
// looser `json` spec gives the same runtime guarantee with less coupling.
function jsonOutput() {
  return {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [
      { type: 'text' as const, text: JSON.stringify(value) },
    ],
  }
}


export function apply(ctx: Context, config: Config = {}): void {
  const _maxResults = config.maxListResults ?? 50

  ctx.tools.register(defineTool({
    name: 'agent_community_create_bot',
    description: 'Create a new Bot with custom configuration. Returns the created Bot identity.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique Bot name.' },
      description: { type: 'string', description: 'Short description of the Bot.' },
      system_prompt: { type: 'string', description: 'System prompt for the Bot.' },
      model: { type: 'string', description: 'Model identifier (e.g. deepseek-chat).' },
      provider: { type: 'string', description: 'LLM provider name.' },
      workspace: { type: 'string', description: 'Working directory for this Bot.' },
      mention_only: { type: 'boolean', description: 'Only respond when mentioned.' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      void caller(exec.agent, 'agent_community_create_bot')
      return JSON.parse(JSON.stringify(await ctx.agentCommunity.createBot({
        name: args.name,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.system_prompt !== undefined ? { systemPrompt: args.system_prompt } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.provider !== undefined ? { provider: args.provider } : {}),
        ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
        ...(args.mention_only !== undefined ? { mentionOnly: args.mention_only } : {}),
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_update_bot',
    description: 'Update an existing Bot configuration.',
    parameters: {
      id: { type: 'string', required: true, description: 'Bot id.' },
      name: { type: 'string', description: 'New Bot name.' },
      description: { type: 'string', description: 'New description.' },
      system_prompt: { type: 'string', description: 'New system prompt.' },
      model: { type: 'string', description: 'New model identifier.' },
      provider: { type: 'string', description: 'New provider name.' },
      workspace: { type: 'string', description: 'New working directory.' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      void caller(exec.agent, 'agent_community_update_bot')
      return JSON.parse(JSON.stringify(await ctx.agentCommunity.updateBot({
        id: args.id,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.system_prompt !== undefined ? { systemPrompt: args.system_prompt } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.provider !== undefined ? { provider: args.provider } : {}),
        ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_list_bots',
    description: 'List all Bots in the community.',
    parameters: {},
    output: jsonOutput(),
    execute(_args, exec) {
      void caller(exec.agent, 'agent_community_list_bots')
      return Promise.resolve(JSON.parse(JSON.stringify(ctx.agentCommunity.listBots())))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_create_room',
    description: [
      'Create a new chat room. Set direct_bot_id for a direct chat, or member_ids for a group chat.',
      'A BOT MUST NOT USE THIS TO START A GROUP: in a one-to-one chat call propose_group instead —',
      'the user confirms it and the group is created for you (measured failure: a bot that built its',
      'own room left the user with two groups for one request). Inside a group, ask the user to create',
      'a new one in the Bots团队 panel. Creating a direct chat room is fine.',
    ].join(' '),
    parameters: {
      name: { type: 'string', required: true, description: 'Room name.' },
      direct_bot_id: { type: 'string', description: 'Bot id for a direct chat room.' },
      member_ids: { type: 'array', items: { type: 'string' }, description: 'Bot ids for a group room.' },
      mention_only: { type: 'boolean', description: 'Bots only respond when mentioned.' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      void caller(exec.agent, 'agent_community_create_room')
      return JSON.parse(JSON.stringify(await ctx.agentCommunity.createRoom({
        name: args.name,
        ...(args.direct_bot_id !== undefined ? { directBotId: args.direct_bot_id } : {}),
        ...(args.member_ids !== undefined ? { memberIds: args.member_ids } : {}),
        ...(args.mention_only !== undefined ? { mentionOnly: args.mention_only } : {}),
        // Which agent is asking, so the host can refuse a Bot-created GROUP (room-guard.ts).
        // Absent for a caller with no agent session — that is the user.
        ...(exec.agent?.session?.id !== undefined ? { actorSessionId: exec.agent.session.id } : {}),
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_send_message',
    description: 'Send a message to a room.',
    parameters: {
      room_id: { type: 'string', required: true, description: 'Target room id.' },
      text: { type: 'string', required: true, description: 'Message text.' },
      sender_name: { type: 'string', description: 'Display name for the sender.' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const agent = caller(exec.agent, 'agent_community_send_message')
      assertOwnRoom(ctx, agent, args.room_id, 'agent_community_send_message')
      return JSON.parse(JSON.stringify(await ctx.agentCommunity.sendMessage({
        roomId: args.room_id,
        text: args.text,
        ...(args.sender_name !== undefined ? { senderName: args.sender_name } : {}),
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_remember',
    description: [
      'Remember ONE durable line about the room you are working in right now — a decision, a',
      'preference, a constraint — so your next turn in this same room still knows it.',
      'THIS ROOM ONLY: what you remember here never appears in another room, and your memory of',
      'another room is not visible to you here. Keep it to one short sentence; the room you write',
      'to is taken from your own session, so there is no room to specify.',
    ].join(' '),
    parameters: {
      text: { type: 'string', required: true, description: 'One short sentence to remember.' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const agent = caller(exec.agent, 'agent_community_remember')
      // Awaited: `stored: true` must mean the file is on disk (see memory-store). Reporting
      // success before the write lands is how a bot confidently "remembers" nothing.
      const result = await ctx.agentCommunity.rememberForSession({ sessionId: agent.session.id, text: args.text })
      return result.ok
        ? { stored: true, note: '已记住（仅本房间可见）。' }
        : { stored: false, error: result.reason ?? '无法写入记忆' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_list_runs',
    description: 'List Bot runs, optionally filtered by Bot id.',
    parameters: {
      bot_id: { type: 'string', description: 'Filter by Bot id.' },
    },
    output: jsonOutput(),
    execute(args, exec) {
      void caller(exec.agent, 'agent_community_list_runs')
      return Promise.resolve(JSON.parse(JSON.stringify(ctx.agentCommunity.listRuns(args.bot_id))))
    },
  }))

  // ── Orchestration tools (P1-2 / P1-3) ──────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'agent_community_get_context',
    description: [
      'Get the current room context: room info, active round, task table, recent reports,',
      'member roster, and recent messages. Call this first to orient yourself before acting.',
    ].join(' '),
    parameters: {
      room_id: { type: 'string', description: 'Room id (leave empty to infer from caller session).' },
    },
    output: jsonOutput(),
    execute(args, exec) {
      const agent = caller(exec.agent, 'agent_community_get_context')
      // Resolve room from explicit arg or from the caller's session
      const roomId = args.room_id ?? ctx.agentCommunity.roomForSession(agent.session.id)
      if (roomId === undefined) throw new Error('room_id required — cannot infer from caller')
      assertOwnRoom(ctx, agent, roomId, 'agent_community_get_context')
      return Promise.resolve(JSON.parse(JSON.stringify(ctx.agentCommunity.getRoomContext(roomId))))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_post_message',
    description: [
      'Send a message to ANOTHER Bot in this room. This is peer coordination, not how you',
      'answer the user: your own reply is published in the room automatically when your turn',
      'ends, so posting it here as well makes the user see your answer TWICE (measured: a bot',
      'answered a greeting and then posted the same text again, and the room showed two rows).',
      'Only call this when the text is FOR another bot, and pass its exact name as to_bot_name',
      'so the message is directed at that bot rather than repeated to the room.',
      'Do NOT call it with a summary, a restatement, or a duplicate of your answer.',
    ].join(' '),
    parameters: {
      room_id: { type: 'string', description: 'Room id.' },
      text: { type: 'string', required: true, description: 'Message text.' },
      to_bot_name: { type: 'string', description: 'Target Bot name for direct delivery (a2a).' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const agent = caller(exec.agent, 'agent_community_post_message')
      const roomId = args.room_id ?? ctx.agentCommunity.roomForSession(agent.session.id)
      if (roomId === undefined) throw new Error('room_id required')
      assertOwnRoom(ctx, agent, roomId, 'agent_community_post_message')
      const posted = JSON.parse(JSON.stringify(await ctx.agentCommunity.postBotMessage({
        roomId,
        senderSessionId: agent.session.id,
        text: args.text,
        ...(args.to_bot_name !== undefined ? { toBotName: args.to_bot_name } : {}),
      })))
      // ── TELL THE MODEL WHEN IT JUST DUPLICATED ITSELF ───────────────────────────
      //
      // The answer this run produces is published automatically, so an undirected post made
      // while the bot is still answering is a second copy of it. Observed: a bot answered a
      // greeting and then posted the same text, and the user saw two replies to one message
      // (「群聊内的 bot 会对我的消息回复两次，这简直有病」). The tool description and the
      // group prompt both say not to do this; this line is what a session that already
      // learned the old habit actually reads.
      if (args.to_bot_name === undefined && ctx.agentCommunity.isAnsweringNow(roomId, agent.session.id)) {
        return {
          ...posted,
          warning: '这一轮的正文答复会自动发布到群里，不需要再 post 一次。'
            + '你刚刚发出去的内容会和你的答复重复，用户会看到两次。'
            + '如果这条消息是要发给群里另一个 Bot 的，请带上 to_bot_name。',
        }
      }
      return posted
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_task_decompose',
    description: [
      'LEADER ONLY. Break the user request into tasks and optionally assign them.',
      'Each unassigned task goes into the open pool for later assignment.',
    ].join(' '),
    parameters: {
      room_id: { type: 'string', description: 'Room id.' },
      tasks: {
        type: 'array',
        required: true,
        // `type: 'json'` is NOT a JSON Schema type: the model-facing parameters must use a real
        // one, or the provider rejects the whole request (measured on the core package's tools:
        // one malformed schema silenced every bot reply). `object` with open properties is what
        // this always meant — each item is `{ subject, detail?, assignee? }`.
        items: { type: 'object' as const, additionalProperties: true },
        description: 'Task list. Each item: { subject: string, detail?: string, assignee?: string }',
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const agent = caller(exec.agent, 'agent_community_task_decompose')
      const roomId = args.room_id ?? ctx.agentCommunity.roomForSession(agent.session.id)
      if (roomId === undefined) throw new Error('room_id required')
      assertOwnRoom(ctx, agent, roomId, 'agent_community_task_decompose')
      const tasks = (args.tasks as Array<{ subject: string; detail?: string; assignee?: string }>)
      return JSON.parse(JSON.stringify(await ctx.agentCommunity.decomposeTasks({
        roomId,
        leaderSessionId: agent.session.id,
        tasks: tasks.map(t => ({
          subject: t.subject,
          ...(t.detail !== undefined ? { detail: t.detail } : {}),
          ...(t.assignee !== undefined ? { assigneeName: t.assignee } : {}),
        })),
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_task_assign',
    description: 'LEADER ONLY. Assign or re-assign tasks to a Bot by name.',
    parameters: {
      room_id: { type: 'string', description: 'Room id.' },
      task_ids: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Task ids to assign.',
      },
      assignee: { type: 'string', required: true, description: 'Target Bot name.' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const agent = caller(exec.agent, 'agent_community_task_assign')
      const roomId = args.room_id ?? ctx.agentCommunity.roomForSession(agent.session.id)
      if (roomId === undefined) throw new Error('room_id required')
      assertOwnRoom(ctx, agent, roomId, 'agent_community_task_assign')
      return JSON.parse(JSON.stringify(await ctx.agentCommunity.assignTasks({
        roomId,
        leaderSessionId: agent.session.id,
        taskIds: args.task_ids as string[],
        assigneeName: args.assignee,
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_task_status',
    description: 'List all tasks in this round with their current status and latest reports.',
    parameters: {
      room_id: { type: 'string', description: 'Room id.' },
    },
    output: jsonOutput(),
    execute(args, exec) {
      const agent = caller(exec.agent, 'agent_community_task_status')
      const roomId = args.room_id ?? ctx.agentCommunity.roomForSession(agent.session.id)
      if (roomId === undefined) throw new Error('room_id required')
      assertOwnRoom(ctx, agent, roomId, 'agent_community_task_status')
      return Promise.resolve(JSON.parse(JSON.stringify(ctx.agentCommunity.getTaskStatus(roomId))))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_task_report',
    description: [
      'MEMBER ONLY. Submit a progress report for a task you were assigned.',
      'Set status to "done" when complete, "blocked" if you cannot proceed.',
    ].join(' '),
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id.' },
      text: { type: 'string', required: true, description: 'Report text.' },
      status: {
        type: 'string',
        required: true,
        description: 'New task status: "working", "done", or "blocked".',
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const agent = caller(exec.agent, 'agent_community_task_report')
      return JSON.parse(JSON.stringify(await ctx.agentCommunity.reportTask({
        taskId: args.task_id,
        memberSessionId: agent.session.id,
        text: args.text,
        status: args.status as 'working' | 'done' | 'blocked',
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_community_submit_final',
    description: [
      'LEADER ONLY. Wrap up this round: post a summary message to the room and mark the round done.',
      'Call this when all tasks are done/blocked, or when continuing adds no further value.',
      'Do not keep dispatching just to keep dispatching — call this when the work is finished.',
    ].join(' '),
    parameters: {
      room_id: { type: 'string', description: 'Room id.' },
      summary: { type: 'string', required: true, description: 'Summary of what was accomplished.' },
      reply_to_user: { type: 'string', required: true, description: 'Final reply to show the user.' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const agent = caller(exec.agent, 'agent_community_submit_final')
      const roomId = args.room_id ?? ctx.agentCommunity.roomForSession(agent.session.id)
      if (roomId === undefined) throw new Error('room_id required')
      return JSON.parse(JSON.stringify(await ctx.agentCommunity.submitFinal({
        roomId,
        leaderSessionId: agent.session.id,
        summary: args.summary,
        replyToUser: args.reply_to_user,
      })))
    },
  }))
}
