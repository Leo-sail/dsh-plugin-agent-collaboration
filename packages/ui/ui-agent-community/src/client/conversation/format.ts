/**
 * Transcript formatting helpers: durations, clock times and token counts.
 *
 * @module
 */
import type { TokenUsage } from './types.ts'
import { USAGE_CONSUMED, USAGE_COUNT, compactNumber } from './nativeStrings.ts'



export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * `formatMessageClock` — native `chat:1057-1068` (§2.1):
 * same calendar day → `HH:mm` (24-hour, zero-padded); earlier this year →
 * `{m}月{d}日 HH:mm`; another year → `{y}年{m}月{d}日 HH:mm`.
 */

export function fmtClock(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const n = new Date()
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return clock
  }
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === n.getFullYear() ? `${md} ${clock}` : `${d.getFullYear()}年${md} ${clock}`
}

/** Character count for the "已思考 N 字" label — whitespace does not count. */
/**
 * Native `formatTokens` (`chat:6273-6278`) — `{value}K` / `{value}M` with the
 * native `candidate >= 100 ? Math.round : one-decimal` switch, so 123 456 tokens
 * render as `123K` and 1234567 as `1.2M`.
 *
 * The implementation is the shared {@link compactNumber} from
 * `nativeStrings.ts`; it is re-exported under the native name so callers and the
 * harness talk about the same function the native bundle does.
 */

export function fmtExact(value: number): string {
  const digits = String(value)
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end))
  }
  return groups.join(',')
}

/** First defined, finite, positive value — picks between the input variants. */

export function firstPositive(...values: Array<number | undefined>): number | undefined {
  for (const v of values) {
    if (v !== undefined && Number.isFinite(v) && v > 0) return v
  }
  return undefined
}

/**
 * The native usage trigger label (§2.3): `用量 {total} tok`, built from
 * `t("message.turnUsage.consumed")` + `t("message.turnUsage.count")` around
 * `formatTokens(totalTokens)`.
 *
 * Providers that never report a total (restored history) fall back to the
 * per-bucket meta line so the trigger is never empty; `exact` preserves the true
 * numbers for the tooltip whenever the compact form rounded them.
 */

export function fmtUsage(usage: TokenUsage | undefined): { label: string; exact: string } | undefined {
  if (usage === undefined) return undefined

  const total = usage.totalTokens
  if (total !== undefined && Number.isFinite(total) && total > 0) {
    return {
      label: USAGE_CONSUMED.replace('{total}', USAGE_COUNT.replace('{count}', formatTokens(total))),
      exact: USAGE_CONSUMED.replace('{total}', USAGE_COUNT.replace('{count}', fmtExact(total))),
    }
  }

  const parts: Array<{ label: string; value: number }> = []
  const add = (label: string, value: number | undefined): void => {
    if (value !== undefined && Number.isFinite(value) && value > 0) parts.push({ label, value })
  }
  add('输入', firstPositive(usage.inputTokens, usage.uncachedInputTokens))
  add('缓存命中', usage.cacheReadTokens)
  add('缓存写入', usage.cacheWriteTokens)
  add('输出', usage.outputTokens)
  if (parts.length === 0) return undefined
  return {
    label: parts.map(p => `${p.label} ${formatTokens(p.value)}`).join(' · '),
    exact: parts.map(p => `${p.label} ${fmtExact(p.value)}`).join(' · '),
  }
}

/**
 * Disclosure chevron — native artwork (§3.7 / §3.8), 14px like the native
 * `DisclosureRow` leading icon.
 */

export const formatTokens = compactNumber

/** Reasoning label count — same native K/M compaction as the token figures. */
/** Native `formatExactTokens` (`chat:6285-6290`): group every three digits. */
