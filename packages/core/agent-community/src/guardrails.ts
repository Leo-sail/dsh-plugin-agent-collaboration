/**
 * Guardrails (P3-3): pluggable pre-turn / post-turn checks on what a bot is handed and returns.
 *
 * WHY. The community already has a finish gate for "is the work actually done" (OP-02). It has no
 * answer for "is this TEXT acceptable" — a room can require short answers, a mandatory section, a
 * forbidden term, or a narrow tool set, and today nothing enforces or even reports that. A
 * guardrail is one named check a user registers; a failed check can `repair` (append one prompt
 * line and let the model fix it in place) or `block` (stop the run and surface the reason).
 *
 * SCOPE OF THIS SLICE — PURE MODULE ONLY. Rules, evaluation, config parsing, repair-prompt and
 * diagnostics. No IO, no clock, no host types, no imports at all: everything here is a value in,
 * a value out. `parseGuardrailsConfig` accepts the raw `Config.guardrails` array and skips bad
 * entries with a Chinese reason instead of throwing, so a typo in config can never take the
 * service down. The default config is empty → zero behaviour change until the host wires this.
 *
 * ONE RULE, ONE FAILURE. `evaluateGuardrails` runs every rule of the matching stage and collects
 * every failure (never first-failure-wins): the model gets one retry with the complete list, and
 * the panel/log gets the complete picture. `block` is strictly stricter than `repair`: if any
 * failure wants to block, the outcome action is `block`.
 *
 * STAGE. `pre-turn` checks the text about to be sent (e.g. a room instruction), `post-turn` checks
 * the bot's answer and tools. A rule only runs on its own stage. User config defaults to
 * `post-turn` (the common case is output formatting); a config entry may set `stage` explicitly.
 *
 * @module
 */

/** When a rule runs: on the text going INTO the turn, or on what came OUT of it. */
export type GuardrailStage = 'pre-turn' | 'post-turn'

/** What a failed rule asks for: fix in place, or stop the run. */
export type GuardrailAction = 'block' | 'repair'

/**
 * The action a rule gets when the caller (or a config entry) does not name one.
 *
 * `repair` is the safe default: the run continues with one more prompt line and the model can fix
 * its answer in place. `block` stops the run, so it must always be an explicit choice.
 */
export const DEFAULT_GUARDRAIL_ACTION: GuardrailAction = 'repair'

/** The stage a config entry targets when it does not name one (output formatting is the norm). */
export const DEFAULT_GUARDRAIL_STAGE: GuardrailStage = 'post-turn'

/** Everything one check may know. Injected by the caller; this module never fetches any of it. */
export interface GuardrailContext {
  readonly stage: GuardrailStage
  readonly text: string
  /** One-based turn number inside the run, for diagnostics (rules do not need it today). */
  readonly turn: number
  readonly botId: string
  readonly roomId: string
  /** post-turn: the tool names this turn used (consumed by `toolAllowlistRule`). */
  readonly toolNames?: readonly string[] | undefined
}

/** One failed check, as reported to the caller. */
export interface GuardrailFailure {
  readonly ruleId: string
  readonly action: GuardrailAction
  /** One short Chinese sentence naming what failed and what to do about it. */
  readonly reason: string
}

/** The result of one evaluation over a rule list. */
export interface GuardrailOutcome {
  readonly ok: boolean
  /** Every failure of the evaluated stage, in rule order; empty when `ok`. */
  readonly failures: readonly GuardrailFailure[]
  /** The strictest requested action: `block` > `repair` > no failures. */
  readonly action: 'block' | 'repair' | undefined
}

/** One registered check. `check` returns the failure reason, or `undefined` when it passes. */
export interface GuardrailRule {
  readonly id: string
  readonly stage: GuardrailStage
  /** One line for logs/diagnostics: what this rule enforces. */
  readonly description: string
  readonly action: GuardrailAction
  check(context: GuardrailContext): string | undefined
}

/** Format a list of offending terms the one way all reasons do: 「a」、「b」. */
function quotedList(terms: readonly string[]): string {
  return terms.map(term => `「${term}」`).join('、')
}

