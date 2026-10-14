/**
 * Exact native strings, copied verbatim out of the shipped DSH locale bundle
 * (`@deepseek-ai/dsh-client-locale/lib/client.js`).
 *
 * The plugin renders its own UI in Chinese, so these are hard-coded rather than
 * routed through a dictionary: the point is that the visible text matches the
 * native conversation window character for character, including the literal
 * " ···" tail on the deep-diving label (one space + three U+00B7).
 *
 * EXCEPTION: the two sections at the very end (group proposal §5.4, queue
 * visibility §22.1) are PLUGIN-ONLY copy — there is no native surface to match.
 * They live here so the dialog, the banner and their harness assert against one
 * definition, and they are clearly marked so nothing above them is mistaken for
 * anything but a verbatim transcription.
 */

/** Cross-feature standard words (`zh` block of the locale bundle). */
export const T = {
  ok: '确定',
  cancel: '取消',
  close: '关闭',
  copy: '复制',
  copied: '复制成功',
} as const

/**
 * Token compaction, transcribed from the native `formatTokens` (chat:6273-6278):
 *
 *   const scaled = c => c >= 100 ? String(Math.round(c)) : String(Math.round(c*10)/10)
 *   value < 1e3 -> String(value)
 *   value < 1e6 -> t("number.thousand") = "{value}K"
 *   else        -> t("number.million")  = "{value}M"
 *
 * The `>= 100` branch matters: rounding to one decimal there would render
 * 123456 as "123.5K" where the native shows "123K", and 999949 as "999.9K"
 * where the native shows "1000K".
 */
