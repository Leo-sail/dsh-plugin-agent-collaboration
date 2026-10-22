/**
 * Unit tests for the S7 proposal dialog rules (pure, no DOM / no host).
 *
 * Covered:
 *   · the selection a dialog opens with (suggested members + suggested leader);
 *   · add / remove, including "removing the leader re-points it at the first remaining";
 *   · leader changes only among selected members (and no-op calls keep the same object);
 *   · validation: at least two members, leader must be one of them;
 *   · the "should this message even be judged for a group?" gate.
 *
 * Run with: node --test tests/proposal-edit.test.ts  (Node strips the types)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_PROPOSAL_MEMBERS,
  initialProposalSelection,
  setProposalLeader,
  sortProposalBots,
  toggleProposalMember,
  validateProposalSelection,
} from '../packages/ui/ui-agent-community/src/client/conversation/proposalEdit.ts'
import type { ProposalSelection } from '../packages/ui/ui-agent-community/src/client/conversation/proposalEdit.ts'
import {
  GROUP_GATE_MIN_CHARS,
  shouldConsiderGroup,
} from '../packages/ui/ui-agent-community/src/client/community/proposalGate.ts'

// ── directory order ─────────────────────────────────────────────────────────

test('the directory is listed by name, without mutating the input', () => {
  const bots = [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }, { id: 'c', name: 'Charlie' }]
  const sorted = sortProposalBots(bots)
  assert.deepEqual(sorted.map(bot => bot.name), ['Alpha', 'Beta', 'Charlie'])
  assert.deepEqual(bots.map(bot => bot.id), ['b', 'a', 'c'])
})

// ── initial selection ──────────────────────────────────────────────────────

test('the dialog opens with every suggested member selected and the suggested leader', () => {
  const selection = initialProposalSelection({
    memberIds: ['a', 'b', 'c'],
    suggestedLeaderId: 'b',
  })
  assert.deepEqual(selection.memberIds, ['a', 'b', 'c'])
  assert.equal(selection.leaderId, 'b')
})

test('a suggested leader outside the suggested members falls back to the first selected', () => {
  const selection = initialProposalSelection({ memberIds: ['a', 'b'], suggestedLeaderId: 'z' })
  assert.equal(selection.leaderId, 'a')
})

test('no suggested members means an empty selection with no leader', () => {
  const selection = initialProposalSelection({ memberIds: [] })
  assert.deepEqual(selection.memberIds, [])
  assert.equal(selection.leaderId, undefined)
})

test('duplicates and empty ids from the host are dropped', () => {
  const selection = initialProposalSelection({ memberIds: ['a', '', 'a', 'b'] })
  assert.deepEqual(selection.memberIds, ['a', 'b'])
})

// ── toggling members ───────────────────────────────────────────────────────

test('ticking a bot appends it and keeps the leader', () => {
  const state: ProposalSelection = { memberIds: ['a'], leaderId: 'a' }
  const next = toggleProposalMember(state, 'b')
  assert.deepEqual(next.memberIds, ['a', 'b'])
  assert.equal(next.leaderId, 'a')
})

test('unticking a non-leader keeps the leader', () => {
  const state: ProposalSelection = { memberIds: ['a', 'b', 'c'], leaderId: 'b' }
  const next = toggleProposalMember(state, 'a')
  assert.deepEqual(next.memberIds, ['b', 'c'])
  assert.equal(next.leaderId, 'b')
})

test('unticking the leader re-points it at the first remaining member', () => {
  const state: ProposalSelection = { memberIds: ['a', 'b', 'c'], leaderId: 'b' }
  const next = toggleProposalMember(state, 'b')
  assert.deepEqual(next.memberIds, ['a', 'c'])
  assert.equal(next.leaderId, 'a')
})

test('unticking the last member leaves no leader (validation blocks the confirm)', () => {
  const state: ProposalSelection = { memberIds: ['a'], leaderId: 'a' }
  const next = toggleProposalMember(state, 'a')
  assert.deepEqual(next.memberIds, [])
  assert.equal(next.leaderId, undefined)
  assert.equal(validateProposalSelection(next).ok, false)
})

// ── leader selection ───────────────────────────────────────────────────────

test('a selected member can become the leader', () => {
  const state: ProposalSelection = { memberIds: ['a', 'b'], leaderId: 'a' }
  const next = setProposalLeader(state, 'b', state.memberIds)
  assert.equal(next.leaderId, 'b')
  assert.deepEqual(next.memberIds, ['a', 'b'])
})

test('an unselected bot cannot become the leader; a no-op keeps the same state object', () => {
  const state: ProposalSelection = { memberIds: ['a', 'b'], leaderId: 'a' }
  assert.equal(setProposalLeader(state, 'z', state.memberIds), state, 'not a member')
  assert.equal(setProposalLeader(state, 'b', ['a']), state, 'not in the caller roster')
  assert.equal(setProposalLeader(state, 'a', state.memberIds), state, 'already leader')
})

// ── validation ─────────────────────────────────────────────────────────────

test('confirmation needs at least two members', () => {
  assert.equal(MIN_PROPOSAL_MEMBERS, 2)
  const empty = validateProposalSelection({ memberIds: [] })
  assert.equal(empty.ok, false)
  assert.match(empty.reason ?? '', /至少选择 2 个成员/)

  const one = validateProposalSelection({ memberIds: ['a'], leaderId: 'a' })
  assert.equal(one.ok, false)
  assert.match(one.reason ?? '', /至少选择 2 个成员/)

  const duplicated = validateProposalSelection({ memberIds: ['a', 'a'], leaderId: 'a' })
  assert.equal(duplicated.ok, false, 'one bot twice is still one member')
})

test('confirmation needs a leader who is one of the selected members', () => {
  const missing = validateProposalSelection({ memberIds: ['a', 'b'] })
  assert.equal(missing.ok, false)
  assert.match(missing.reason ?? '', /负责人/)

  const outsider = validateProposalSelection({ memberIds: ['a', 'b'], leaderId: 'z' })
  assert.equal(outsider.ok, false)

  const valid = validateProposalSelection({ memberIds: ['a', 'b'], leaderId: 'b' })
  assert.equal(valid.ok, true)
  assert.equal(valid.reason, undefined)
})

// ── the explicit-trigger gate ─────────────────────────────────────────────

test('short greetings and single asks never spend a proposal call', () => {
  for (const text of [
    '',
    '   ',
    '你好',
    '谢谢！',
    '帮我查下今天的天气',
    '把这句话润色一下',
    '帮我写一份报告', // one deliverable, no collaboration signal
  ]) {
    assert.equal(shouldConsiderGroup(text), false, `expected gate to skip: ${JSON.stringify(text)}`)
  }
})

test('collaboration words open the gate', () => {
  for (const text of [
    '帮我分别写一份报告和一份方案',
    '我们分工把这个项目推进一下',
    '同时整理一下这几个文件',
    '把大家的结论汇总成一份材料',
    '这个任务需要多个 bot 参与',
  ]) {
    assert.equal(shouldConsiderGroup(text), true, `expected gate to pass: ${text}`)
  }
})

test('two distinct deliverable nouns open the gate', () => {
  assert.equal(shouldConsiderGroup('给我一份报告和一个图表'), true)
  assert.equal(shouldConsiderGroup('要代码也要配套文案'), true)
})

test('a long task brief opens the gate even without keywords', () => {
  const unit = '请帮我看看这段文字有没有需要调整的地方，'
  const long = unit.repeat(Math.ceil(GROUP_GATE_MIN_CHARS / unit.length) + 1)
  assert.ok([...long].length >= GROUP_GATE_MIN_CHARS)
  assert.equal(shouldConsiderGroup(long), true)
})

test('a medium single-sentence message without any signal stays closed', () => {
  const text = '你能帮我确认一下上周的工作安排是否还有需要补充的内容吗，谢谢'
  assert.ok([...text].length >= 30)
  assert.ok([...text].length < GROUP_GATE_MIN_CHARS)
  assert.equal(shouldConsiderGroup(text), false)
})
