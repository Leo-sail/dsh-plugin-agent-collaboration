/**
 * The leader's task ledger — a Magentic-One-style blackboard for long group tasks.
 *
 * WHY THIS EXISTS. The leader's dispatch/integrate prompts carry "the reports that arrived since
 * the last turn" plus "who is still running". That is enough for ONE turn and nothing more: on a
 * long task the leader keeps re-deriving what it already established, what it planned, and how far
 * the work got — and a model that loses those three things re-plans the same step, forgets a
 * confirmed constraint, or declares victory without noticing that a required file never arrived.
 *
 * The ledger makes the three long-lived things explicit:
 *
 *   · `facts`    — established, verified things ("图片尺寸是 1080×1440", "用户要中文");
 *   · `plan`     — the current plan, replaced as a batch when it changes;
 *   · `progress` — a short append-only log of "what got done", newest last.
 *
 * Each section is bounded ({@link LEADER_LEDGER_LIMITS}) and every mutation is a pure function that
 * returns a NEW value plus `changed`. Unchanged calls return the SAME object, so a caller can skip
 * a persistence write cheaply and `updatedAt` only moves when something really moved.
 *
 * PURE ON PURPOSE (no IO, no clock, no Cordis): the ledger sequence is
 * the whole contract. Timestamps are explicit `at` arguments, `renderLeaderLedger` is read-only
 * (never writes the ledger back), and `parseLeaderLedger` is the tolerant counterpart the host
 * uses to restore a corrupted/old persisted value after a restart.
 *
 * DELIVERY IS NOT A GATE HERE. The ledger is context, not authority: nothing in this module can
 * close a task, and the renderer merely SHOWS a stall hint when the caller reports one.
 *
 * @module
 */

/** One leader's task ledger. Immutable: every mutation returns a new value. */
export interface LeaderLedger {
  /** Established facts, oldest first; the renderer shows them in this order. */
  readonly facts: readonly string[]
  /** The current plan (a batch), oldest first. */
  readonly plan: readonly string[]
  /** Short progress log, oldest first. */
  readonly progress: readonly string[]
  /** When the ledger last changed (ISO string, supplied by the caller). */
  readonly updatedAt: string
}

/**
 * How many lines each section keeps.
 *
 * Small on purpose: the ledger is a prompt fragment, not a database. All three sections being
 * equal keeps the rule simple — the FIFO trim always drops the OLDEST line of a section.
 */
export const LEADER_LEDGER_LIMITS: Readonly<Record<'facts' | 'plan' | 'progress', number>> = {
  facts: 8,
  plan: 8,
  progress: 8,
}

/** The character budget `renderLeaderLedger` applies when the caller passes none. */
const DEFAULT_LEDGER_MAX_CHARS = 900

/** One folded member report keeps at most this much of its text (the ledger is a summary). */
const MEMBER_REPORT_TEXT_CHARS = 200