export function compactNumber(value: number): string {
  const scaled = (c: number): string =>
    c >= 100 ? String(Math.round(c)) : String(Math.round(c * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

/** `chat.deepDiving` — screen-reader label, deliberately without a duration. */
export const DEEP_DIVING = '深度求索中'

/** `chat.deepDivingFor` — note the literal space + three middle dots. */
export const DEEP_DIVING_FOR = '深度求索中，用时 {duration} ···'

/** Reasoning row: live state while the turn streams. */
export const REASONING_LIVE = '思考中…'
/** Reasoning row: settled state, followed by the character count. */
export const REASONING_DONE = '已思考 {chars} 字'

/** Work-steps disclosure. */
export const WORK_LIVE = '正在工作…'
export const WORK_DONE = '已完成，{count} 次工具调用'

/** Message action bar labels — verbatim from the chat zh dictionary. */
export const ACTION_COPY = T.copy
export const ACTION_COPIED = T.copied
/**
 * `message.branch` = "在新对话中分支". The aria-label is ALWAYS this string,
 * even when branching is unavailable (chat:1171).
 */
export const ACTION_BRANCH = '在新对话中分支'
/** `message.branchUnavailable` — only the aria-describedby reason and tooltip. */
export const ACTION_BRANCH_UNAVAILABLE = '仅可从已完成轮次的最后一条消息分支'

/** Usage strings — `message.turnUsage.*` verbatim. */
export const USAGE_TITLE = '本轮用量'
export const USAGE_CONSUMED = '用量 {total}'
export const USAGE_COUNT = '{count} tok'
export const USAGE_INPUT = '未缓存输入'
export const USAGE_CACHE_READ = '缓存读取'
export const USAGE_CACHE_HIT = '缓存命中'
export const USAGE_CACHE_WRITE = '缓存写入'
export const USAGE_OUTPUT = '输出'
export const USAGE_MODEL = '提供方 / 模型'
export const USAGE_REASONING = '（其中推理 {tokens}）'

/**
 * Collapsed reasoning row title. Native uses `message.think` = "思考"; the
 * plugin labels it "思考过程" so the collapsed row reads as the thinking section
 * rather than a bare "思考" with a character count.
 */
export const THINK = '思考过程'

// ── turn process row label (dsh-client-ui-chat) ───────────────────────────────
//
// Ported verbatim from the `TurnProcessNodeView` label logic:
//
//   elapsedMs = Math.max(1000, end - start)          // never below one second
//   aborted → 已停止 · error → 处理失败 · timed → 已完成，用时 … · else 已完成
//
// The duration is a SEGMENT list, not a single string: numeric segments render in
// the code font with tabular figures, unit segments in the row's own font.
export const TURN_WORKED = '已完成'
export const TURN_TOOK = '已完成，用时 '
export const TURN_FAILED = '处理失败'
export const TURN_STOPPED = '已停止'
export const DURATION_HOUR_UNIT = '小时'
export const DURATION_MINUTE_UNIT = '分'
export const DURATION_SECOND_UNIT = '秒'

export interface DurationSegment {
  readonly text: string
  /** Numeric segments get the code font and tabular figures. */
  readonly numeric: boolean
}

/**
 * Split a duration into display segments, mirroring the native `formatRunDuration`
 * (`chat`): hours and minutes are omitted until they are non-zero, seconds always
 * render, and no unit is zero-padded.
 */
export function formatRunDuration(ms: number): DurationSegment[] {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  const parts: DurationSegment[] = []
  if (hours > 0) {
    parts.push({ text: String(hours), numeric: true }, { text: DURATION_HOUR_UNIT, numeric: false })
  }
  if (total >= 60) {
    parts.push({ text: String(minutes), numeric: true }, { text: DURATION_MINUTE_UNIT, numeric: false })
  }
  parts.push({ text: String(seconds), numeric: true }, { text: DURATION_SECOND_UNIT, numeric: false })
  return parts
}

/** The label a settled turn shows, matching the native reason switch. */
export function turnStatusLabel(reason: 'aborted' | 'error' | 'timed' | 'other'): string {
  if (reason === 'aborted') return TURN_STOPPED
  if (reason === 'error') return TURN_FAILED
  if (reason === 'timed') return TURN_TOOK
  return TURN_WORKED
}

/** Flat string form, used by tests and by callers that need plain text. */
export function formatTurnDuration(ms: number): string {
  return TURN_TOOK + formatRunDuration(ms).map(p => p.text).join('')
}

// ── group proposal dialog (§5.4) ──────────────────────────────────────────────
//
// Plugin-only chrome (there is no native surface to replicate), so the copy lives
// here instead of being inlined at each callsite: the dialog and its harness must
// assert against the same strings.

/** Dialog heading. The DM bot is asking whether to escalate into a group. */
export const PROPOSAL_TITLE = '是否建群协作？'
export const PROPOSAL_NAME_LABEL = '群名称'
export const PROPOSAL_MEMBERS_LABEL = '成员'
export const PROPOSAL_REASON_LABEL = '理由'
/** The two actions, verbatim from §5.4. */
export const PROPOSAL_CONFIRM = '建群协作'
export const PROPOSAL_DECLINE = '我自己做'
/** A confirm is a host round trip; say so rather than looking frozen. */
export const PROPOSAL_CONFIRMING = '正在建群…'
/** Badge for the bot that would lead the new group. */
export const PROPOSAL_LEADER = '负责人'
/** Members without a description keep their row, so the list cannot look broken. */
export const PROPOSAL_NO_DESCRIPTION = '（没有描述）'
export const PROPOSAL_NO_MEMBERS = '没有可用的成员，无法建群。'
/**
 * §5.4 timeout degradation: an unanswered proposal counts as a decline, and the
 * user has to be told the bot will finish on its own — otherwise ignoring the
 * dialog reads as "nothing happens", which is the failure mode this avoids.
 */
export const PROPOSAL_TIMEOUT_HINT = '未响应将自行完成：{seconds} 秒后按「我自己做」处理'
export function proposalTimeoutHint(seconds: number): string {
  return PROPOSAL_TIMEOUT_HINT.replace('{seconds}', String(Math.max(0, Math.ceil(seconds))))
}
/** Shown after the timeout fired, so the room explains why the bot kept working. */
export const PROPOSAL_TIMED_OUT_NOTICE = '建群提案长时间未响应，已按「我自己做」处理，Bot 会自行完成。'

// ── queue visibility (§22.1) ──────────────────────────────────────────────────
//
// The whole point of §22.1 is that "no answer yet" must not be a single state: a
// run parked by the LRU overflow has to read as queued, not as stuck.

/** Status pill. Never render a bare `queued` / "运行中" for a parked run. */
export const QUEUE_LABEL = '排队中'
/** Cause named by the host when the wait is for a free Agent slot (§22.1 LRU). */
export const QUEUE_WAIT_SLOT = '等待空闲 Agent 槽位'
/** Fallback cause: another run in this room is still going. */
export const QUEUE_WAIT_PREVIOUS = '等待前面的运行结束'
/** The sentence that separates "queued" from "stuck". */
export const QUEUE_NOTE = '尚未开始，有空位会自动继续'
