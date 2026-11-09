/**
 * What to say about files a turn declared but never settled.
 *
 * `agent_community_deliver` records files in the ledger's PENDING map during a turn; the
 * success path takes them, stamps one `deliverable` row, and the panel draws the file cards.
 * A failed or user-stopped turn used to discard that map, so the cards vanished and the user
 * was left with an error (or a stop) and no trace that the bot had produced anything at all.
 *
 * P2-2 keeps the cards on those paths. These are the two sentences the caller shows:
 *
 *   · {@link unsettledDeliveryNote} — folded into the thrown error of a FAILED turn, so the
 *     failure says the files were declared but never settled and may be incomplete;
 *   · {@link unsettledDeliveryRetentionNotice} — the grey `dispatch` row of a STOPPED turn,
 *     so the stop says why the cards are still there.
 *
 * Kept pure (no IO, no clock, no ledger) so the wording is tested without a host: the caller
 * owns neither the file names nor the decision to keep them.
 *
 * @module
 */

/** How many file names a note lists before collapsing the rest into 「等 N 个」. */
const MAX_LISTED_FILES = 3

/**
 * The file names as a note may print them.
 *
 * Trimmed and blank-free: a name is a card's label, and a stray empty entry would render as
 * a dangling 「、」. A list that turns out to be empty AFTER this is the same as an empty list.
 */
function noteNames(files: readonly string[]): string[] {
  const names: string[] = []
  for (const file of files) {
    const name = file.trim()
    if (name !== '') names.push(name)
  }
  return names
}

/** `a、b、c` for up to three names; `a、b、c 等 5 个` when there are more. */
function summarizeNames(names: readonly string[]): string {
  const listed = names.slice(0, MAX_LISTED_FILES).join('、')
  return names.length > MAX_LISTED_FILES ? `${listed} 等 ${names.length} 个` : listed
}

/**
 * 「文件已声明但未收口」的说明句；空列表返回 undefined。
 *
 * One Chinese sentence naming at most {@link MAX_LISTED_FILES} files (more become 「等 N 个」),
 * saying that this turn declared them but never settled normally, that they may be incomplete,
 * and that the user should check before relying on them. Used to finish an error message, so it
 * must read as a clause: the caller may append it in parentheses.
 *
 * A list with no usable names (empty, or only blanks) is treated as empty: nothing was
 * declared that a card could show, so there is nothing to warn about.
 */
export function unsettledDeliveryNote(files: readonly string[]): string | undefined {
  const names = noteNames(files)
  if (names.length === 0) return undefined
  return `本回合已声明 ${names.length} 个文件但未正常收口：${summarizeNames(names)}。`
    + '文件可能不完整，请核对后再使用。'
}

/**
 * 停止路径的灰色提示行；空列表返回 undefined。
 *
 * A stop is NOT a failure: the user asked for it, so the wording does not blame the turn — it
 * says the declared files were kept in the cards and may be incomplete. The count is enough
 * here (the cards themselves carry the names); the sentence mentions 「未完整」 on purpose so a
 * reader cannot mistake the retained files for a settled delivery.
 */
export function unsettledDeliveryRetentionNotice(files: readonly string[]): string | undefined {
  const names = noteNames(files)
  if (names.length === 0) return undefined
  return `本轮被停止；已声明的 ${names.length} 个文件保留在卡片中（可能未完整），请核对后再使用。`
}
