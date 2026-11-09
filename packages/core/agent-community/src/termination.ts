/**
 * termination.ts — composable stop conditions for ONE bot run (P3-2).
 *
 * WHY A COMBINATOR MODULE. "When do we stop?" is asked in at least three places today: the
 * adaptive timeout / no-progress / retry logic in `runs.ts`, `stalledRounds >= STALL_LIMIT` in
 * `group-task.ts`, and a handful of `if`s in `index.ts`. Each place invents its own counter and
 * its own wording, so nobody can answer "why did this run stop?" from one durable line, and no
 * test covers the combination of conditions. This module is the single composable vocabulary:
 * a small set of leaf rules plus `all` / `any` / `not`, evaluated against one plain context
 * value.
 *
 * THE CONTRACT THE HOST RELIES ON
 *   · a rule is a pure value: `evaluate(context)` NEVER mutates the context and NEVER reads a
 *     clock/IO — every clock-derived number is already in the context;
 *   · an illegal threshold (non-finite or `<= 0`) disables a leaf rule for good (it can never
 *     hit); a disabled rule inside `all` therefore makes the group never hit;
 *   · every hit carries the rule's `name` and a Chinese one-line `reason` that contains the
 *     threshold AND the current value, so a ledger/log line can say why the run stopped;
 *   · `all` merges its children into ONE hit only when every child hit; `any` reports EVERY
 *     matching child hit through {@link evaluateTermination}; an empty combinator never hits;
 *   · `not` inverts a child, for "stop unless …" conditions.
 *
 * Reading the result: {@link evaluateTermination} is the single entry point the host uses — it
 * returns `stop` plus the full hit list. `rule.evaluate(context)` is the low-level single-hit
 * primitive (used by the combinators); on `any` it returns one merged summary hit, while
 * {@link evaluateTermination} lists each matching child separately.
 *
 * @module
 */

/** Everything the rules are allowed to look at. All values are supplied by the caller. */
export interface TerminationContext {
  /** How many turns have already run. */
  readonly turns: number
  /** Tokens spent by the task so far (callers pass 0 when unknown). */
  readonly totalTokens: number
  /** The latest produced text (may be empty). */
  readonly lastText: string
  /** Whether this turn completed a hand-off (finish/handoff). */
  readonly handedOff?: boolean | undefined
  /** Milliseconds since the run started. */
  readonly elapsedMs: number
  /** Consecutive turns without progress. */
  readonly stalledRounds: number
}

/** One matching rule: machine name plus a human Chinese reason naming threshold and current value. */
export interface TerminationHit {
  readonly rule: string
  readonly reason: string
}

/** The evaluation result: `stop` is true iff at least one rule hit. */
export interface TerminationOutcome {
  readonly stop: boolean
  readonly hits: readonly TerminationHit[]
  readonly reasons: readonly string[]
}

/** A stop condition. Immutable: evaluating it twice with the same context gives the same result. */
export interface TerminationRule {
  readonly name: string
  readonly description: string
  evaluate(context: TerminationContext): TerminationHit | undefined
}

/**
 * Internal shape of the rules built by this module: a combinator keeps its children so
 * {@link evaluateTermination} can report `any` hits per child instead of merging them. Callers
 * treat every factory result as a plain {@link TerminationRule}.
 */
interface CompositeRule extends TerminationRule {
  readonly combinator: 'all' | 'any' | 'not'
  readonly children: readonly TerminationRule[]
}

/**
 * Stop after `limit` turns (`turns >= limit`).
 *
 * A non-finite or `<= 0` limit disables the rule — never a silent "stop immediately".
 */
export function maxTurns(limit: number): TerminationRule {
  const enabled = isEnabledLimit(limit)
  return {
    name: `maxTurns(${limit})`,
    description: enabled ? `回合数达到上限 ${limit}` : `回合数上限 ${limit}（阈值非法，已禁用）`,
    evaluate: (context) => (enabled && context.turns >= limit
      ? { rule: `maxTurns(${limit})`, reason: `回合数 ${context.turns} 已达到上限 ${limit}` }
      : undefined),
  }
}

/**
 * Stop after `limit` accumulated tokens (`totalTokens >= limit`).
 *
 * A non-finite or `<= 0` limit disables the rule.
 */
