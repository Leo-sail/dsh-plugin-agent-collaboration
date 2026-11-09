/**
 * Chain-of-recall references (S2-2) — the pure half of "stub + id, expand on demand".
 *
 * WHY THIS EXISTS. The history window is a budgeted slice: old turns are dropped, so a bot that
 * needs "what did the user decide two hours ago" has no way back except a full re-read of the
 * room. The Article's Inline & Spill + chain-of-recall pattern keeps the window small by leaving
 * a SHORT stub with a stable id, and gives the model a read tool to expand the object it needs.
 *
 * WHAT THIS MODULE IS. Formatting and identity only: how a stub line looks, which references a
 * message carries (thread/task/run/reply), how a reference is spelled in a prompt, and the hard
 * caps the read tools apply. It never touches host state, never decides visibility (the service
 * checks the caller's room) and never renders message bodies in full.
 *
 * TRUST: stubs are derived from history, so they are rendered INSIDE the untrusted history
 * section. The read tools return raw room data to the caller's own room only — same boundary the
 * room already has.
 *
 * @module
 */

/** What one reference can point at. Closed on purpose: a new kind needs a reader. */
export type ReferenceKind = 'message' | 'thread' | 'task' | 'run' | 'deliverable' | 'approval'

/** One stable pointer a prompt or a tool result can carry. */
export interface ReferenceRef {
  readonly kind: ReferenceKind
  readonly id: string
}

/** The references a stored message carries, as far as the window knows. */
export interface ReferenceSource {
  readonly id: string
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
  readonly replyTo?: string | undefined
  readonly runId?: string | undefined
}

/** Default/inclusive caps shared by the read tools (kept here so service + tools agree). */
export const STUB_CHARS = 50
export const HISTORY_READ_DEFAULT = 8
export const HISTORY_READ_MAX = 20
/** Per-message text cap in a read-tool result: a page, not a transcript dump. */
export const READ_TEXT_CHARS = 1_200
/** How many refs one stub line may carry (thread/task/run/reply), and how many stubs a window keeps. */
export const MAX_REFS_PER_MESSAGE = 4
export const MAX_STUBS = 40

/** Collapse whitespace and clip to `chars` code points, marking the cut with `…`. */
export function stubText(text: string, chars: number = STUB_CHARS): string {
  const limit = Number.isFinite(chars) ? Math.max(1, Math.floor(chars)) : STUB_CHARS
  const flat = text.replace(/\s+/gu, ' ').trim()
  const points = [...flat]
  if (points.length <= limit) return flat
  return `${points.slice(0, limit).join('')}…`
}

/** A stable short id for display; long enough to disambiguate, short enough for a prompt. */
export function shortRefId(id: string, length = 8): string {
  return id.length <= length ? id : id.slice(0, length)
}

/**
 * One stub line: `[#id] sender · time · first 50 chars…`.
 *
 * The id is the payload — everything else is orientation. `at` is passed through as the caller
 * formatted it (ISO is fine; this module does not do time zones).
 */
export function formatStub(input: {
  readonly id: string
  readonly senderName?: string | undefined
  readonly at?: string | undefined
  readonly text?: string | undefined
  readonly chars?: number | undefined
}): string {
  const who = input.senderName !== undefined && input.senderName !== '' ? input.senderName : '消息'
  const when = input.at !== undefined && input.at !== '' ? ` · ${input.at}` : ''
  const body = stubText(input.text ?? '', input.chars ?? STUB_CHARS)
  return `[#${shortRefId(input.id)}] ${who}${when} · ${body}`
}

/** The references one message carries, deduplicated and in a stable display order. */
export function referencesOfMessage(message: ReferenceSource): ReferenceRef[] {
  const refs: ReferenceRef[] = []
  if (message.threadId !== undefined && message.threadId !== '') {
    refs.push({ kind: 'thread', id: message.threadId })
  }
  if (message.taskId !== undefined && message.taskId !== '') {
    refs.push({ kind: 'task', id: message.taskId })
  }
  if (message.runId !== undefined && message.runId !== '') {
    refs.push({ kind: 'run', id: message.runId })
  }
  if (message.replyTo !== undefined && message.replyTo !== '') {
    refs.push({ kind: 'message', id: message.replyTo })
  }
  return dedupeReferences(refs).slice(0, MAX_REFS_PER_MESSAGE)
}

/** Deduplicate by kind+id, preserving first-seen order (so prompts are deterministic). */
export function dedupeReferences(refs: readonly ReferenceRef[]): ReferenceRef[] {
  const seen = new Set<string>()
  const out: ReferenceRef[] = []
  for (const ref of refs) {
    if (ref.id === '') continue
    const key = `${ref.kind}\u0000${ref.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/** How a reference is spelled when a bot is asked to cite one. */
export function formatReference(ref: ReferenceRef): string {
  return `${ref.kind}:${shortRefId(ref.id)}`
}

/** The one-line citation rule carried by the prompt contract's recall section. */
export function citationRule(): string {
  return '引用某个旧对象时写 `thread:…` / `task:…` / `run:…` / `message:…` 或 `#短id`，不要复述全文；'
    + '需要原文就调用读取工具，不要凭印象转述。'
}

/** Clamp an optional limit to `[1, max]`, falling back to `fallback` for nonsense values. */
export function clampReadLimit(value: number | undefined, fallback: number = HISTORY_READ_DEFAULT, max: number = HISTORY_READ_MAX): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

/** Clip one read-tool body (never splits a surrogate pair). */
export function clipReadText(text: string, chars: number = READ_TEXT_CHARS): { readonly text: string; readonly clipped: boolean } {
  const points = [...text]
  if (points.length <= chars) return { text, clipped: false }
  return { text: `${points.slice(0, chars).join('')}…`, clipped: true }
}
