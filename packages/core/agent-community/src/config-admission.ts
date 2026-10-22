/**
 * Config / prompt-change admission (OP-21): one place that says which plugin settings are legal.
 *
 * WHY. Config is the one surface a user (or a well-meaning future caller) can use to turn a
 * working community into a broken one: `maxConcurrentRuns: 0` never runs a bot, `runLeaseMs: 300`
 * retries every run within a second, `maxMessages: 1` erases the transcript on every turn, and a
 * typo (`maxBots: '8'`) silently falls back to defaults. The schemastery schema protects the
 * RPC/`Config` boundary, but nothing states the intended product bounds, and nothing reports
 * ignored keys.
 *
 * This module is ADMISSION, not construction: it never mutates the service config. The service
 * keeps its existing `?? default` reads (so behaviour is unchanged), and a caller that wants to
 * validate before applying a change calls {@link admitConfig} / {@link admitConfigOrThrow}.
 *
 * Unknown keys are WARNINGS, not failures: forward-compatibility matters more than strictness
 * (an older plugin must still load a config written for a newer one), but a swallowed typo is a
 * real defect, so the caller gets the list.
 *
 * @module
 */

/** One bounded numeric setting, or one non-empty string setting. */
export interface ConfigAdmissionRule {
  /** Config field name as the service reads it. */
  readonly key: string
  readonly kind: 'integer' | 'string'
  /** Inclusive lower bound (integers only). */
  readonly min?: number | undefined
  /** Inclusive upper bound (integers only). */
  readonly max?: number | undefined
  /** One line stating the product intent, used in issue messages. */
  readonly intent: string
}

/**
 * The admitted settings and their intended bounds.
 *
 * The lower bounds are the "still a working community" floor; the upper bounds are the point
 * where a single room or timer stops being able to starve the host. `runLeaseMs` is expressed in
 * milliseconds (10 s–300 s): below 10 s a lease expires while a model call is still running,
 * above 300 s a crashed run holds its slot for five minutes.
 */
export const CONFIG_ADMISSION_RULES: readonly ConfigAdmissionRule[] = [
  { key: 'maxBots', kind: 'integer', min: 1, max: 64, intent: '至少 1 个 bot 才能工作，64 个以上不必要' },
  { key: 'maxRooms', kind: 'integer', min: 1, max: 128, intent: '至少 1 个房间，128 个以上没有实际用途' },
  { key: 'maxMessages', kind: 'integer', min: 100, max: 200_000, intent: '保留至少 100 条历史，避免每轮清空记录' },
  { key: 'maxConcurrentRuns', kind: 'integer', min: 1, max: 16, intent: '0 会让任何 bot 都不运行，16 以上会压垮宿主' },
  { key: 'runLeaseMs', kind: 'integer', min: 10_000, max: 300_000, intent: '10s–300s：低于 10s 会在模型调用中途丢租约' },
  { key: 'historyMessagesInPrompt', kind: 'integer', min: 0, max: 50, intent: '0–50 条：再多只会挤占提示词预算' },
  { key: 'memoryEntriesPerRoom', kind: 'integer', min: 0, max: 50, intent: '0–50 条：房间记忆超过 50 条就该分层了' },
  { key: 'memoryPromptEntries', kind: 'integer', min: 0, max: 20, intent: '0–20 条：注入提示词的记忆条数上限' },
  { key: 'botAgentPreset', kind: 'string', intent: '必须是非空字符串（空值会让 bot 拿不到 preset）' },
]

export interface ConfigAdmissionIssue {
  readonly key: string
  readonly reason: string
}

export type ConfigAdmission =
  | {
    readonly ok: true
    /** Only admitted keys, unchanged values, insertion order irrelevant. */
    readonly config: Readonly<Record<string, unknown>>
    /** Unknown keys that were ignored (and therefore NOT admitted), one line each. */
    readonly warnings: readonly string[]
  }
  | {
    readonly ok: false
    readonly issues: readonly ConfigAdmissionIssue[]
    readonly warnings: readonly string[]
  }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkRule(rule: ConfigAdmissionRule, value: unknown): ConfigAdmissionIssue | undefined {
  if (rule.kind === 'string') {
    if (typeof value !== 'string' || value.trim() === '') {
      return { key: rule.key, reason: `必须是${rule.intent}` }
    }
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { key: rule.key, reason: `必须是整数（${rule.intent}）` }
  }
  if (rule.min !== undefined && value < rule.min) {
    return { key: rule.key, reason: `不能小于 ${rule.min}（${rule.intent}）` }
  }
  if (rule.max !== undefined && value > rule.max) {
    return { key: rule.key, reason: `不能大于 ${rule.max}（${rule.intent}）` }
  }
  return undefined
}

/**
 * Validate a candidate config.
 *
 * `undefined` values count as "not provided" (the service's `?? default` handles them), not as
 * invalid: callers spread optional fields into config objects all the time. All issues are
 * collected, so a caller fixes one batch instead of one field per attempt.
 */
export function admitConfig(input: Record<string, unknown>): ConfigAdmission {
  const warnings: string[] = []
  const config: Record<string, unknown> = {}
  const issues: ConfigAdmissionIssue[] = []
  if (!isPlainObject(input)) {
    return {
      ok: false,
      issues: [{ key: '(config)', reason: '配置必须是一个对象' }],
      warnings,
    }
  }
  const known = new Set(CONFIG_ADMISSION_RULES.map(rule => rule.key))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) warnings.push(`未知配置项「${key}」已忽略`)
  }
  for (const rule of CONFIG_ADMISSION_RULES) {
    if (!Object.prototype.hasOwnProperty.call(input, rule.key)) continue
    const value = input[rule.key]
    if (value === undefined) continue
    const issue = checkRule(rule, value)
    if (issue !== undefined) {
      issues.push(issue)
      continue
    }
    config[rule.key] = value
  }
  if (issues.length > 0) return { ok: false, issues, warnings }
  return { ok: true, config, warnings }
}

/**
 * Admission that fails loudly — for callers that MUST not apply an invalid config (a future
 * settings-write path, tests, migrations). The service constructor deliberately does not call
 * this: existing configs in the wild may predate these bounds, and rejecting them on load would
 * turn a warning into an outage.
 */
export function admitConfigOrThrow(input: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const admission = admitConfig(input)
  if (!admission.ok) {
    const detail = admission.issues.map(issue => `${issue.key}: ${issue.reason}`).join('；')
    throw new Error(`配置未通过准入：${detail}`)
  }
  return admission.config
}
