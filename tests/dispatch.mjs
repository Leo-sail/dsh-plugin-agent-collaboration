/**
 * Dispatch regression suite — 「workflow 应该是调用其他 Bot，而不是起子 agent」.
 *
 * What this locks down: dispatch only ever queues work for EXISTING MEMBERS of the room the
 * caller is in, only the leader may call it, one turn involves at most four workers, a bot may
 * not hand work to itself, and each failure is reported per task instead of cancelling the
 * whole call. The report the leader is woken with is asserted too — it must name who failed and
 * who has not come back, because a silent summary is how a failed delegation goes unnoticed.
 *
 * Usage: node tests/dispatch.mjs
 */
import { planDispatch, handoffReport, MAX_DISPATCH_TASKS }
  from '../packages/core/agent-community/src/dispatch.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const ROSTER = [
  { id: 'botA', name: '小艾' },
  { id: 'botB', name: '小毕' },
  { id: 'botC', name: '小西' },
]
const base = {
  roomKind: 'group',
  callerId: 'botA',
  leaderId: 'botA',
  memberIds: ['botA', 'botB', 'botC'],
  roster: ROSTER,
}

// ── 1. 正常派工 ──────────────────────────────────────────────────────────────
const ok = planDispatch({ ...base, tasks: [{ bot: '小毕', task: '画分镜' }, { bot: 'botC', task: '写测试' }] })
check(ok.accepted.length === 2 && ok.refusal === undefined, '按名字/ID 都能解析，两件活都派出去',
  JSON.stringify(ok.accepted.map(a => a.botId)))
check(ok.accepted[0].botId === 'botB' && ok.accepted[1].botId === 'botC', '保持入参顺序')

// ── 2. 权限与房间类型 ────────────────────────────────────────────────────────
const notLeader = planDispatch({ ...base, callerId: 'botB', tasks: [{ bot: '小西', task: 'x' }] })
check(notLeader.accepted.length === 0 && notLeader.refusal.includes('leader'), '非 leader 派工被拒（成员只能汇报）')
const inDm = planDispatch({ ...base, roomKind: 'direct', tasks: [{ bot: '小毕', task: 'x' }] })
check(inDm.refusal.includes('单聊'), '单聊里拒绝派工，并提示先 propose_group')
const noLeader = planDispatch({ ...base, leaderId: undefined, tasks: [{ bot: '小毕', task: 'x' }] })
check(noLeader.accepted.length === 0, '没有 leader 的房间不允许派工（没有协调者）')

// ── 3. 上限与自派 ────────────────────────────────────────────────────────────
// Five DISTINCT members, so the cap (not the duplicate rule) is what refuses the fifth.
const BIG = [...ROSTER, { id: 'botD', name: '小丁' }, { id: 'botE', name: '小戊' }]
const many = planDispatch({
  ...base,
  memberIds: BIG.map(m => m.id),
  roster: BIG,
  tasks: [
    { bot: '小毕', task: '1' }, { bot: '小西', task: '2' }, { bot: '小丁', task: '3' },
    { bot: '小戊', task: '4' }, { bot: '小艾', task: '5' },
  ],
})
check(MAX_DISPATCH_TASKS === 4, `一次最多 ${MAX_DISPATCH_TASKS} 件（与方案一致）`)
check(many.accepted.length <= MAX_DISPATCH_TASKS, '派出的不超过上限', String(many.accepted.length))
check(many.refused.some(r => r.reason.includes('最多派')), '超出的部分明确说明是上限',
  JSON.stringify(many.refused))
const dup = planDispatch({ ...base, tasks: [{ bot: '小毕', task: '1' }, { bot: '小毕', task: '2' }] })
check(dup.refused.some(r => r.reason.includes('已经给它派过')), '同一成员一次只派一件')
const self = planDispatch({ ...base, tasks: [{ bot: '小艾', task: '1' }] })
check(self.refused.some(r => r.bot === '小艾'), '不能把活派给自己')

// ── 4. 逐条失败，不整单取消 ──────────────────────────────────────────────────
const mixed = planDispatch({
  ...base,
  tasks: [
    { bot: '小毕', task: '画分镜' },
    { bot: '路人甲', task: '做点什么' },
    { bot: '小西', task: '   ' },
    { bot: '小艾', task: '自己来' },
  ],
})
check(mixed.accepted.length === 1 && mixed.accepted[0].botId === 'botB',
  '一条坏名字不影响其它：好的照派', JSON.stringify(mixed.accepted.map(a => a.botId)))
check(mixed.refused.find(r => r.bot === '路人甲').reason.includes('不是本群成员'), '非成员说明原因')
check(mixed.refused.find(r => r.bot === '小西').reason.includes('为空'), '空任务说明原因')

// ── 5. 全失败与空入参 ────────────────────────────────────────────────────────
const allBad = planDispatch({ ...base, tasks: [{ bot: '路人甲', task: 'x' }] })
check(allBad.accepted.length === 0 && typeof allBad.refusal === 'string', '全部失败时给出整体说明')
check(planDispatch({ ...base, tasks: [] }).refusal.length > 0, '空 tasks 被拒')

// ── 6. 领导人被唤醒时看到的回报 ──────────────────────────────────────────────
const report = handoffReport({
  perBot: [
    { name: '小毕', ok: true, text: '分镜画完了，见 assets/storyboard.png' },
    { name: '小西', ok: false, text: '回归环境起不来' },
    { name: '小艾', ok: true, text: '   ' },
  ],
  stillRunning: ['小西'],
})
check(report.includes('小毕 完成'), '回报写明谁完成')
check(report.includes('小西 失败'), '回报写明谁失败（不静默吞）')
check(report.includes('没有文字回报'), '空回报也有占位说明')
check(report.includes('还没回来：小西'), '未归队的人被点名')
check(report.includes('finish_task'), '告诉 leader 接下来可以做什么')

console.log(`\n[dispatch] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
