/**
 * Bot system-prompt regression suite.
 *
 * The Bot's prompt must describe the job a room Bot actually has, and must NOT describe the
 * role it inherits from the deployment preset (Agent Teams, hidden subagents, a deliverables
 * panel, a Web GUI, the DSH checkout). Measured on a real bot session before this work: all of
 * the latter were present, and none of the former.
 *
 * Usage: node tests/bot-prompt.mjs
 */
import { botPromptSections, installBotPrompt, SHADOWED_SECTIONS }
  from '../packages/core/agent-community/src/bot-prompt.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const sections = botPromptSections({ botName: '小艾', botDescription: '前端工程师', isLeader: true })
const all = sections.map(s => s.text).join('\n')
const named = (name) => sections.find(s => s.name === name)

// ── 1. 八段齐全，顺序稳定 ────────────────────────────────────────────────────
const EXPECTED = ['bots:identity', 'bots:room', 'bots:collaboration', 'bots:memory',
  'bots:boundary', 'bots:tools', 'bots:goal', 'bots:workflow']
check(sections.length === EXPECTED.length, `恰好 ${EXPECTED.length} 段`, `got=${sections.length}`)
check(EXPECTED.every((n, i) => sections[i].name === n), '段名与顺序固定', sections.map(s => s.name).join(','))
check(sections.every(s => Number.isFinite(s.order) && s.order >= 0 && s.order < 500),
  '全部落在 persona(0) 与 PLAN_POLICY(500) 之间')

// ── 2. 身份与房间规则 ────────────────────────────────────────────────────────
check(named('bots:identity').text.includes('小艾'), '身份段带上 Bot 名字')
check(named('bots:identity').text.includes('前端工程师'), '身份段带上用户填写的描述')
const empty = botPromptSections({ botName: 'X', botDescription: '   ', isLeader: false, leaderName: '小艾' })
check(!empty[0].text.includes('\n\n'), '描述为空时不留下空行')

check(named('bots:room').text.includes('自动发布'), 'room 段说明答复会自动发布')
check(named('bots:room').text.includes('不要再用 agent_community_post_message'), 'room 段禁止重复 post')
check(named('bots:room').text.includes('@all'), 'room 段写明 @all 会唤醒全员')
check(named('bots:room').text.includes('只有 leader 会被唤醒'), 'room 段写明没点名时只有 leader')

// ── 3. 协作 / 记忆 / 边界 ────────────────────────────────────────────────────
check(all.includes('invite_bot') && all.includes('finish_task') && all.includes('message_member'),
  'collaboration 段给出协作工具')
check(named('bots:collaboration').text.includes('不要自己新建群聊'), 'collaboration 段禁止自己建群')
check(named('bots:collaboration').text.includes('dispatch'), 'collaboration 段指向 dispatch')
check(named('bots:memory').text.includes('AGENTS.md'), 'memory 段指向全局记忆文件')
check(named('bots:memory').text.includes('绝不要把本房间的内容带到别的房间'), 'memory 段写明房间隔离')
check(named('bots:memory').text.includes('以实际运行与文件为准'), 'memory 段写明以实际运行为准')
check(named('bots:memory').text.includes('负例'), 'memory 段说明负例条目怎么用')
check(named('bots:boundary').text.includes('用户没有回答就不要自行开工'), 'boundary 段保留"没回答就别开工"')
check(named('bots:goal').text.includes('只属于这个房间'), 'goal 段写明目标只属于本房间')
check(named('bots:workflow').text.includes('而不是自己开子代理'), 'workflow 段禁止自己开子代理')

// ── 4. 不该出现的东西 ────────────────────────────────────────────────────────
for (const forbidden of [
  'spawn_teammate', 'subagent_fork', 'workflow tool',
  'exit_plan_mode', 'plan mode', 'deliverable', 'DeepSeek Harness implementation checkout',
  'Web GUI', '无需补充',
]) {
  check(!all.toLowerCase().includes(forbidden.toLowerCase()), `不得出现「${forbidden}」`)
}
// Agent Teams / subagent 只允许出现在「别用它们」的警告里，绝不能出现在指导性文字中。
// (实测：`list_agents` 让本群 leader 以为自己不是队长，所以这句警告是必须的。)
for (const term of ['Agent Teams', 'subagent', 'list_agents', 'send_message']) {
  const where = sections.filter(s => s.text.includes(term)).map(s => s.name)
  check(where.length === 0 || (where.length === 1 && where[0] === 'bots:tools'),
    `「${term}」只出现在警告段里`, where.join(','))
}

