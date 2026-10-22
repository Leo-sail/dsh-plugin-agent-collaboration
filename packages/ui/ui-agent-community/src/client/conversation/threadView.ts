/**
 * threadView — the pure helpers behind the OP-14 threading surfaces and the run-diagnostics
 * panels.
 *
 * Three separate display concerns, all of them "turn data into one line", which is exactly the
 * kind of decision that must be testable without a DOM or a host:
 *
 *   · THREADS. A message may point at `replyTo` (an earlier message in the same room) and may
 *     carry an opaque `threadId` / `taskId`. The transcript renders ONE quote strip above the
 *     row plus a short thread badge — no nesting, no side column. The host validates the
 *     pointer (a reply to a message that does not exist in the room is dropped there), so the
 *     client only has to render what it has and say what is missing.
 *   · NOTICES. Audit/drift/finish-gate notices arrive as ordinary `dispatch` rows because they
 *     must be durable and replayable. The text is the host's, and the plain divider style made
 *     an actionable audit note look like "已邀请 X 加入群聊". `noticeKindOf` classifies the
 *     text so the renderer can add a quiet label and a coloured bar WITHOUT touching the words.
 *   · CONTEXT SECTIONS. `BotRun.evidence.contextSections` is a map of prompt section → chars.
 *     The settings dialog renders it as a small bar chart; the ordering and percentages are
 *     decided here so the component stays layout-only.
 *
 * @module
 */

// ── threads ───────────────────────────────────────────────────────────────────

/** What the composer's "replying to" state holds: the target message plus its linkage. */
export interface ReplyTarget {
  readonly id: string
  /** Display snippet of the target, already clipped for the banner/quote. */
  readonly text: string
  /** The target's own thread, carried so the reply stays in it (one level only). */
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
}

/** What a quote strip renders: the parent pointer, its display snippet and linkage. */
export interface ThreadQuoteData {
  /** Id of the parent message (always present — this is what `replyTo` held). */
  readonly replyTo: string
  /** Clipped parent text; empty when the parent carried no text (the id is shown instead). */
  readonly snippet: string
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
}

/** One row of the context-sections chart. */
export interface ContextSectionRow {
  readonly key: string
  readonly label: string
  /** Characters the section contributed (never negative). */
  readonly chars: number
  /** `chars / total`, in [0, 1]; 0 when the run recorded no sections. */
  readonly ratio: number
}

/** The coloured bar / label a dispatch row gets, derived from its text. */
export type NoticeKind = 'audit' | 'drift' | 'finish-gate' | 'notice'

/** Chinese labels for the prompt sections the host measures (unknown keys pass through). */
export const CONTEXT_SECTION_LABELS: Readonly<Record<string, string>> = {
  role: '角色',
  skills: '技能',
  goal: '目标',
  constraints: '约束',
  patterns: '协作模式',
  memory: '记忆',
  history: '历史',
  input: '输入',
}

/** The first `length` characters of an opaque id, for a badge that fits one line. */
export function shortId(id: string, length = 6): string {
  const clean = id.startsWith('#') ? id.slice(1) : id
  return clean.length <= length ? clean : clean.slice(0, length)
}

/**
 * One line of a message for a quote strip or the composer banner.
 *
 * Newlines and runs of whitespace collapse to single spaces (a quote is a label, not a
 * transcript), then the text is clipped to `max` characters with an ellipsis. An empty or
 * whitespace-only message yields `''`, and the callers fall back to the short id.
 */
export function threadSnippet(text: string, max = 60): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat === '') return ''
  if (!Number.isFinite(max) || max <= 0) return ''
  const chars = [...flat]
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * The badge text for a row that belongs to a thread, or undefined when it belongs to none.
 *
 * A thread id wins over a bare reply pointer: the thread is the stronger grouping fact, and a
 * reply inside a thread is already visible through its quote strip.
 */
