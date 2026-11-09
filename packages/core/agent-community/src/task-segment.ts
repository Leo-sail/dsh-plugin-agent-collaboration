/**
 * Task segments (S1-4) — a per-bot boundary between one assigned task and the next.
 *
 * WHY THIS EXISTS. A bot's session is keyed `(room, bot)` and lives across tasks, which is good
 * for memory and bad for focus: by the third task the prompt still carries the first two tasks'
 * detours, and a long session grows without a boundary. The Super-agent article's Worker owns ONE
 * task in its own context; the prototype hand a short handoff note from the finished segment to
 * the next one. This module is that handoff, deterministic and host-free:
 *
 *   · the segment key is the assignment (who asked + what for), so the SAME task continued is not
 *     a new segment — only moving to a different task starts one;
 *   · the handoff is BUILT FROM FACTS the previous turn already produced (finish report, declared
 *     deliverables, explicit "unfinished" lines). It is never a model summary, so it cannot invent
 *     work or contradict the record;
 *   · the block is TRUSTED standing context (the user/leader wrote the task and the report), so it
 *     renders outside the trust guard — unlike `memory`/`history`.
 *
 * v1 does NOT open a new session or a new generation: the segment is prompt context only (the
 * handoff + a boundary instruction). A new session per task loses the room memory the whole design
 * relies on; that trade-off is left for a later experiment behind its own switch.
 *
 * @module
 */

/** The facts carried from a finished segment to the next one. */
export interface TaskSegmentReport {
  /** First meaningful lines of the finish report (or the reply when there was no report). */
  readonly summary: string
  /** File names the previous segment declared (max 5). */
  readonly deliverables: readonly string[]
  /** Lines the previous report explicitly calls unfinished (max 3). */
  readonly openItems: readonly string[]
  /** When the report was recorded. */
  readonly at: number
}

/** One bot's current segment, stored on the room (`BotRoom.taskSegments[botId]`). */
export interface TaskSegmentRecord {
  readonly id: string
  /** Assignment identity: who asked + what for. Same key = same task continued. */
  readonly key: string
  readonly title: string
  readonly startedAt: number
  readonly updatedAt: number
  /** Present once a run of this segment finished with a report. */
  readonly lastReport?: TaskSegmentReport | undefined
}

/** Hard caps, so a handoff can never become a second transcript. */
export const MAX_HANDOFF_SUMMARY_CHARS = 600
export const MAX_HANDOFF_DELIVERABLES = 5
export const MAX_HANDOFF_OPEN_ITEMS = 3
export const MAX_OPEN_ITEM_CHARS = 160

/** The assignment identity both halves of the feature derive. */
export function taskSegmentKeyOf(assignment: { readonly subject: string; readonly fromName: string }): string {
  return `${assignment.fromName}\u0000${assignment.subject.trim()}`
}

/** Clip by code points; never throws on odd input. */
function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}

/** Lines that say "this is not finished", in the Chinese and English words reports actually use. */
const OPEN_ITEM_PATTERN = /(未完成|待办|剩余|还没|尚未|阻塞|卡在|下一步|需要补|TODO|todo|pending|blocked|remaining)/u

/**
 * Build the handoff from facts the previous turn produced.
 *
 * Never calls a model and never guesses: the summary is the report's own opening (or the reply when
 * the run produced no report), deliverables are the declared file names, and open items are lines
 * the report itself marks as unfinished. An empty input yields an empty report rather than an
 * invented one.
 */
export function buildTaskHandoff(input: {
  readonly report?: string | undefined
  readonly reply?: string | undefined
  readonly deliverables?: readonly string[] | undefined
  readonly at: number
}): TaskSegmentReport {
  const source = (input.report ?? '').trim() !== '' ? (input.report as string) : (input.reply ?? '')
  const lines = source.split('\n').map(line => line.trim()).filter(line => line !== '')
  const summaryLines = lines.filter(line => !OPEN_ITEM_PATTERN.test(line)).slice(0, 3)
  const summary = clip(summaryLines.join(' ').trim(), MAX_HANDOFF_SUMMARY_CHARS)
  const openItems = lines
    .filter(line => OPEN_ITEM_PATTERN.test(line))
    .slice(0, MAX_HANDOFF_OPEN_ITEMS)
    .map(line => clip(line, MAX_OPEN_ITEM_CHARS))
  const deliverables = [...new Set((input.deliverables ?? []).map(name => name.trim()).filter(name => name !== ''))]
    .slice(0, MAX_HANDOFF_DELIVERABLES)
  return {
    summary: summary === '' ? '（上一段没有留下摘要）' : summary,
    deliverables,
    openItems,
    at: input.at,
  }
}

/**
 * What one turn of a segment should see.
 *
 * `block` is present ONLY when this turn STARTS a new segment (no record yet, or a different key):
 * injecting the boundary on every turn of the same task would waste tokens and re-anchor the model
 * on old work. When the task continues, the record is returned untouched and no block is injected.
 */
export interface SegmentDecision {
  readonly record: TaskSegmentRecord
  /** Present on the first turn of a new segment. */
  readonly block?: string | undefined
}

/** Decide the segment for one run and (only when it changes) render its prompt block. */
export function decideTaskSegment(input: {
  readonly record: TaskSegmentRecord | undefined
  readonly key: string
  readonly title: string
  readonly now: number
  readonly id: string
}): SegmentDecision {
  const title = input.title.trim() === '' ? '（未命名任务）' : input.title.trim()
  if (input.record !== undefined && input.record.key === input.key) {
    return { record: input.record }
  }
  const record: TaskSegmentRecord = {
    id: input.id,
    key: input.key,
    title,
    startedAt: input.now,
    updatedAt: input.now,
    ...(input.record?.lastReport !== undefined ? { lastReport: input.record.lastReport } : {}),
  }
  return { record, block: renderTaskSegmentBlock({ record, previous: input.record }) }
}

/** Render the trusted `[任务段]` block. */
export function renderTaskSegmentBlock(input: {
  readonly record: TaskSegmentRecord
  /** The segment being left behind (its lastReport becomes the handoff). */
  readonly previous?: TaskSegmentRecord | undefined
}): string {
  const lines = [
    '[任务段]',
    `本段任务：${input.record.title}`,
    `段 id：${input.record.id.slice(0, 8)}；只处理这一个任务，上一段的工作不要重做。`,
  ]
  const handoff = input.previous?.lastReport
  if (handoff === undefined) {
    lines.push('本段是新任务段（上一段没有可交接的记录）。')
    return lines.join('\n')
  }
  lines.push('[上一段交接]')
  lines.push(`摘要：${handoff.summary}`)
  if (handoff.deliverables.length > 0) lines.push(`交付物：${handoff.deliverables.join('、')}`)
  if (handoff.openItems.length > 0) lines.push(`未完成：${handoff.openItems.join('；')}`)
  lines.push('需要上一段的细节时，读对应文件或账本，不要凭印象重做。')
  return lines.join('\n')
}

/** Record a finished run's facts on its segment (same task only; a stale key is ignored). */
export function recordSegmentReport(input: {
  readonly record: TaskSegmentRecord | undefined
  readonly key: string
  readonly report: TaskSegmentReport
  readonly now: number
}): TaskSegmentRecord | undefined {
  if (input.record === undefined || input.record.key !== input.key) return input.record
  return { ...input.record, updatedAt: input.now, lastReport: input.report }
}
