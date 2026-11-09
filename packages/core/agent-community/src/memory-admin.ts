/**
 * Validation for the memory-management RPCs — pure, so the boundary rules can be pinned without
 * a host.
 *
 * WHAT THIS IS FOR. The panel lets the user read, edit, delete and revert one `(room, bot)`
 * memory partition (`listRoomMemory` / `updateRoomMemory` / `deleteRoomMemory` /
 * `revertRoomMemory` in `index.ts`). Everything that can be decided from the request alone is
 * decided here — presence of the ids, the entry cap, the revert target — and the service method
 * only owns what needs host state (does the room/bot exist, is the file writable, is the journal
 * id real).
 *
 * THE ERROR TEXTS ARE USER-FACING. The panel shows `error` verbatim, so they are one short
 * Chinese sentence that says what to fix, never an exception name or a stack line.
 *
 * @module
 */
import { MAX_ENTRY_CHARS } from './bot-memory.ts'

/** The longest text one memory entry may carry; the same cap the store applies when writing. */
export const MAX_MEMORY_TEXT_CHARS = MAX_ENTRY_CHARS

/** `ok` or a reason the panel can show; never an exception. */
export type MemoryValidation = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** Edit one entry's text in one `(room, bot)` partition. */
export interface MemoryEditInput {
  readonly roomId: string
  readonly botId: string
  readonly entryId: string
  readonly text: string
}

/** Delete one entry from one `(room, bot)` partition. */
export interface MemoryDeleteInput {
  readonly roomId: string
  readonly botId: string
  readonly entryId: string
}

/**
 * Undo one change recorded in the partition's journal.
 *
 * A journal row identifies a past write, so reverting needs only the pair and the row id — the
 * row itself carries which entry and what the previous text was.
 */
export interface MemoryRevertInput {
  readonly roomId: string
  readonly botId: string
  readonly journalId: string
}

/** Non-empty, trimmed string or an error naming the field. */
function requireText(value: unknown, field: string): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return field
  return undefined
}

function missingFieldError(missing: string): MemoryValidation {
  return { ok: false, error: missing }
}

/** Validate the pair + target shared by delete and revert. */
function validateTarget(input: { readonly roomId: unknown; readonly botId: unknown }, targetLabel: string, target: unknown): MemoryValidation {
  const room = requireText(input.roomId, '房间不存在。')
  if (room !== undefined) return missingFieldError(`房间 ID 不能为空。`)
  const bot = requireText(input.botId, 'Bot 不存在。')
  if (bot !== undefined) return missingFieldError(`Bot ID 不能为空。`)
  const id = requireText(target, '记忆不存在。')
  if (id !== undefined) return missingFieldError(`${targetLabel}不能为空。`)
  return { ok: true }
}

/**
 * Validate an edit: both ids, the entry id, and a non-empty text inside the entry cap.
 *
 * Empty text is refused rather than written: a memory line with no text parses back as nothing,
 * so "clear this entry" is the delete RPC, not an edit to ''. Keeping the two operations
 * separate is what lets the panel offer undo/delete with distinct outcomes.
 */
export function validateMemoryEdit(input: MemoryEditInput): MemoryValidation {
  const room = requireText(input?.roomId, '房间不存在。')
  if (room !== undefined) return missingFieldError('房间 ID 不能为空。')
  const bot = requireText(input.botId, 'Bot 不存在。')
  if (bot !== undefined) return missingFieldError('Bot ID 不能为空。')
  const entry = requireText(input.entryId, '记忆不存在。')
  if (entry !== undefined) return missingFieldError('记忆条目 ID 不能为空。')
  if (typeof input.text !== 'string' || input.text.trim() === '') {
    return { ok: false, error: '记忆内容不能为空。' }
  }
  if (input.text.length > MAX_MEMORY_TEXT_CHARS) {
    return {
      ok: false,
      error: `记忆内容最多 ${MAX_MEMORY_TEXT_CHARS} 个字符（当前 ${input.text.length} 个）。`,
    }
  }
  return { ok: true }
}

/** Validate a delete: both ids and the entry id. */
export function validateMemoryDelete(input: MemoryDeleteInput): MemoryValidation {
  return validateTarget(input, '记忆条目 ID ', input?.entryId)
}

/** Validate a revert: both ids and the journal row id. */
export function validateMemoryRevert(input: MemoryRevertInput): MemoryValidation {
  return validateTarget(input, '记忆变更记录 ID ', input?.journalId)
}
