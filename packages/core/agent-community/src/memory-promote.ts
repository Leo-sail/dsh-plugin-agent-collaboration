/**
 * Promotion — turning what happened in a room into what the Bot knows for good.
 *
 * THE USER'S TWO CHANNELS, and the second one is the valuable one:
 *
 *   A. REPETITION. The same request, handled successfully, twice → remember how it is done.
 *   B. CORRECTION. Something kept going wrong, the user pushed back more than once, and then
 *      it was done right → remember BOTH halves: the wrong approach (so it is avoided) and the
 *      correct one. The user's words: 「一直犯错，被用户反复提醒，然后经过用户干预后做对了，
 *      这个就是有效经验」.
 *
 * EVIDENCE ONLY. A candidate needs real runs behind it (`runId`s, tool activity), never a
 * model's own account of what it did — the user's rule is 优先参考实际运行，不要自己推测假设.
 * That also decides where a lesson may go: only the strong (run-backed) ones reach the global
 * instruction file; a weak one stays in the room's partition marked as unverified.
 *
 * PURE. No I/O, no model calls: the scanner takes the room's memory entries and the room's
 * messages and returns candidate lines. That makes every rule above a fixture assertion.
 *
 * @module
 */
import type { BotMemoryEntry, BotMessage } from './types.ts'

/**
 * How similar two normalised task texts must be to count as "the same request".
 *
 * Jaccard over character bigrams, after filler words are stripped. 0.6 is deliberately on the
 * tolerant side: two phrasings of one request ("把配置里的超时改成 30s" / "把配置超时改成30s")
 * land near 1.0 once filler is gone, while unrelated requests stay below 0.3 — and a false
 * "same request" only means a remembered line, never a wrong action.
 */
export const SIMILARITY_THRESHOLD = 0.6
/** Repetitions needed for the repetition channel. */
export const REPEAT_THRESHOLD = 2
/** Correction words: the user saying the result was wrong and asking for something else. */
const CORRECTION_WORDS = [
  '不对', '错了', '不是', '不行', '别', '不要', '改成', '重新', '再来', '我说过', '又错',
  'wrong', 'not what', 'redo', 'again', 'incorrect',
]
/** A correction that says what to do instead is an intervention; a bare "no" is only a signal. */
const INTERVENTION_HINTS = ['改成', '应该', '要这样', '按', '用', '而不是', '应该是', '重新做', '换成']

/**
 * Phrases that mean the bot did NOT do the work.
 *
 * A REFUSAL MUST NEVER BE PROMOTED. Measured on a live group: the bot answered 「我认真试了两次，
 * 不是推脱，是插件层面拦住了…要用 bot id，不是显示名」, the run counted as `completed` (it did
 * answer), and the repetition channel promoted that text as "做法" — so the instruction file then
 * taught the bot an outdated conclusion ("I cannot do this") that outlived the bug it described.
 * Memory is supposed to make the bot more capable, not to freeze its limitations.
 *
 * A refusal is recognised in the ANSWER, where it lives — not in the request, which is neutral.
 */
const REFUSAL_MARKERS = [
  '做不到', '不能', '无法', '移不了', '改不了', '办不到', '无权', '没有权限', '不允许',
  'not a member', 'cannot', "can't", 'unable to', 'refused', 'not allowed', 'no permission',
]

/** Whether an answer says "I did not do it" rather than reporting what it did. */
export function looksLikeRefusal(text: string): boolean {
  const lower = text.toLowerCase()
  return REFUSAL_MARKERS.some(marker => lower.includes(marker.toLowerCase()))
}

/** A candidate line for the global instruction file. */
export interface PromotionCandidate {
  readonly kind: 'procedure' | 'lesson'
  /** The line to add to the managed block. */
  readonly line: string
  /** Why this was promoted, for the audit trail and the fixture. */
  readonly evidence: readonly string[]
  /** Strong = backed by real runs; only strong candidates reach the global file. */
  readonly strong: boolean
}

/** Normalise a task line for comparison: drop the framing, collapse whitespace, case-fold. */
/** Filler that varies between two phrasings of the SAME request ("把配置里的超时" / "把配置超时"). */
const FILLER = /[\s，。,.、；;：:！!？?「」“”"'（）()\[\]的了里个一下请帮我呢吧啊着]/gu

export function signatureOf(text: string): string {
  return text
    .replace(/^任务[:：]/u, '')
    .split('→')[0]!
    .replace(FILLER, '')
    .toLowerCase()
}

/** Character-bigram Jaccard similarity — the CJK-friendly stand-in for word overlap. */
export function similarity(a: string, b: string): number {
  // Normalise INSIDE: callers pass either a signature or raw text, and both must compare the
  // same way — comparing raw text made "把配置里的超时改成 30s" only 0.5 similar to its own
  // filler-free form.
  a = a.replace(FILLER, '')
  b = b.replace(FILLER, '')
  if (a === '' || b === '') return 0
  if (a === b) return 1
  const bigrams = (s: string): Set<string> => {
    const out = new Set<string>()
    for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2))
    if (out.size === 0) out.add(s)
    return out
  }
  const left = bigrams(a)
  const right = bigrams(b)
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** The part of an entry's text after `→ 结果：`, or the whole thing when there is none. */
function outcomeOf(text: string): string {
  const at = text.indexOf('→ 结果：')
  return at < 0 ? '' : text.slice(at + '→ 结果：'.length).trim()
}

