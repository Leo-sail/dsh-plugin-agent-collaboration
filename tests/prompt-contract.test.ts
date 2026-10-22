/**
 * OP-05: the per-turn prompt format is a CONTRACT, not an emergent property of `buildPrompt`.
 *
 * Before this module the section order and the `\n\n` separators lived implicitly inside
 * `runs.ts buildPrompt`: any refactor could move a block or add a blank line, and every stored
 * evaluation would then compare prompts from a different harness without knowing. These
 * assertions lock the exact bytes:
 *
 *   · the six section names and their order;
 *   · the separator and the "no trailing separator" rule;
 *   · headers for history (both truncation states) and for this turn's input;
 *   · an object's key order can never influence the output;
 *   · missing/empty sections leave no blank line behind.
 *
 * Run with: node --test tests/prompt-contract.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RunExecutor } from '../packages/core/agent-community/src/runs.ts'
import {
  assemblePrompt,
  historyHeader,
  inputBlock,
  PROMPT_CONTRACT_VERSION,
  PROMPT_SEPARATOR,
  PROMPT_SECTION_ORDER,
  type PromptSections,
} from '../packages/core/agent-community/src/prompt-contract.ts'

// ── the contract itself ─────────────────────────────────────────────────────

test('the contract version and section order are fixed', () => {
  assert.equal(PROMPT_CONTRACT_VERSION, 1)
  assert.deepEqual([...PROMPT_SECTION_ORDER], ['role', 'skills', 'goal', 'memory', 'history', 'input'])
  assert.equal(PROMPT_SEPARATOR, '\n\n')
})

test('historyHeader covers both truncation states', () => {
  assert.equal(historyHeader(10, false), '[最近 10 条消息]')
  assert.equal(historyHeader(10, true), '[最近 10 条消息（已按长度截断）]')
  assert.equal(historyHeader(0, false), '[最近 0 条消息]')
})

test('inputBlock keeps the literal header and the verbatim text', () => {
  assert.equal(inputBlock('帮我写个方案'), '[本轮输入]\n帮我写个方案')
  assert.equal(inputBlock(''), '[本轮输入]\n')
  assert.equal(inputBlock('多行\n第二行'), '[本轮输入]\n多行\n第二行')
})

// ── assembly rules ─────────────────────────────────────────────────────────

test('all sections assemble in contract order with exactly one separator between them', () => {
  const sections: PromptSections = {
    role: '[角色]\n你是 小董。',
    skills: '[可用技能]\n- content-teardown',
    goal: '[本房间目标]\n[进行中] 完成方案',
    memory: '[本房间记忆]\n· 之前做过 X',
    history: '[最近 2 条消息]\nuser: 你好\n小董: 你好！',
    input: '[本轮输入]\n帮我写个方案',
  }
  const expected = [
    '[角色]\n你是 小董。',
    '[可用技能]\n- content-teardown',
    '[本房间目标]\n[进行中] 完成方案',
    '[本房间记忆]\n· 之前做过 X',
    '[最近 2 条消息]\nuser: 你好\n小董: 你好！',
    '[本轮输入]\n帮我写个方案',
  ].join('\n\n')
  assert.equal(assemblePrompt(sections), expected)
  // GOLDEN: the literal contract output (what every run's prompt must look like).
  assert.equal(assemblePrompt(sections), (
    '[角色]\n你是 小董。\n\n'
    + '[可用技能]\n- content-teardown\n\n'
    + '[本房间目标]\n[进行中] 完成方案\n\n'
    + '[本房间记忆]\n· 之前做过 X\n\n'
    + '[最近 2 条消息]\nuser: 你好\n小董: 你好！\n\n'
    + '[本轮输入]\n帮我写个方案'
  ))
})

test('the object key order cannot influence the output', () => {
  const forward: PromptSections = { role: 'R', skills: 'S', goal: 'G', memory: 'M', history: 'H', input: 'I' }
  // Same content, declared in the reverse (and a scrambled) order.
  const backward: PromptSections = { input: 'I', history: 'H', memory: 'M', goal: 'G', skills: 'S', role: 'R' }
  assert.equal(assemblePrompt(backward), assemblePrompt(forward))
  const scrambled: PromptSections = { history: 'H', input: 'I', role: 'R', memory: 'M', skills: 'S', goal: 'G' }
  assert.equal(assemblePrompt(scrambled), 'R\n\nS\n\nG\n\nM\n\nH\n\nI')
})

test('input is always the last block, whatever the declaration order', () => {
  const out = assemblePrompt({ input: 'I', role: 'R' })
  assert.equal(out, 'R\n\nI')
  assert.ok(out.endsWith('I'))
})

test('missing sections leave no blank line and no trailing separator', () => {
  assert.equal(assemblePrompt({}), '')
  assert.equal(assemblePrompt({ role: 'R' }), 'R')
  // history followed by input: exactly one separator, not two.
  assert.equal(assemblePrompt({ history: 'H', input: 'I' }), 'H\n\nI')
  // A missing middle section must not produce a double separator.
  assert.equal(assemblePrompt({ role: 'R', goal: 'G', input: 'I' }), 'R\n\nG\n\nI')
  assert.equal(assemblePrompt({ role: 'R' }).endsWith('\n\n'), false)
})

test('empty-string sections are skipped, exactly like missing ones', () => {
  assert.equal(assemblePrompt({ role: '', skills: 'S', input: '' }), 'S')
  assert.equal(assemblePrompt({ role: 'R', skills: '', goal: undefined, input: 'I' }), 'R\n\nI')
})

test('history header + body assemble into one section with no extra blank line', () => {
  const history = `${historyHeader(10, true)}\nuser：上一轮\nbot：好的`
  const out = assemblePrompt({ role: 'R', history, input: inputBlock('继续') })
  assert.equal(out, `R\n\n${history}\n\n[本轮输入]\n继续`)
  assert.equal(out.includes('\n\n\n'), false)
})

test('a realistic bot-turn golden is stable byte for byte', () => {
  // The fixture mirrors what runs.buildPrompt produces for a direct room with a goal and
  // memory. If this golden changes, PROMPT_CONTRACT_VERSION must change too — which is the
  // whole point of the version constant.
  const sections: PromptSections = {
    role: '[角色]\n你是一位 Bot 提示词工程师。\n你是 小董。把我需求拆成可执行提示词。',
    skills: '[可用技能]\n- dsh-bot-authoring\n- agent-prompt-design',
    goal: '[本房间目标]\n房间：小董。以下目标只属于这个房间，与其他房间无关。\n[进行中] 把 v2 方案交付',
    memory: '[本房间记忆]\n· 昨天已经写了两份分析',
    history: '[最近 3 条消息]\nuser：继续\n小董：好的\nuser：还有超时部分',
    input: inputBlock('把剩下的部分补完'),
  }
  const golden = assemblePrompt(sections)
  assert.equal(golden, (
    '[角色]\n你是一位 Bot 提示词工程师。\n你是 小董。把我需求拆成可执行提示词。\n\n'
    + '[可用技能]\n- dsh-bot-authoring\n- agent-prompt-design\n\n'
    + '[本房间目标]\n房间：小董。以下目标只属于这个房间，与其他房间无关。\n[进行中] 把 v2 方案交付\n\n'
    + '[本房间记忆]\n· 昨天已经写了两份分析\n\n'
    + '[最近 3 条消息]\nuser：继续\n小董：好的\nuser：还有超时部分\n\n'
    + '[本轮输入]\n把剩下的部分补完'
  ))
  // INPUT IS THE LAST THING THE MODEL READS.
  assert.ok(golden.endsWith('[本轮输入]\n把剩下的部分补完'))
  assert.equal(golden.split('\n\n').length, 6)
})

// ── the REAL buildPrompt, not just the assembler ───────────────────────────

test('runs.buildPrompt assembles the exact contract golden (byte for byte)', () => {
  // `buildPrompt` is private but callable: runs.ts imports without a host at runtime, so the
  // REAL producer of every bot prompt is pinned here rather than only the pure assembler.
  const T0 = '2026-10-22T00:00:00.000Z'
  const run = {
    id: 'run-1', botId: 'bot-1', roomId: 'room-1', sessionId: 'sess-1', status: 'running',
    controlRevision: 0, attempt: 0, maxAttempts: 3, prompt: '把剩下的部分补完', origin: 'user', createdAt: T0,
  }
  const bot = {
    id: 'bot-1', name: '小董', description: 'Bot 提示词工程师',
    systemPrompt: '你是一位严谨的工程师。', provider: 'p', model: 'm',
  }
  const messages = [
    { id: 'm1', roomId: 'room-1', sender: { kind: 'user', name: 'user' }, text: '继续', createdAt: T0 },
    { id: 'm2', roomId: 'room-1', sender: { kind: 'bot', botId: 'bot-1', name: '小董' }, text: '好的', createdAt: T0 },
    { id: 'm3', roomId: 'room-1', sender: { kind: 'user', name: 'user' }, text: '还有超时部分', createdAt: T0 },
  ]
  const svc = {
    getRoom: () => ({ memberIds: ['bot-1'], foldedSeqs: [] }),
    listMessages: () => messages,
    skillPromptFor: () => '[可用技能]\n- dsh-bot-authoring',
    roomGoalBlock: () => '[本房间目标]\n[进行中] 把方案补完',
    botMemoryFor: () => [{ id: 'mem1', kind: 'note', text: '昨天写了两份分析', at: T0 }],
    getBot: () => bot,
    listRuns: () => [],
    listBots: () => [bot],
  }
  const executor = new RunExecutor({} as never, svc as never, { historyMessages: 10, memoryPromptEntries: 8 })
  const prompt = (executor as unknown as { buildPrompt(run: unknown, bot: unknown, botId: string): string })
    .buildPrompt(run, bot, 'bot-1')
  assert.equal(prompt, (
    '[角色]\n你是一位严谨的工程师。\n你是 小董。Bot 提示词工程师\n\n'
    + '[可用技能]\n- dsh-bot-authoring\n\n'
    + '[本房间目标]\n[进行中] 把方案补完\n\n'
    + '[本房间记忆]\n以下是你在「这个房间」里做过的事。它们只属于这个房间，不要与其他房间的内容混在一起，也不要主动向用户提起别的房间。\n- 2026-10-22 00:00 昨天写了两份分析\n\n'
    + '[最近 10 条消息]\nuser: 继续\n小董: 好的\nuser: 还有超时部分\n\n'
    + '[本轮输入]\n把剩下的部分补完'
  ))
})