/** A type guard for the plain objects the persisted JSON may contain. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collapse whitespace so one text stays on ONE line (a ledger entry is one rendered bullet). */
function flattenLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** One line: flattened and cut with an ellipsis when it exceeds `max`. */
function oneLine(text: string, max: number): string {
  const flat = flattenLine(text)
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Normalise a batch of candidate lines: trim, drop blanks, drop exact duplicates.
 *
 * FIRST occurrence wins, so re-recording a fact does not move it to the end of the section —
 * "dedupe" here means one line per distinct text, not "refresh the timestamp of the line".
 */
function cleanLines(values: readonly unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const line = flattenLine(value)
    if (line === '' || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

/** {@link cleanLines} plus the section cap: the newest `limit` lines survive. */
function cappedLines(values: readonly unknown[], limit: number): string[] {
  return cleanLines(values).slice(-limit)
}

/** Element-wise comparison of two rendered line lists. */
function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * A fresh, empty ledger at `at`.
 *
 * The caller supplies the clock: this module never reads one, so a test can pin every timestamp.
 */
export function emptyLeaderLedger(at: string): LeaderLedger {
  return { facts: [], plan: [], progress: [], updatedAt: at }
}

/**
 * Replace one section with `lines` (cleaned + capped), bumping `updatedAt` only on a real change.
 *
 * The single write path for all three sections: a no-op returns the SAME ledger object, which is
 * the contract that lets the host skip a save and keeps `updatedAt` honest.
 */
function replaceSection(
  ledger: LeaderLedger,
  section: 'facts' | 'plan' | 'progress',
  lines: readonly unknown[],
  at: string,
): { ledger: LeaderLedger; changed: boolean } {
  const next = cappedLines(lines, LEADER_LEDGER_LIMITS[section])
  if (sameLines(ledger[section], next)) return { ledger, changed: false }
  const updated: LeaderLedger = section === 'facts'
    ? { ...ledger, facts: next, updatedAt: at }
    : section === 'plan'
      ? { ...ledger, plan: next, updatedAt: at }
      : { ...ledger, progress: next, updatedAt: at }
  return { ledger: updated, changed: true }
}

/**
 * Append confirmed facts (deduplicated, oldest dropped past the cap).
 *
 * Blank/whitespace-only lines are ignored; a call that changes nothing (all blank, or every line
 * already present) returns the SAME ledger and `changed:false`.
 */
export function recordFacts(
  ledger: LeaderLedger,
  facts: readonly string[],
  at: string,
): { ledger: LeaderLedger; changed: boolean } {
  const additions = cleanLines(facts)
  if (additions.length === 0) return { ledger, changed: false }
  return replaceSection(ledger, 'facts', [...ledger.facts, ...additions], at)
}

/**
 * Replace the current plan as a batch.
 *
 * An empty (or all-blank) input CLEARS the plan — "the plan is now nothing" is a real decision a
 * leader makes when it re-plans from scratch, and the caller expresses it by passing `[]`. The
 * written plan is trimmed/deduplicated and capped to the newest entries.
 */
export function setPlan(
  ledger: LeaderLedger,
  plan: readonly string[],
  at: string,
): { ledger: LeaderLedger; changed: boolean } {
  return replaceSection(ledger, 'plan', plan, at)
}

/**
 * Append progress lines (deduplicated, oldest dropped past the cap).
 *
 * Progress is deliberately append-only: it is the "what happened, in order" log the leader reads
 * to see the task moving. Replacing a plan is {@link setPlan}; adding a step is not.
 */
export function recordProgress(
  ledger: LeaderLedger,
  lines: readonly string[],
  at: string,
): { ledger: LeaderLedger; changed: boolean } {
  const additions = cleanLines(lines)
  if (additions.length === 0) return { ledger, changed: false }
  return replaceSection(ledger, 'progress', [...ledger.progress, ...additions], at)
}

/**
 * Fold member reports into the ledger: one fact line (what was reported) plus one progress line
 * (whether it came back `完成` or `失败`), so the leader reads both the content and the outcome.
 *
 * `ok:false` is a REPORTED FAILURE, not a contradiction: the fact keeps the failure text and the
 * progress line says 失败. Both sections are written in ONE step (one `updatedAt` bump); a batch
 * whose lines are all already present returns the SAME ledger and `changed:false` (a re-delivered
 * report must not spam the ledger).
 */
export function mergeMemberReports(
  ledger: LeaderLedger,
  reports: readonly { readonly name: string; readonly text: string; readonly ok: boolean }[],
  at: string,
): { ledger: LeaderLedger; changed: boolean } {
  const factLines: string[] = []
  const progressLines: string[] = []
  for (const report of reports) {
    const name = typeof report.name === 'string' ? report.name.trim() : ''
    const label = name === '' ? '成员' : name
    const text = oneLine(typeof report.text === 'string' ? report.text : '', MEMBER_REPORT_TEXT_CHARS)
    const outcome = report.ok === true ? '完成' : '失败'
    factLines.push(text === '' ? `[${label}] 汇报` : `[${label}] 汇报：${text}`)
    progressLines.push(`[${label}] ${outcome}`)
  }

  const nextFacts = cappedLines([...ledger.facts, ...factLines], LEADER_LEDGER_LIMITS.facts)
  const nextProgress = cappedLines([...ledger.progress, ...progressLines], LEADER_LEDGER_LIMITS.progress)
  const factsChanged = !sameLines(ledger.facts, nextFacts)
  const progressChanged = !sameLines(ledger.progress, nextProgress)
  if (!factsChanged && !progressChanged) return { ledger, changed: false }
  return {
    ledger: { ...ledger, facts: nextFacts, progress: nextProgress, updatedAt: at },
    changed: true,
  }
}

/** Render one section's lines, or an empty string when the section has nothing to show. */
function renderSection(title: string, lines: readonly string[]): string {
  if (lines.length === 0) return ''
  return `${title}\n${lines.map(line => `· ${line}`).join('\n')}`
}

/**
 * Render the ledger block for a prompt, or undefined when there is nothing to say.
 *
 * The format is fixed (tests pin it; the host splices the block into a prompt):
 *
 * ```
 * [任务账本]
 * 已确认事实：
 * · …
 * 当前计划：
 * · …
 * 进度：
 * · …
 * [停滞提示] 已连续 N 轮没有进展
 * ```
 *
 * Rules:
 *   · an empty section is omitted, never rendered as a bare heading;
 *   · `stalledRounds >= 2` appends the stall hint (one slow round is normal); a caller that does
 *     not track stalls simply passes nothing;
 *   · the rendered block is measured against `maxChars` (default 900) and, when over budget, the
 *     OLDEST lines are dropped one at a time in the order progress → facts → plan. Progress goes
 *     first because it is the most disposable ("it moved"), the plan last because losing the plan
 *     is the most damaging;
 *   · a budget too small for even the non-entry lines yields undefined, the same as an empty
 *     ledger — there is no useful prompt fragment to inject;
 *   · the ledger itself is NEVER modified: this function only reads it.
 */
export function renderLeaderLedger(
  ledger: LeaderLedger,
  options?: {
    readonly stalledRounds?: number | undefined
    /** Total character budget (default 900); over budget trims progress → facts → plan. */
    readonly maxChars?: number | undefined
  },
): string | undefined {
  const stalledRounds = normaliseStalledRounds(options?.stalledRounds)
  const maxChars = typeof options?.maxChars === 'number' && Number.isFinite(options.maxChars)
    ? Math.floor(options.maxChars)
    : DEFAULT_LEDGER_MAX_CHARS

  // A defensive copy: a persisted/hand-edited ledger is still rendered within limits, and the
  // input arrays are never mutated by the trimming loop below.
  let facts = cappedLines(ledger.facts, LEADER_LEDGER_LIMITS.facts)
  let plan = cappedLines(ledger.plan, LEADER_LEDGER_LIMITS.plan)
  let progress = cappedLines(ledger.progress, LEADER_LEDGER_LIMITS.progress)

  const render = (): string | undefined => {
    const sections = [
      renderSection('已确认事实：', facts),
      renderSection('当前计划：', plan),
      renderSection('进度：', progress),
    ].filter(section => section !== '')
    const stall = stalledRounds === undefined
      ? undefined
      : `[停滞提示] 已连续 ${stalledRounds} 轮没有进展`
    if (sections.length === 0 && stall === undefined) return undefined
    return ['[任务账本]', ...sections, ...(stall === undefined ? [] : [stall])].join('\n')
  }

  let block = render()
  while (block !== undefined && block.length > maxChars) {
    // Oldest first, progress before facts before plan; once everything is gone there is nothing
    // left to trim (undefined contains only the header/stall lines, which the caller would not
    // want above its own budget).
    if (progress.length > 0) progress = progress.slice(1)
    else if (facts.length > 0) facts = facts.slice(1)
    else if (plan.length > 0) plan = plan.slice(1)
    else return undefined
    block = render()
  }
  return block
}

/** A real stall is a finite count of at least two whole rounds; anything else is "no hint". */
function normaliseStalledRounds(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const rounds = Math.floor(value)
  return rounds >= 2 ? rounds : undefined
}

/** One persisted section: an array of strings (cropped), anything else is an empty section. */
function parseSection(value: unknown, section: 'facts' | 'plan' | 'progress'): string[] {
  if (!Array.isArray(value)) return []
  return cappedLines(value, LEADER_LEDGER_LIMITS[section])
}

/**
 * Tolerant parser for one persisted ledger (a JSON string or an already-parsed object).
 *
 * The host persists the ledger on the room and reads it back after a restart, so corruption must
 * degrade to "start empty", never crash a turn:
 *   · a torn JSON string, a scalar, an array or `null` returns undefined;
 *   · a missing/blank/non-string `updatedAt` returns undefined (without a clock the value is not
 *     a ledger, and an empty one is created by the caller instead);
 *   · a missing section is empty; a non-array section is empty; non-string entries are dropped,
 *     strings are trimmed/deduplicated and capped to the newest {@link LEADER_LEDGER_LIMITS};
 *   · unknown fields are ignored (a newer write in an older build must not be fatal).
 */
export function parseLeaderLedger(raw: unknown): LeaderLedger | undefined {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return undefined // a half-written/torn value is not data
    }
  }
  if (!isRecord(value)) return undefined
  const rawUpdatedAt = value['updatedAt']
  if (typeof rawUpdatedAt !== 'string' || rawUpdatedAt.trim() === '') return undefined
  return {
    facts: parseSection(value['facts'], 'facts'),
    plan: parseSection(value['plan'], 'plan'),
    progress: parseSection(value['progress'], 'progress'),
    updatedAt: rawUpdatedAt.trim(),
  }
}
