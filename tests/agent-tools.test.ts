/**
 * Unit tests for the host-tool denial surface (session-runner.ts).
 *
 * DUP-17: DSH's own Agent Teams registers a SECOND task board on the bot's agent scope
 * (`team_task_create/list/get/update`). A room already has one — `assign_task`/`dispatch`,
 * `message_member` reports, `finish_task`'s single summary — so a bot using the host board
 * records work nobody in the room can see. The tools cannot be un-mounted from the plugin
 * (DSH's `restrict` only masks GLOBAL tools; these are scope-local), so a `tools.guard()`
 * refuses them with a reason the model reads. These tests pin the refusal list and the message.
 *
 * Run with: node --test tests/agent-tools.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AGENT_TEAMS_TOOL_PREFIXES,
  AGENT_TEAMS_TOOLS,
  DEFAULT_DENIED_TOOLS,
  agentTeamsDenial,
  toolNameOf,
} from '../packages/core/agent-community/src/session-runner.ts'

const HOST_TASK_BOARD_TOOLS = [
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'team_task_delete',
] as const

// ── the host task board must be refused ─────────────────────────────────────

test('every host team_task_* tool is refused with the room-board reason', () => {
  for (const name of HOST_TASK_BOARD_TOOLS) {
    const denial = agentTeamsDenial({ toolName: name })
    assert.ok(denial !== undefined, `${name} must be denied`)
    assert.match(denial, /不属于本房间/u)
    assert.match(denial, /assign_task/u)
    assert.match(denial, /message_member/u)
    assert.match(denial, /finish_task/u)
    // The task-board family gets its own sentence: a second board is the problem.
    assert.match(denial, /任务板/u)
  }
})

test('a future team_task_… name is refused by prefix, not only by exact name', () => {
  assert.ok(AGENT_TEAMS_TOOL_PREFIXES.includes('team_task_'))
  const denial = agentTeamsDenial({ toolName: 'team_task_archive' })
  assert.ok(denial !== undefined)
  assert.match(denial, /team_task_archive/u)
})

test('the host task board names are also on the deny list (belt for hosts that allow it)', () => {
  for (const name of HOST_TASK_BOARD_TOOLS) {
    assert.ok(DEFAULT_DENIED_TOOLS.includes(name), `${name} missing from DEFAULT_DENIED_TOOLS`)
    assert.ok(AGENT_TEAMS_TOOLS.includes(name), `${name} missing from AGENT_TEAMS_TOOLS`)
  }
  // No duplicated entry: a deny list with duplicates is a sign one was added twice.
  assert.equal(new Set(DEFAULT_DENIED_TOOLS).size, DEFAULT_DENIED_TOOLS.length)
})

// ── the room's own tools must NOT be refused ───────────────────────────────

test('the room collaboration surface is never refused by this guard', () => {
  for (const name of [
    'agent_community_dispatch',
    'assign_task',
    'message_member',
    'finish_task',
    'invite_bot',
    'remove_bot',
    'propose_group',
    'agent_community_deliver',
    'agent_community_goal',
    'agent_community_recall',
  ]) {
    assert.equal(agentTeamsDenial({ toolName: name }), undefined, `${name} must stay usable`)
  }
})

test('Agent Teams teammate tools stay refused', () => {
  for (const name of ['list_agents', 'send_message', 'interrupt_agent', 'spawn_teammate', 'wait_agent']) {
    const denial = agentTeamsDenial({ name })
    assert.ok(denial !== undefined, `${name} must be denied`)
  }
  // A tool denied elsewhere (plugin_manager) is not this guard's business: it returns undefined
  // and the host's own deny handles it.
  assert.equal(agentTeamsDenial({ toolName: 'plugin_manager' }), undefined)
})

// ── the name is read from whichever shape the runtime hands over ───────────

test('toolNameOf reads the call name from every documented exec shape', () => {
  assert.equal(toolNameOf({ toolName: 'x' }), 'x')
  assert.equal(toolNameOf({ name: 'x' }), 'x')
  assert.equal(toolNameOf({ call: { name: 'x' } }), 'x')
  assert.equal(toolNameOf({ tool: { name: 'x' } }), 'x')
  assert.equal(toolNameOf({ toolName: '' }), undefined)
  assert.equal(toolNameOf({}), undefined)
  assert.equal(toolNameOf(null), undefined)
  assert.equal(toolNameOf(undefined), undefined)
})
