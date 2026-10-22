/**
 * Tests for the structured abstention (OP-12).
 *
 * Layer 1 — `normalizeAbstain` / `abstainNotice`: the bounds a bot's "I cannot do this" must fit
 * into before it becomes a visible transcript row.
 *
 * Layer 2 — the tool surface: `agent_community_abstain` is registered for every room, refuses a
 * missing reason itself, and hands the rest to `deps.abstain` (the service half, which turns it
 * into a visible notice). No host, no Cordis runtime: the registration only needs a fake
 * `tools.register` and a deps object.
 *
 * Run with: node --test tests/abstention.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ABSTAIN_MAX_MISSING,
  ABSTAIN_MAX_MISSING_LENGTH,
  ABSTAIN_MAX_OWNER_LENGTH,
  ABSTAIN_MAX_REASON_LENGTH,
  abstainNotice,
  normalizeAbstain,
} from '../packages/core/agent-community/src/abstention.ts'
import { registerCollaborationTools } from '../packages/core/agent-community/src/collaboration-tools.ts'

// ── normalizeAbstain ────────────────────────────────────────────────────────

test('a normal abstention is trimmed and kept as-is', () => {
  const normalized = normalizeAbstain({
    reason: '  缺少最新季度的销售数据  ',
    missing: ['销售数据', ' 权限 '],
    suggestedOwner: ' 小刘 ',
  })
  assert.deepEqual(normalized, {
    reason: '缺少最新季度的销售数据',
    missing: ['销售数据', '权限'],
    suggestedOwner: '小刘',
  })
})

test('an abstention with no reason is rejected (the reason IS the feature)', () => {
  assert.equal(normalizeAbstain({ reason: '' }), undefined)
  assert.equal(normalizeAbstain({ reason: '   ' }), undefined)
})

test('missing entries are capped at five, deduped, and each is clamped', () => {
  const long = '数'.repeat(ABSTAIN_MAX_MISSING_LENGTH + 50)
  const normalized = normalizeAbstain({
    reason: '缺不少东西',
    missing: [long, 'A', 'A', 'B', 'C', 'D', 'E', 'F'],
  })
  assert.ok(normalized !== undefined)
  assert.equal(normalized.missing.length, ABSTAIN_MAX_MISSING)
  assert.ok(normalized.missing[0]!.length <= ABSTAIN_MAX_MISSING_LENGTH)
  assert.equal(normalized.missing.filter(entry => entry === 'A').length, 1)
})

test('owner and reason are clamped too', () => {
  const normalized = normalizeAbstain({
    reason: '很'.repeat(ABSTAIN_MAX_REASON_LENGTH + 100),
    suggestedOwner: '名'.repeat(ABSTAIN_MAX_OWNER_LENGTH + 40),
  })
  assert.ok(normalized !== undefined)
  assert.ok(normalized.reason.length <= ABSTAIN_MAX_REASON_LENGTH)
  assert.ok(normalized.suggestedOwner !== undefined
    && normalized.suggestedOwner.length <= ABSTAIN_MAX_OWNER_LENGTH)
})

test('empty optional fields disappear instead of becoming empty strings', () => {
  const normalized = normalizeAbstain({ reason: '做不了', missing: [], suggestedOwner: '   ' })
  assert.deepEqual(normalized, { reason: '做不了', missing: [] })
})

// ── the visible notice ──────────────────────────────────────────────────────

test('the notice names the bot, the reason, what is missing and the suggested owner', () => {
  const text = abstainNotice(
    { reason: '缺少原始数据', missing: ['数据集', '访问权限'], suggestedOwner: '小刘' },
    '小钱',
  )
  assert.match(text, /「小钱」/u)
  assert.match(text, /缺少原始数据/u)
  assert.match(text, /缺少：数据集、访问权限/u)
  assert.match(text, /建议由「小刘」接手/u)
})

test('the notice omits sections that carry no information', () => {
  const bare = abstainNotice({ reason: '做不了', missing: [] }, '小钱')
  assert.match(bare, /「小钱」/u)
  assert.doesNotMatch(bare, /缺少：/u)
  assert.doesNotMatch(bare, /建议由/u)
})

// ── the tool surface ────────────────────────────────────────────────────────

interface CapturedTool {
  readonly name: string
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>
}

/**
 * Register the collaboration tools against a fake agent scope and a fake deps object.
 *
 * Only the seams this test touches are real: `tools.register` (captured) and `deps.ownerOf` /
 * `deps.abstain`. Everything else throws if called, so an unexpected call is a test failure
 * rather than a silent pass.
 */
function registerFake(abstain: (input: {
  roomId: string
  botId: string
  reason: string
  missing?: readonly string[] | undefined
  suggestedOwner?: string | undefined
}) => Promise<{ ok: boolean; reason?: string }>): Map<string, CapturedTool> {
  const captured = new Map<string, CapturedTool>()
  const agentCtx = {
    tools: {
      register: (definition: CapturedTool) => { captured.set(definition.name, definition) },
    },
  }
  const deps = new Proxy<Record<string, unknown>>({
    ownerOf: () => ({ roomId: 'room-1', botId: 'bot-1' }),
    roomKind: () => 'group',
    abstain,
  }, {
    get: (target, key) => {
      const value = target[key as string]
      if (value !== undefined) return value
      return () => { throw new Error(`unexpected deps.${String(key)} call`) }
    },
  })
  registerCollaborationTools(agentCtx as never, deps as never)
  return captured
}

test('agent_community_abstain is registered for every room', () => {
  const tools = registerFake(async () => ({ ok: true }))
  assert.ok(tools.has('agent_community_abstain'))
})

test('the tool refuses an empty reason before reaching the service', async () => {
  const calls: unknown[] = []
  const tools = registerFake(async (input) => {
    calls.push(input)
    return { ok: true }
  })
  const tool = tools.get('agent_community_abstain')
  assert.ok(tool !== undefined)
  const result = await tool.execute({ reason: '   ' }, {})
  assert.equal(result['ok'], false)
  assert.equal(calls.length, 0)
})

test('the tool passes the structured fields through and reports success', async () => {
  const calls: unknown[] = []
  const tools = registerFake(async (input) => {
    calls.push(input)
    return { ok: true }
  })
  const tool = tools.get('agent_community_abstain')
  assert.ok(tool !== undefined)
  const result = await tool.execute(
    { reason: ' 缺数据 ', missing: [' 数据集 ', ''], suggestedOwner: ' 小刘 ' },
    { agent: { session: { id: 'ac:room-1:bot-1' } } },
  )
  assert.equal(result['ok'], true)
  assert.equal(typeof result['message'], 'string')
  assert.match(String(result['message']), /不是失败/u)
  assert.deepEqual(calls[0], {
    roomId: 'room-1',
    botId: 'bot-1',
    reason: '缺数据',
    missing: ['数据集'],
    suggestedOwner: '小刘',
  })
})

test('a service-side refusal is reported back to the model', async () => {
  const tools = registerFake(async () => ({ ok: false, reason: '房间已不存在' }))
  const tool = tools.get('agent_community_abstain')
  assert.ok(tool !== undefined)
  const result = await tool.execute({ reason: '缺数据' }, {})
  assert.equal(result['ok'], false)
  assert.match(String(result['message']), /房间已不存在/u)
})
