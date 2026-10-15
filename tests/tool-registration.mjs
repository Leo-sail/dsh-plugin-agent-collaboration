/**
 * Collaboration-tool registration suite — the collision that took the host down.
 *
 * Measured on a real install (2026-10-15): the plugin registered a tool named `get_goal`, but the
 * deployment preset had ALREADY mounted `get_goal` in the same agent scope, so `tools.register`
 * threw:
 *
 *   tool "get_goal" is already registered (for a per-agent variant, register through that
 *   agent's `agent.ctx` instead)
 *
 * The registration helper had no per-tool guard, so the throw happened while the tools were being
 * registered in order — every tool after it (`agent_community_goal`, `agent_community_dispatch`,
 * `agent_community_recall`) never existed, and the host reported the plugin as failed. This suite
 * locks down both halves of the fix: the room's own tools are never named after something the
 * deployment owns, and a collision costs exactly one tool.
 *
 * Usage: node tests/tool-registration.mjs
 */
import { registerCollaborationTools }
  from '../packages/core/agent-community/src/collaboration-tools.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** A tools registry with DSH's rule: a name already present in the scope is refused. */
function makeTools(taken = []) {
  const names = new Set(taken)
  const defs = new Map()
  return {
    names,
    defs,
    register(definition) {
      if (names.has(definition.name)) {
        throw new Error(`tool "${definition.name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`)
      }
      names.add(definition.name)
      defs.set(definition.name, definition)
    },
  }
}

/** The minimum a tool call needs: an owning agent session inside a group room. */
const exec = { agent: { session: { id: 'ac:room1:botA' } } }
function makeDeps(overrides = {}) {
  return {
    ownerOf: () => ({ roomId: 'room1', botId: 'botA' }),
    roomKind: () => 'group',
    leaderOf: () => 'botA',
    memberIds: () => ['botA', 'botB'],
    botName: (id) => (id === 'botA' ? '小艾' : '小毕'),
    proposeGroup: async () => undefined,
    inviteBot: async () => ({ ok: true }),
    removeBot: async () => ({ ok: true }),
    postMessage: () => ({ ok: true }),
    assignTask: () => ({ ok: true }),
    finishTask: () => undefined,
    roomGoal: () => ({ text: '做一版新设计', status: 'active', updatedAt: '2026-10-15T10:00:00.000Z' }),
    setRoomGoal: async () => ({ ok: true }),
    recall: async () => ({ hits: [], learned: [], path: '/tmp/x.md' }),
    dispatch: () => ({ ok: true, queued: [], refused: [] }),
    ...overrides,
  }
}

// ── 1. 干净环境：全部注册，没有失败 ──────────────────────────────────────────
const clean = makeTools()
const failedClean = registerCollaborationTools({ tools: clean }, makeDeps())
check(failedClean.length === 0, '没有重名时全部注册成功', JSON.stringify(failedClean))
check(clean.names.size > 8, '注册了协作工具集', `${clean.names.size} 个`)

// ── 2. 不再抢宿主的名字（这就是那次事故）────────────────────────────────────
check(!clean.names.has('get_goal'),
  '不再注册 get_goal（它由部署的 preset 按 agent 注册，抢名字会抛错）')
check(clean.names.has('agent_community_goal'), '房间目标走 agent_community_goal')
check(clean.names.has('agent_community_dispatch') && clean.names.has('agent_community_recall'),
  'dispatch / recall 都在（旧实现里它们排在冲突项之后，会一起消失）')

// ── 3. 一个名字被占 → 只损失那一个 ───────────────────────────────────────────
const taken = makeTools(['assign_task', 'ask_user_question'])
const failed = registerCollaborationTools({ tools: taken }, makeDeps())
check(failed.length === 2, '两个被占的名字被如实记录', JSON.stringify(failed.map(f => f.name)))
check(failed.every(f => f.reason.includes('already registered')), '记录里带上宿主给的原因')
check(taken.names.has('agent_community_goal') && taken.names.has('agent_community_dispatch')
  && taken.names.has('agent_community_recall'), '冲突项之后的工具照常注册（旧实现在这里断掉）')
check(taken.names.has('finish_task') && taken.names.has('invite_bot'), '其它工具一个不少')

// ── 4. 没有 tools 服务的极端情况 ─────────────────────────────────────────────
const noTools = registerCollaborationTools({}, makeDeps())
check(noTools.length === 1 && noTools[0].name === '(all)', '没有 tools 服务 → 明确报告，不静默')

// ── 5. 读目标：agent_community_goal 的 get 动作 ──────────────────────────────
const goalDef = clean.defs.get('agent_community_goal')
const got = await goalDef.execute({ action: 'get' }, exec)
const gotText = String(got.message ?? got.text ?? '')
check(gotText.includes('做一版新设计'), 'action=get 读到本房间目标', gotText.slice(0, 60))
check(gotText.includes('进行中'), '读目标带上状态')
check(typeof got.goal?.text === 'string', '返回值里带结构化目标（模型/界面都能用）')
const none = await registerCollaborationTools({ tools: makeTools() }, makeDeps({ roomGoal: () => undefined }))
check(none.length === 0, '没有目标时读目标也不报错（返回"未设定"）')

console.log(`\n[tool-registration] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
