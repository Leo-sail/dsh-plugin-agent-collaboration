/**
 * Speculative execution (S2-4) — an opt-in experiment: prepare work quietly, deliver only if it
 * actually would have helped.
 *
 * WHY THIS EXISTS. The Article's speculation section describes a background worker that starts
 * acting BEFORE the user asks ("the draft is ready when you get there"), delivers when the result
 * is useful, and throws it away otherwise. In a room that already runs a bot on every message this
 * must be strictly opt-in and strictly bounded: the obvious failure mode is paying twice for the
 * same answer.
 *
 * WHAT THIS MODULE IS. The deterministic policy only:
 *   · eligibility — room mode, non-explicit message, a task-shaped request, and budget remaining;
 *   · a daily HARD budget per room (in-memory today; a restart resets it — an experiment is allowed
 *     to lose its counter, not to spend without bound);
 *   · a delivery gate — a speculative result only "counts" when it produced deliverables or a
 *     clear conclusion; otherwise the run is recorded as a miss, never published;
 *   · the prompt and the metadata-only ledger lines (the run's prose never enters the room).
 *
 * MODES. `off` (absent) = nothing happens. `observe` = record "this WOULD have been speculatable"
 * (and whether the room is over budget) without starting a run or spending tokens. `on` = start a
 * hidden internal run for the room's leader, record ONLY metadata (hit/miss, size, budget) — the
 * output is not delivered and not shown to the user in v1.
 *
 * @module
 */

import type { SpeculationMode } from './types.ts'

/** Default/maximum speculative starts per room per local day (review request: 100). */
export const DEFAULT_SPECULATION_DAILY_LIMIT = 100
export const MAX_SPECULATION_DAILY_LIMIT = 100
/** A speculative output longer than this is a red flag, not a result; gate rejects it. */
export const MAX_SPECULATION_OUTPUT_CHARS = 6_000

/** One room's normalized setting. `off` and absent are the same behaviour. */
export interface SpeculationSetting {
  readonly mode: SpeculationMode
  readonly dailyLimit: number
}

/** Normalize a stored/requested setting; unknown modes are rejected at the boundary. */
export function normalizeSpeculation(value: unknown): SpeculationSetting {
  if (value === null || typeof value !== 'object') {
    return { mode: 'off', dailyLimit: DEFAULT_SPECULATION_DAILY_LIMIT }
  }
  const view = value as { mode?: unknown; dailyLimit?: unknown }
  const mode = view.mode
  if (mode !== 'off' && mode !== 'observe' && mode !== 'on') {
    throw new Error('「提前准备」的模式无效，请选择关闭 / 仅记录 / 自动。')
  }
  const rawLimit = view.dailyLimit
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit >= 0
    ? Math.min(MAX_SPECULATION_DAILY_LIMIT, Math.floor(rawLimit))
    : DEFAULT_SPECULATION_DAILY_LIMIT
  return { mode, dailyLimit: limit }
}

/** A message is task-shaped when it asks for something concrete; a greeting never qualifies. */
const TASK_INTENT = /(帮我|帮忙|请|麻烦|写|做|查|整理|生成|分析|对比|总结|汇总|修复|实现|设计|计算|翻译|部署|测试|方案|报告|代码|接口|封面)/u

/** Pure eligibility: mode, explicit addressee, task intent, and remaining budget. */
export function speculationEligible(input: {
  readonly setting: SpeculationSetting
  /** `true` when the message named its target explicitly (an @mention / written name / @all / DM). */
  readonly explicitAddressee: boolean
  readonly text: string
  readonly remaining: number
  /**
   * P0 fix (2026-11-09): a leader-triage room already gives this exact message to the leader as a
   * visible turn. A second hidden rehearsal would duplicate that model call, so triage and
   * speculation are mutually exclusive for one message.
   */
  readonly leaderTriage?: boolean | undefined
}): { readonly eligible: boolean; readonly reason: string } {
  if (input.setting.mode === 'off') return { eligible: false, reason: '房间未开启提前准备' }
  if (input.leaderTriage === true) {
    return { eligible: false, reason: '这条消息已交给群主判断，不需要重复提前准备' }
  }
  if (input.explicitAddressee) return { eligible: false, reason: '消息已明确点名，不需要预演' }
  if (input.remaining <= 0) return { eligible: false, reason: '今日预演预算已用完' }
  const text = input.text.trim()
  if (text === '') return { eligible: false, reason: '消息为空' }
  if (!TASK_INTENT.test(text)) return { eligible: false, reason: '不像一个任务请求' }
  return { eligible: true, reason: '未点名且像任务请求' }
}