export function tokenBudget(limit: number): TerminationRule {
  const enabled = isEnabledLimit(limit)
  return {
    name: `tokenBudget(${limit})`,
    description: enabled ? `累计 token 达到预算 ${limit}` : `token 预算 ${limit}（阈值非法，已禁用）`,
    evaluate: (context) => (enabled && context.totalTokens >= limit
      ? { rule: `tokenBudget(${limit})`, reason: `累计 token ${context.totalTokens} 已达到预算 ${limit}` }
      : undefined),
  }
}

/**
 * Stop when the latest text mentions any of `terms`.
 *
 * Matching is a case-insensitive substring test after trimming each term; an empty term list (or
 * a list of blank terms) disables the rule. The hit reason names the first matched term.
 */
export function textMention(terms: readonly string[]): TerminationRule {
  const normalized = normalizeTerms(terms)
  const name = `textMention(${normalized.join('|')})`
  return {
    name,
    description: normalized.length === 0
      ? '最近输出提到终止词（无有效词，已禁用）'
      : `最近输出提到 ${normalized.map(term => `「${term}」`).join(' 或 ')}`,
    evaluate: (context) => {
      const text = context.lastText.toLowerCase()
      const matched = normalized.find(term => text.includes(term.toLowerCase()))
      return matched === undefined
        ? undefined
        : { rule: name, reason: `最近输出命中终止词「${matched}」` }
    },
  }
}

/** Stop when the turn performed a hand-off (`finish`/`handoff` completed). */
export function handoffReached(): TerminationRule {
  const name = 'handoffReached()'
  return {
    name,
    description: '本轮发生交接（finish/handoff）',
    evaluate: (context) => (context.handedOff === true
      ? { rule: name, reason: '本轮已完成交接（finish/handoff）' }
      : undefined),
  }
}

/**
 * Stop after `limitMs` of elapsed time (`elapsedMs >= limitMs`).
 *
 * A non-finite or `<= 0` limit disables the rule. The name/reason render whole seconds as `600s`
 * (the unit the operator configured it in) and anything else as plain milliseconds.
 */
export function timeout(limitMs: number): TerminationRule {
  const enabled = isEnabledLimit(limitMs)
  return {
    name: `timeout(${formatMs(limitMs)})`,
    description: enabled ? `耗时达到超时上限 ${formatMs(limitMs)}` : `超时上限 ${formatMs(limitMs)}（阈值非法，已禁用）`,
    evaluate: (context) => (enabled && context.elapsedMs >= limitMs
      ? {
        rule: `timeout(${formatMs(limitMs)})`,
        reason: `已耗时 ${formatMs(context.elapsedMs)} 已达到超时上限 ${formatMs(limitMs)}`,
      }
      : undefined),
  }
}

/**
 * Stop after `limit` consecutive no-progress turns (`stalledRounds >= limit`).
 *
 * A non-finite or `<= 0` limit disables the rule.
 */
export function stallLimit(limit: number): TerminationRule {
  const enabled = isEnabledLimit(limit)
  return {
    name: `stallLimit(${limit})`,
    description: enabled ? `连续 ${limit} 回合无进展` : `无进展上限 ${limit}（阈值非法，已禁用）`,
    evaluate: (context) => (enabled && context.stalledRounds >= limit
      ? { rule: `stallLimit(${limit})`, reason: `连续 ${context.stalledRounds} 回合无进展，达到上限 ${limit}` }
      : undefined),
  }
}

/**
 * Every child must hit; the result is ONE merged hit whose reason joins the child reasons.
 *
 * An empty `all()` never hits (there is nothing to satisfy). A disabled child never hits, so it
 * disables the group — that makes `all` safe to configure with optional limits.
 */
export function all(...rules: readonly TerminationRule[]): TerminationRule {
  const name = `all(${rules.map(rule => rule.name).join(', ')})`
  return composite({
    name,
    description: rules.length === 0
      ? '全部条件命中（空规则永不命中）'
      : `同时满足：${rules.map(rule => rule.description).join('；')}`,
    evaluate: (context) => {
      if (rules.length === 0) return undefined
      const reasons: string[] = []
      for (const rule of rules) {
        const childHit = rule.evaluate(context)
        if (childHit === undefined) return undefined
        reasons.push(childHit.reason)
      }
      return { rule: name, reason: `全部条件命中：${reasons.join('；')}` }
    },
    combinator: 'all',
    children: rules,
  })
}

