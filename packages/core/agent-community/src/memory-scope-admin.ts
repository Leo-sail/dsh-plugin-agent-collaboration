/**
 * Validation for the scoped-memory RPCs — pure, so the panel boundary rules are pinned without a
 * host.
 *
 * WHAT THIS IS FOR. The 记忆 panel manages three partitions: the existing per-`(room, bot)` one
 * (validated in `memory-admin.ts`) and the two long-lived scopes added here — a Bot's cross-room
 * memory (`bot`) and the team-wide rules (`team`). Everything decidable from the REQUEST alone is
 * decided here; the service owns only what needs host state (does the bot exist, if the file is
 * writable, if the journal id is real).
 *
 * POSITIONS, NOT IDS. A scoped file is one Markdown line per entry with no id of its own, so a
 * mutation addresses the entry by its zero-based position in the CURRENT file and the journal
 * records that position. A stale position is handled by the store (it falls back to text search
 * and treats an already-undone change as a no-op), so this module only has to reject impossible
 * values: negatives, non-integers and text above the same cap the room partition uses.
 *
 * THE ERROR TEXTS ARE USER-FACING. The panel shows `error` verbatim, so each is one short Chinese
 * sentence naming the field to fix, never an exception name or a stack line.
 *
 * @module
 */
import { MAX_ENTRY_CHARS } from './bot-memory.ts'
import type {
  DeleteScopedMemoryRequest,
  ListScopedMemoryRequest,
  RevertScopedMemoryRequest,
  ScopedMemoryScopeName,
  UpdateScopedMemoryRequest,
} from './types.ts'

/** The longest text one scoped entry may carry; the same cap the room partition uses. */
export const MAX_SCOPED_MEMORY_TEXT_CHARS = MAX_ENTRY_CHARS

/** `ok` with the normalized request, or a reason the panel can show; never an exception. */
export type ScopedValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

/** Coerce the unknown `scope` field: only the two long-lived partitions are addressable here. */
function readScope(value: unknown): ScopedMemoryScopeName | undefined {
  return value === 'bot' || value === 'team' ? value : undefined
}

/** Non-empty, trimmed string or undefined. */
function readText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim()
}

/**
 * Read the pair a request addresses: `(scope, botId | undefined)`.
 *
 * `bot` scope without a bot id is refused rather than defaulted: a silent default would write
 * into whichever bot the service happened to pick, which is exactly the cross-bot leak the scope
 * exists to prevent.
 */
function readTarget(input: unknown): { ok: true; scope: ScopedMemoryScopeName; botId?: string | undefined } | { ok: false; error: string } {
  if (input === null || typeof input !== 'object') {
    return { ok: false, error: '记忆请求格式无效。' }
  }
  const record = input as Record<string, unknown>
  const scope = readScope(record.scope)
  if (scope === undefined) return { ok: false, error: '记忆作用域只能是 bot 或 team。' }
  if (scope === 'team') return { ok: true, scope }
  const botId = readText(record.botId)
  if (botId === undefined || botId === '') return { ok: false, error: 'Bot 长期记忆需要指定 Bot。' }
  return { ok: true, scope, botId }
}

/** A zero-based position in the current file. */
function readIndex(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return value
}

/** List one scoped partition. */
export function validateScopedList(input: unknown): ScopedValidation<ListScopedMemoryRequest> {
  const target = readTarget(input)
  if (!target.ok) return target
  return {
    ok: true,
    value: { scope: target.scope, ...(target.botId !== undefined ? { botId: target.botId } : {}) },
  }
}

/** Replace one scoped entry's text. */
export function validateScopedUpdate(input: unknown): ScopedValidation<UpdateScopedMemoryRequest> {
  const target = readTarget(input)
  if (!target.ok) return target
  const record = input as Record<string, unknown>
  const index = readIndex(record.index)
  if (index === undefined) return { ok: false, error: '记忆条目位置无效。' }
  const text = readText(record.text)
  if (text === undefined || text === '') return { ok: false, error: '记忆内容不能为空。' }
  if (text.length > MAX_SCOPED_MEMORY_TEXT_CHARS) {
    return {
      ok: false,
      error: `记忆内容最多 ${MAX_SCOPED_MEMORY_TEXT_CHARS} 个字符（当前 ${text.length} 个）。`,
    }
  }
  return {
    ok: true,
    value: {
      scope: target.scope,
      ...(target.botId !== undefined ? { botId: target.botId } : {}),
      index,
      text,
    },
  }
}

/** Delete one scoped entry. */
export function validateScopedDelete(input: unknown): ScopedValidation<DeleteScopedMemoryRequest> {
  const target = readTarget(input)
  if (!target.ok) return target
  const record = input as Record<string, unknown>
  const index = readIndex(record.index)
  if (index === undefined) return { ok: false, error: '记忆条目位置无效。' }
  return {
    ok: true,
    value: {
      scope: target.scope,
      ...(target.botId !== undefined ? { botId: target.botId } : {}),
      index,
    },
  }
}

/** Undo one recorded change in a scoped partition's journal. */
export function validateScopedRevert(input: unknown): ScopedValidation<RevertScopedMemoryRequest> {
  const target = readTarget(input)
  if (!target.ok) return target
  const record = input as Record<string, unknown>
  const journalId = readText(record.journalId)
  if (journalId === undefined || journalId === '') return { ok: false, error: '记忆变更记录无效。' }
  return {
    ok: true,
    value: {
      scope: target.scope,
      ...(target.botId !== undefined ? { botId: target.botId } : {}),
      journalId,
    },
  }
}