/** Trim, drop empties and de-duplicate; a rule factory must not keep user whitespace as content. */
function cleanTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const term of terms) {
    const trimmed = term.trim()
    if (trimmed !== '') seen.add(trimmed)
  }
  return [...seen]
}

/**
 * Fail when the text is longer than `maxChars`.
 *
 * This is a length gate on the Chinese/Unicode text as JavaScript counts it (UTF-16 code units,
 * the same unit the memory/journal caps use); it is not a token estimate.
 */
export function maxCharsRule(input: {
  id: string
  stage: GuardrailStage
  maxChars: number
  action?: GuardrailAction
}): GuardrailRule {
  return {
    id: input.id,
    stage: input.stage,
    description: `最长 ${input.maxChars} 字符`,
    action: input.action ?? DEFAULT_GUARDRAIL_ACTION,
    check(context) {
      if (context.text.length > input.maxChars) {
        return `内容 ${context.text.length} 字符，超过上限 ${input.maxChars} 字符。`
      }
      return undefined
    },
  }
}

/**
 * Fail unless every term appears in the text.
 *
 * Matching is case-insensitive and terms are trimmed, so 「必须包含：已完成」 accepts
 * `已完成` anywhere in the text; a term that is only whitespace is ignored rather than
 * making the rule impossible to pass.
 */
export function mustIncludeRule(input: {
  id: string
  stage: GuardrailStage
  terms: readonly string[]
  action?: GuardrailAction
}): GuardrailRule {
  const terms = cleanTerms(input.terms)
  return {
    id: input.id,
    stage: input.stage,
    description: terms.length === 0 ? '必须包含：（未配置词）' : `必须包含：${terms.join('、')}`,
    action: input.action ?? DEFAULT_GUARDRAIL_ACTION,
    check(context) {
      const haystack = context.text.toLowerCase()
      const missing = terms.filter(term => !haystack.includes(term.toLowerCase()))
      if (missing.length > 0) return `缺少必须包含的内容：${quotedList(missing)}。`
      return undefined
    },
  }
}

/**
 * Fail when any forbidden term appears.
 *
 * Matching is case-insensitive and terms are trimmed, so 「禁止出现：秘密」 catches `秘密` in
 * `这是秘密。`. Hits are reported by their configured spelling, not the text's spelling.
 */
export function forbiddenTermsRule(input: {
  id: string
  stage: GuardrailStage
  terms: readonly string[]
  action?: GuardrailAction
}): GuardrailRule {
  const terms = cleanTerms(input.terms)
  return {
    id: input.id,
    stage: input.stage,
    description: terms.length === 0 ? '禁止出现：（未配置词）' : `禁止出现：${terms.join('、')}`,
    action: input.action ?? DEFAULT_GUARDRAIL_ACTION,
    check(context) {
      const haystack = context.text.toLowerCase()
      const hits = terms.filter(term => haystack.includes(term.toLowerCase()))
      if (hits.length > 0) return `包含禁止内容：${quotedList(hits)}。`
      return undefined
    },
  }
}

/**
 * Fail when the turn used a tool outside `allow`.
 *
 * The rule is inherently post-turn (a pre-turn context has no tool list yet), so its stage is
 * fixed. Tool names are identifiers and therefore compared exactly (only trimmed for display);
 * a context without `toolNames` — e.g. the bot used no tools — passes.
 */
export function toolAllowlistRule(input: {
  id: string
  allow: readonly string[]
  action?: GuardrailAction
}): GuardrailRule {
  const allow = cleanTerms(input.allow)
  const allowed = new Set(allow)
  return {
    id: input.id,
    stage: 'post-turn',
    description: allow.length === 0 ? '只允许工具：（未配置工具）' : `只允许工具：${allow.join('、')}`,
    action: input.action ?? DEFAULT_GUARDRAIL_ACTION,
    check(context) {
      if (context.toolNames === undefined || context.toolNames.length === 0) return undefined
      // A tool called twice appears twice in `toolNames`; report each offending name once.
      const disallowed = [...new Set(
        context.toolNames.map(name => name.trim()).filter(name => name !== '' && !allowed.has(name)),
      )]
      if (disallowed.length > 0) return `使用了不允许的工具：${quotedList(disallowed)}。`
      return undefined
    },
  }
}