// ── 5. 遮蔽清单 ──────────────────────────────────────────────────────────────
const shadowNames = SHADOWED_SECTIONS.map(s => s.name)
for (const n of ['tool:goal', 'tool:workflow', 'ui:deliverable-file-references', 'harness:source', 'app:web-surface']) {
  check(shadowNames.includes(n), `遮蔽清单包含 ${n}`)
}
check(SHADOWED_SECTIONS.every(s => Number.isFinite(s.order)), '遮蔽项都带有限 order')

// ── 6. 安装行为：逐项容错 ────────────────────────────────────────────────────
function fakePrompt({ refuse = [] } = {}) {
  const registered = []
  return {
    registered,
    section(s) {
      // DSH throws when a section name is already registered in the same layer.
      if (refuse.includes(s.name) || registered.some(r => r.name === s.name)) {
        throw new Error(`prompt section "${s.name}" is already registered in this scope`)
      }
      registered.push(s)
    },
  }
}
const ctx = (sp) => ({ get: (n) => (n === 'systemPrompt' ? sp : undefined) })

const okPrompt = fakePrompt()
const r1 = installBotPrompt(ctx(okPrompt), { botName: 'A', botDescription: '' })
check(r1.applied.length === 8 && r1.skipped.length === 0, '正常情况：8 段全部安装', JSON.stringify(r1.applied.length))
check(r1.shadowed.length === SHADOWED_SECTIONS.length, '同时注册了全部遮蔽分节')
check(okPrompt.registered.filter(r => r.text === '').length === SHADOWED_SECTIONS.length,
  '遮蔽分节的文本是空串（装配时会跳过，不留空段）')

const partial = fakePrompt({ refuse: ['bots:memory'] })
const r2 = installBotPrompt(ctx(partial), { botName: 'A', botDescription: '' })
check(r2.skipped.includes('bots:memory') && r2.applied.length === 7,
  '一段失败只损失那一节，其余照常安装', `applied=${r2.applied.length} skipped=${r2.skipped.join(',')}`)

const none = installBotPrompt({}, { botName: 'A', botDescription: '' })
check(none.applied.length === 0 && none.skipped.length === 1, '没有 systemPrompt 服务时不抛异常')


// ── 7. 谁说了算：必须明确告诉每个 bot ─────────────────────────────────────────
//
// Measured on a live group (2026-10-15): the user asked to remove a member, the leader was that
// very bot, and it answered "我自己做不到，只有队长能执行" — nothing in its prompt said it WAS the
// 队长. It then consulted `list_agents` (an Agent Teams tool, unrelated to the room) and concluded
// from that roster that it was not in charge.
const asLeader = botPromptSections({ botName: '小艾', botDescription: '', isLeader: true })
const leaderText = asLeader.find(s => s.name === 'bots:collaboration').text
check(leaderText.includes('你是本群的 leader'), 'leader 知道自己说了算')
check(leaderText.includes('remove_bot') && leaderText.includes('即使要移除的是你自己'),
  'leader 知道能用 remove_bot（含移除自己）')
check(leaderText.includes('dispatch') && leaderText.includes('finish_task'), 'leader 知道分派与收尾')
const asMember = botPromptSections({ botName: '小毕', botDescription: '', isLeader: false, leaderName: '小艾' })
const memberText = asMember.find(s => s.name === 'bots:collaboration').text
check(memberText.includes('本群的 leader（队长）是「小艾」'), '成员知道队长是谁', memberText.slice(0, 40))
check(!memberText.includes('你是本群的 leader'), '成员不会误以为自己是队长')
check(memberText.includes('message_member'), '成员知道做完要汇报')

// Agent Teams 的工具会误导（实测：list_agents 让 leader 以为自己不是）
const toolsText = asLeader.find(s => s.name === 'bots:tools').text
check(toolsText.includes('list_agents') && toolsText.includes('Agent Teams'),
  '明确警告不要用 Agent Teams 工具判断房间成员')

console.log(`\n[bot-prompt] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