/** Whether a message reads as the user correcting the previous attempt. */
export function isCorrection(text: string): boolean {
  const lower = text.toLowerCase()
  return CORRECTION_WORDS.some(word => lower.includes(word.toLowerCase()))
}

/** Whether a correction also says what to do instead. */
export function isIntervention(text: string): boolean {
  return INTERVENTION_HINTS.some(word => text.includes(word))
}

/**
 * Scan one (room, bot) history for promotion candidates.
 *
 * @param input.entries - the pair's memory entries, oldest first (task entries carry run ids).
 * @param input.messages - the room's messages, oldest first, for the correction channel.
 * @param input.alreadyLearned - lines already in the global block (de-duplication).
 * @returns candidates, oldest first; the caller stores them and keeps the audit trail.
 */
export function scanPromotions(input: {
  readonly entries: readonly BotMemoryEntry[]
  readonly messages: readonly BotMessage[]
  readonly alreadyLearned: readonly string[]
}): readonly PromotionCandidate[] {
  const tasks = input.entries.filter(e => e.kind === 'task' && e.runId !== undefined)
  const out: PromotionCandidate[] = []

  // ── A. Repetition: same request handled successfully twice ──────────────────
  for (let i = 0; i < tasks.length; i += 1) {
    const first = tasks[i]!
    const firstSig = signatureOf(first.text)
    if (firstSig === '' || outcomeOf(first.text) === '') continue
    const repeat = tasks.slice(i + 1).find(other => similarity(signatureOf(other.text), firstSig) >= SIMILARITY_THRESHOLD)
    if (repeat === undefined || outcomeOf(repeat.text) === '') continue
    // Both attempts must report real work; a refusal is not a method.
    if (looksLikeRefusal(outcomeOf(first.text)) || looksLikeRefusal(outcomeOf(repeat.text))) continue
    // A correction between the two attempts means the first one was NOT the right way.
    const corrected = userSpokeBetween(input.messages, first.at, repeat.at, true)
    if (corrected) continue
    const line = `- 用户要求「${clip(signatureOf(first.text), 60)}」时：做法 = ${clip(outcomeOf(repeat.text), 120)}（证据：run ${first.runId} / ${repeat.runId}）`
    if (input.alreadyLearned.includes(line) || out.some(c => c.line === line)) continue
    out.push({ kind: 'procedure', line, evidence: [String(first.runId), String(repeat.runId)], strong: true })
  }

  // ── B. Correction: wrong → pushed back → done right ─────────────────────────
  const corrections = input.messages
    .map((m, index) => ({ message: m, index }))
    .filter(({ message }) => message.sender.kind === 'user' && isCorrection(message.text))
  for (const { message } of corrections) {
    const before = tasks.filter(t => t.at <= message.createdAt)
    const after = tasks.filter(t => t.at > message.createdAt)
    const lastWrong = before[before.length - 1]
    if (lastWrong === undefined) continue
    // The evidence chain starts at the FIRST wrong attempt of this task family, not the last:
    // "r1 失败 → r3 成功" is the arc worth remembering, and it stays identical across rescans
    // (which is what makes the de-duplication below stable).
    const familySig = signatureOf(lastWrong.text)
    const family = before.filter(t => similarity(signatureOf(t.text), familySig) >= SIMILARITY_THRESHOLD)
    const wrong = family[0] ?? lastWrong
    const right = after.find(t => outcomeOf(t.text) !== '')
    if (right === undefined) continue
    // "Did it right" cannot mean "explained that it could not".
    if (looksLikeRefusal(outcomeOf(right.text))) continue
    // "Doing it right" must be a DIFFERENT approach, or nothing was learned. The comparison is
    // on the OUTCOME (what was actually done), not on the request: both attempts ask for the
    // same thing — that is the whole point — while the answer changed.
    if (similarity(outcomeOf(wrong.text), outcomeOf(right.text)) > 0.95) continue
    const pushedBackTwice = corrections.filter(c => c.message.createdAt <= message.createdAt).length >= REPEAT_THRESHOLD
      || isIntervention(message.text)
    if (!pushedBackTwice) continue
    const line = [
      `- 用户要求「${clip(signatureOf(right.text), 60)}」时：`,
      `✗ 不要 ${clip(wrong.text.replace(/^任务[:：]/u, '').split('→')[0] ?? wrong.text, 80)}（此前被用户纠正）`,
      `✓ 正确做法 ${clip(outcomeOf(right.text), 120)}`,
      `（证据：run ${wrong.runId} → ${right.runId}，${message.createdAt.slice(0, 10)} 用户纠正）`,
    ].join(' ')
    if (input.alreadyLearned.includes(line) || out.some(c => c.line === line)) continue
    out.push({ kind: 'lesson', line, evidence: [String(wrong.runId), String(right.runId)], strong: true })
  }

  return out
}

/** Did the user say anything (optionally: a correction) between two timestamps? */
function userSpokeBetween(
  messages: readonly BotMessage[],
  from: string,
  to: string,
  correctionsOnly: boolean,
): boolean {
  return messages.some(m =>
    m.sender.kind === 'user'
    && m.createdAt > from
    && m.createdAt < to
    && (!correctionsOnly || isCorrection(m.text)))
}

/** Small local clip so this module stays dependency-free. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