/**
 * Run every rule of the context's stage and collect all failures.
 *
 * Empty rule list → `{ ok: true, failures: [], action: undefined }`: the default configuration is
 * a no-op. Rules of the other stage are skipped entirely. `ok` is `failures.length === 0`, and
 * the outcome action is the strictest one requested (`block` wins over `repair`).
 */
export function evaluateGuardrails(
  rules: readonly GuardrailRule[],
  context: GuardrailContext,
): GuardrailOutcome {
  const failures: GuardrailFailure[] = []
  for (const rule of rules) {
    if (rule.stage !== context.stage) continue
    const reason = rule.check(context)
    if (reason === undefined) continue
    const trimmed = reason.trim()
    if (trimmed === '') continue
    failures.push({ ruleId: rule.id, action: rule.action, reason: trimmed })
  }
  const action: 'block' | 'repair' | undefined = failures.length === 0
    ? undefined
    : failures.some(failure => failure.action === 'block') ? 'block' : 'repair'
  return { ok: failures.length === 0, failures, action }
}

/** True for a non-null, non-array object — the only shape a config entry may be. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A trimmed non-empty string, or `undefined` when absent/invalid (both mean "not set"). */
function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Read a string-array field: every item must be a string; blanks are dropped.
 *
 * `undefined` means "not a usable list" (missing, not an array, or an item that is not a string);
 * `readTerms` below turns that into a config error. An array that only contains blanks reads as
 * `[]`, which the caller also rejects — a rule with no terms is almost always a typo.
 */
function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    const trimmed = item.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

/** Read an optional `action` field, distinguishing "absent" from "invalid". */
function readAction(value: unknown): { readonly ok: true; readonly action: GuardrailAction } | { readonly ok: false } {
  if (value === undefined) return { ok: true, action: DEFAULT_GUARDRAIL_ACTION }
  if (value === 'repair' || value === 'block') return { ok: true, action: value }
  return { ok: false }
}

/** Read an optional `stage` field, distinguishing "absent" from "invalid". */
function readStage(value: unknown): { readonly ok: true; readonly stage: GuardrailStage } | { readonly ok: false } {
  if (value === undefined) return { ok: true, stage: DEFAULT_GUARDRAIL_STAGE }
  if (value === 'pre-turn' || value === 'post-turn') return { ok: true, stage: value }
  return { ok: false }
}

/**
 * Add `base` to `used`, suffixing `-2`, `-3`, … until it is unique.
 *
 * Duplicate ids are a config mistake, not a fatal error: keeping both rules and making the id
 * unique preserves everything the user asked for, and `describeGuardrails` then shows the suffix
 * (`maxChars-2`) so the duplicate is visible instead of silently swallowing one rule.
 */
function reserveId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  const id = `${base}-${suffix}`
  used.add(id)
  return id
}

/** One successfully parsed config rule, or the reason it was skipped. */
type ParsedEntry = { readonly rule: GuardrailRule } | { readonly error: string }

