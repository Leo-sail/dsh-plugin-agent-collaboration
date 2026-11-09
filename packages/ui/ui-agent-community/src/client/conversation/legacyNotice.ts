/**
 * Read-time copy migration for notices written by older builds.
 *
 * WHY THIS EXISTS. Ledger dispatch rows are stored text, so renaming a notice in the host (or
 * dropping internal plan ids) does not rewrite history: a user scrolling back still sees
 * 「【准入观察】observe 模式下已跳过」 or 「【预演】…命中交付门槛」. New rows already use the product
 * wording; this maps only the legacy prefixes/snippets so one transcript does not mix two
 * vocabularies. It is pure and idempotent: modern text passes through unchanged.
 */

const LEGACY_SUBSYSTEMS: Readonly<Record<string, string>> = {
  routing: '消息路由',
  steer: '运行中补充',
  schedules: '定时任务',
  outbox: '后台重试',
  prompt: '提示词组装',
  context: '上下文',
  memory: '记忆',
}

export function modernizeNoticeText(raw: string): string {
  let text = raw
  // Admission observe notice.
  text = text.replace(/【准入观察】/gu, '【未点名消息】')
  text = text.replace(/observe 模式下已跳过。/gu, '当前设置为「只看不回复」，这条消息没有触发回复。')
  // Speculation notices (old label → product label).
  text = text.replace(/【预演·观察】本可预演：/gu, '【提前准备·仅记录】这条消息可以提前准备：')
  text = text.replace(/【预演】/gu, '【提前准备】')
  text = text.replace(/命中交付门槛/gu, '草稿可以用')
  text = text.replace(/未达交付门槛/gu, '草稿没有达到可用标准')
  text = text.replace(/未发布/gu, '未发送')
  text = text.replace(/今日 (\d+)\/(\d+)）：/gu, '今天第 $1/$2 次）：')
  // Health notices: subsystem ids → product names, and the old "failure" phrasing.
  text = text.replace(/子系统「([^」]+)」连续 (\d+) 次失败/gu, (_match, name: string, count: string) =>
    `「${LEGACY_SUBSYSTEMS[name] ?? name}」连续 ${count} 次出现问题`)
  text = text.replace(/插件已按降级路径继续/gu, '插件已尽量继续工作')
  return text
}