/**
 * The delivery gate: did the speculative run produce something worth having?
 *
 * Never publishes in v1 — it only decides whether the experiment records a hit. Deliverables are
 * the strongest signal; otherwise a completed run with a conclusion-like body counts, and anything
 * else is a miss (a chatty reply is not a prepared result).
 */
export function deliveryGate(input: {
  readonly status: 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'queued' | 'running'
  readonly text: string
  readonly deliverableCount: number
}): { readonly deliver: boolean; readonly reason: string } {
  if (input.status !== 'completed') return { deliver: false, reason: '准备过程中断了' }
  if (input.deliverableCount > 0) return { deliver: true, reason: '已经生成了文件' }
  const text = input.text.trim()
  if (text === '') return { deliver: false, reason: '没有产出内容' }
  if ([...text].length > MAX_SPECULATION_OUTPUT_CHARS) return { deliver: false, reason: '内容过长，不像可以直接用的草稿' }
  if ([...text].length < 12) return { deliver: false, reason: '内容太短，不像完整结果' }
  if (!/(结论|答案|结果|建议|方案|总结|已完成)/u.test(text)) return { deliver: false, reason: '没有形成明确结果' }
  return { deliver: true, reason: '形成了明确结果' }
}

/** The prompt a speculative run gets. It must know the output is not the user's answer. */
export function speculationPrompt(userText: string): string {
  const text = [...userText.trim()].slice(0, 1_500).join('')
  return `[预演·不会直接发给用户]\n用户刚在房间里说了：「${text}」\n`
    + '如果你判断用户真正希望有人先准备一份可用的结果，请现在做出来（能产文件就产文件，不能就给结论）。\n'
    + '这份输出不会发布到房间，也不会被当成用户已收到的答复；请只给出你自己认为最有用的结果，不要寒暄、不要问问题。\n'
    + '这是预演：不要调用任何会改变房间状态的工具（dispatch / assign_task / finish_task / message_member / deliver / handoff / remember / goal / progress / request_status）。'
}

/** Local calendar day bucket used by the in-memory budget (timezone-aware, not UTC). */
export function dayBucket(epochMs: number): number {
  const offset = new Date(epochMs).getTimezoneOffset() * 60_000
  return Math.floor((epochMs - offset) / 86_400_000)
}

/** Consume one speculative slot for the room, returning the new used count. */
export function consumeBudget(
  state: Map<string, { readonly day: number; readonly used: number }>,
  roomId: string,
  now: number,
  limit: number,
): number {
  const day = dayBucket(now)
  const current = state.get(roomId)
  const used = current !== undefined && current.day === day ? current.used + 1 : 1
  state.set(roomId, { day, used })
  return Math.min(used, Math.max(0, limit))
}

/** Remaining slots for the room on this day (0 when unknown/over budget). */
export function budgetRemaining(
  state: Map<string, { readonly day: number; readonly used: number }>,
  roomId: string,
  now: number,
  limit: number,
): number {
  const current = state.get(roomId)
  const used = current !== undefined && current.day === dayBucket(now) ? current.used : 0
  return Math.max(0, limit - used)
}

/** A metadata-only ledger line: what happened, never the model's prose. */
export function speculationLedgerLine(input: {
  readonly stage: 'observed' | 'started' | 'hit' | 'miss'
  readonly reason: string
  readonly chars?: number | undefined
  readonly used?: number | undefined
  readonly limit?: number | undefined
}): string {
  if (input.stage === 'observed') return `【提前准备】这条消息可以提前准备（仅记录，未开始）：${input.reason}`
  if (input.stage === 'started') {
    return `【提前准备】已开始（今天第 ${input.used ?? 0}/${input.limit ?? 0} 次）：${input.reason}`
  }
  if (input.stage === 'hit') {
    return `【提前准备】已完成，草稿可以用（${input.chars ?? 0} 字，未发送）：${input.reason}`
  }
  return `【提前准备】已完成，但草稿没有达到可用标准（${input.chars ?? 0} 字，已丢弃）：${input.reason}`
}
