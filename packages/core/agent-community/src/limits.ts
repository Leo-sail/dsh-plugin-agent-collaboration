/**
 * User-facing limit errors for the capacity caps.
 *
 * WHY THIS IS A MODULE: the caps were enforced with English strings thrown from the
 * service (`Bot limit 32 reached`, `Room limit 64 reached`). The panel shows the error
 * the host returns, so a Chinese user read an English sentence — and worse, the sentence
 * did not say WHAT to do. Both facts are part of the bug report ("达到上限后点创建没有
 * 任何提示"): the message must be readable and actionable, and the room cap must admit
 * that it counts the direct chats every Bot gets.
 *
 * Pure so the wording (and the boundary rule, count >= limit) can be tested without a
 * service or a host.
 */

/** Error text for a refused Bot creation / fork. */
export function botLimitError(limit: number): string {
  return `已达到 Bot 上限（${limit} 个）。请先删除一个不再使用的 Bot，`
    + '或调高 DSH 配置里的 maxBots，然后再创建。'
}

/** Error text for a refused group-room creation. */
export function roomLimitError(limit: number): string {
  return `已达到房间上限（${limit} 个）。这个上限把每个 Bot 的直聊房间也算在内，`
    + '请先删除一个群聊或直聊房间（可在侧栏右键删除），或调高 DSH 配置里的 maxRooms。'
}

/** Whether a create with `count` existing entries must be refused at `limit`. */
export function atLimit(count: number, limit: number): boolean {
  return count >= limit
}