/**
 * Any child hitting is enough; the merged summary hit joins every child reason.
 *
 * An empty `any()` never hits. Note the split: `rule.evaluate` returns the merged summary (one
 * hit), while {@link evaluateTermination} returns each matching CHILD hit separately, so a host
 * can report every condition that fired.
 */
export function any(...rules: readonly TerminationRule[]): TerminationRule {
  const name = `any(${rules.map(rule => rule.name).join(', ')})`
  return composite({
    name,
    description: rules.length === 0
      ? '任一条件命中（空规则永不命中）'
      : `任一满足：${rules.map(rule => rule.description).join('；')}`,
    evaluate: (context) => {
      if (rules.length === 0) return undefined
      const reasons: string[] = []
      for (const rule of rules) {
        const childHit = rule.evaluate(context)
        if (childHit !== undefined) reasons.push(childHit.reason)
      }
      return reasons.length === 0 ? undefined : { rule: name, reason: `任一条件命中：${reasons.join('；')}` }
    },
    combinator: 'any',
    children: rules,
  })
}

/**
 * Invert a rule: stops when the child does NOT hit (for "stop unless …" conditions).
 *
 * The reason says the child condition was NOT met, and repeats the child's description so the log
 * line is readable without the config at hand.
 */
export function not(rule: TerminationRule): TerminationRule {
  const name = `not(${rule.name})`
  return composite({
    name,
    description: `不满足：${rule.description}`,
    evaluate: (context) => (rule.evaluate(context) === undefined
      ? { rule: name, reason: `取反命中：未满足「${rule.description}」` }
      : undefined),
    combinator: 'not',
    children: [rule],
  })
}

/**
 * Evaluate any rule tree against one context — the single decision point for the host.
 *
 * `stop` is true iff at least one rule hit; `hits` carries every hit (`any` lists each matching
 * child recursively, `all`/`not`/leaves carry at most one) and `reasons` is the same list mapped
 * to the human reasons, so a caller can log either.
 */
export function evaluateTermination(rule: TerminationRule, context: TerminationContext): TerminationOutcome {
  const hits = collectHits(rule, context)
  if (hits.length === 0) return { stop: false, hits: [], reasons: [] }
  return { stop: true, hits, reasons: hits.map(hit => hit.reason) }
}

/**
 * One-line human summary of a rule tree: `${N} 条规则：${name}`.
 *
 * `N` counts the LEAF conditions (e.g. `all(any(a, b), not(c))` is 3), which is the number of
 * thresholds an operator actually configured. Example:
 * `2 条规则：any(maxTurns(12), timeout(600s))`.
 */
export function describeTermination(rule: TerminationRule): string {
  return `${leafCount(rule)} 条规则：${rule.name}`
}

/** Attach the combinator bookkeeping to a rule value without widening the public interface. */
function composite(rule: CompositeRule): TerminationRule {
  return rule
}

/** `any` reports every matching child, recursively; everything else reports at most one hit. */
function collectHits(rule: TerminationRule, context: TerminationContext): readonly TerminationHit[] {
  if (isCompositeRule(rule) && rule.combinator === 'any') {
    return rule.children.flatMap(child => collectHits(child, context))
  }
  const hit = rule.evaluate(context)
  return hit === undefined ? [] : [hit]
}

function isCompositeRule(rule: TerminationRule): rule is CompositeRule {
  return 'combinator' in rule && 'children' in rule
}

/** How many leaf conditions the tree contains (0 for an empty combinator). */
function leafCount(rule: TerminationRule): number {
  if (!isCompositeRule(rule)) return 1
  return rule.children.reduce((total, child) => total + leafCount(child), 0)
}

/** A usable threshold: finite and strictly positive. Everything else disables the rule. */
function isEnabledLimit(limit: number): boolean {
  return Number.isFinite(limit) && limit > 0
}

/** Trim terms, drop blanks; runtime-defensive against non-string config values. */
function normalizeTerms(terms: readonly string[]): readonly string[] {
  return terms
    .filter((term): term is string => typeof term === 'string')
    .map(term => term.trim())
    .filter(term => term !== '')
}

/** `600000 → 600s`, `1500 → 1500ms`, `600 → 600ms` — the unit the operator configured. */
function formatMs(ms: number): string {
  return Number.isFinite(ms) && ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}