/** Build one rule from a config entry; every failure path returns a Chinese reason, never throws. */
function parseEntry(entry: unknown, index: number, used: Set<string>): ParsedEntry {
  const position = `第 ${index + 1} 项`
  if (!isRecord(entry)) return { error: `${position}不是对象，已跳过。` }

  const rawType = entry['type']
  if (typeof rawType !== 'string' || rawType.trim() === '') {
    return { error: `${position}缺少 type，已跳过。` }
  }
  const type = rawType.trim()

  const rawId = entry['id']
  if (rawId !== undefined && typeof rawId !== 'string') {
    return { error: `${position}的 id 必须是字符串，已跳过。` }
  }
  const parsedAction = readAction(entry['action'])
  if (!parsedAction.ok) return { error: `${position}的 action 只能是 repair 或 block，已跳过。` }
  const action = parsedAction.action
  const parsedStage = readStage(entry['stage'])
  if (!parsedStage.ok) return { error: `${position}的 stage 只能是 pre-turn 或 post-turn，已跳过。` }

  /** The config id, or a stable default derived from type + position. */
  const id = reserveId(readOptionalString(rawId) ?? `${type}-${index + 1}`, used)

  switch (type) {
    case 'maxChars': {
      const maxChars = entry['maxChars']
      if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars <= 0) {
        return { error: `${position}的 maxChars 必须是正整数，已跳过。` }
      }
      return { rule: maxCharsRule({ id, stage: parsedStage.stage, maxChars, action }) }
    }
    case 'mustInclude': {
      const terms = readStringArray(entry['terms'])
      if (terms === undefined || terms.length === 0) {
        return { error: `${position}的 terms 必须是非空字符串数组，已跳过。` }
      }
      return { rule: mustIncludeRule({ id, stage: parsedStage.stage, terms, action }) }
    }
    case 'forbiddenTerms': {
      const terms = readStringArray(entry['terms'])
      if (terms === undefined || terms.length === 0) {
        return { error: `${position}的 terms 必须是非空字符串数组，已跳过。` }
      }
      return { rule: forbiddenTermsRule({ id, stage: parsedStage.stage, terms, action }) }
    }
    case 'toolAllowlist': {
      const allow = readStringArray(entry['allow'])
      if (allow === undefined || allow.length === 0) {
        return { error: `${position}的 allow 必须是非空字符串数组，已跳过。` }
      }
      // Tool checks are inherently post-turn; `stage` is irrelevant here by design.
      return { rule: toolAllowlistRule({ id, allow, action }) }
    }
    default:
      return { error: `${position}的 type「${type}」未知，已跳过。` }
  }
}

/**
 * Parse `Config.guardrails` (an `unknown[]`) into rules.
 *
 * The default config is `undefined` — "not configured" — and parses to an empty rule list with no
 * error. Anything else that is not an array is reported (and ignored). Each array entry is parsed
 * independently: a bad entry becomes one Chinese line in `errors` and is skipped, so one typo
 * never costs the user the rest of their rules. Never throws, never mutates `raw`.
 */
export function parseGuardrailsConfig(raw: unknown): {
  readonly rules: readonly GuardrailRule[]
  readonly errors: readonly string[]
} {
  if (raw === undefined) return { rules: [], errors: [] }
  if (!Array.isArray(raw)) {
    return { rules: [], errors: ['guardrails 配置必须是数组。'] }
  }
  const rules: GuardrailRule[] = []
  const errors: string[] = []
  const used = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const parsed = parseEntry(entry, index, used)
    if ('rule' in parsed) rules.push(parsed.rule)
    else errors.push(parsed.error)
  }
  return { rules, errors }
}

/**
 * One line for startup logs / diagnostics: the rule count plus `id(stage/action)` per rule.
 *
 * The empty string is not used for the empty case on purpose — a caller that prints the line
 * unconditionally should read「未启用」, not blank.
 */
export function describeGuardrails(rules: readonly GuardrailRule[]): string {
  if (rules.length === 0) return '（未启用 guardrails）'
  const summary = rules.map(rule => `${rule.id}(${rule.stage}/${rule.action})`).join('、')
  return `${rules.length} 条：${summary}`
}

/**
 * The prompt line(s) appended when an evaluation asks for `repair`.
 *
 * `undefined` for a passing or blocking outcome: a block stops the run, it does not get a repair
 * round. Otherwise every repair failure is listed with its `ruleId` and reason, and the model is
 * told to fix only the listed problems — a guardrail must not turn into a rewrite instruction.
 */
export function guardrailRepairPrompt(outcome: GuardrailOutcome): string | undefined {
  if (outcome.action !== 'repair' || outcome.failures.length === 0) return undefined
  const lines = outcome.failures.map(failure => `- 【${failure.ruleId}】${failure.reason}`)
  return [
    '上面这次输出没有通过格式检查。请只修下面列出的问题，其他内容一律不要改动：',
    ...lines,
    '修正后按原有要求重新输出。',
  ].join('\n')
}