export function threadLabel(replyTo: string | undefined, threadId: string | undefined): string | undefined {
  if (threadId !== undefined && threadId !== '') return `#${shortId(threadId)}`
  if (replyTo !== undefined && replyTo !== '') return `回复 ${shortId(replyTo)}`
  return undefined
}

/** Build the composer's reply state from the ledger row the user clicked 回复 on. */
export function replyTargetFor(
  entry: { readonly id: string; readonly text?: string | undefined; readonly threadId?: string | undefined; readonly taskId?: string | undefined },
  max = 80,
): ReplyTarget {
  const snippet = threadSnippet(entry.text ?? '', max)
  return {
    id: entry.id,
    // An empty target (attachment-only message) still gets a usable label in the banner.
    text: snippet !== '' ? snippet : `#${shortId(entry.id)}`,
    ...(entry.threadId !== undefined && entry.threadId !== '' ? { threadId: entry.threadId } : {}),
    ...(entry.taskId !== undefined && entry.taskId !== '' ? { taskId: entry.taskId } : {}),
  }
}

/**
 * The threading fields a send carries.
 *
 * `replyTo` is the pointer the host validates. `threadId`/`taskId` ride along only when the
 * target already had them: starting a NEW thread automatically would invent a grouping the
 * user never asked for, and this UI renders one level only — the user can still reply inside
 * an existing thread by replying to one of its messages.
 */
export function threadSendFields(target: ReplyTarget): {
  readonly replyTo: string
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
} {
  return {
    replyTo: target.id,
    ...(target.threadId !== undefined && target.threadId !== '' ? { threadId: target.threadId } : {}),
    ...(target.taskId !== undefined && target.taskId !== '' ? { taskId: target.taskId } : {}),
  }
}

// ── audit notices ─────────────────────────────────────────────────────────────

/**
 * Which kind of dispatch row this text is.
 *
 * Order matters only for documentation: the finish-gate markers are the most specific, then
 * drift, then audit. The host owns these wordings (`recordNotice` call sites); the renderer
 * must never rewrite them, so a marker that does not match simply stays a plain notice.
 */
export function noticeKindOf(text: string): NoticeKind {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat === '') return 'notice'
  if (flat.includes('完成未通过证据门') || flat.includes('证据门连续') || /bypass/iu.test(flat)) {
    return 'finish-gate'
  }
  if (flat.includes('目标可能偏移')) return 'drift'
  if (flat.includes('建议复盘')) return 'audit'
  return 'notice'
}

/** The tiny label a typed notice shows; plain notices stay unstyled and unlabelled. */
export function noticeKindLabel(kind: NoticeKind): string | undefined {
  switch (kind) {
    case 'audit': return '审计'
    case 'drift': return '目标'
    case 'finish-gate': return '完成门'
    case 'notice': return undefined
  }
}

// ── context sections ─────────────────────────────────────────────────────────

/**
 * Prompt sections ordered by how much of the prompt they took, with their share.
 *
 * Negative/NaN/non-finite entries are dropped (they cannot be measured characters), and the
 * rows sort by size — ties by key, so the chart order is stable between polls. An empty or
 * missing record yields an empty list; the caller shows "暂无".
 */
export function contextSectionRows(
  sections: Readonly<Record<string, number>> | undefined,
): ContextSectionRow[] {
  if (sections === undefined) return []
  const rows: Array<{ key: string; chars: number }> = []
  for (const [key, value] of Object.entries(sections)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
    rows.push({ key, chars: value })
  }
  const total = rows.reduce((sum, row) => sum + row.chars, 0)
  return rows
    .sort((a, b) => (b.chars - a.chars) || a.key.localeCompare(b.key))
    .map(row => ({
      key: row.key,
      label: CONTEXT_SECTION_LABELS[row.key] ?? row.key,
      chars: row.chars,
      ratio: total > 0 ? row.chars / total : 0,
    }))
}
