/**
 * download.ts — hand an exported room record to the user's browser as a file.
 *
 * WHY THIS IS A SEPARATE MODULE. The export RPC returns the record as TEXT (the host owns the
 * serialization; the page only downloads what it is given), so all the browser needs is one
 * reliable "save this string as a file" path. Keeping it here — instead of inline in the
 * settings dialog — means the four export buttons share exactly one implementation, the module
 * stays testable/renderable without React, and no dialog has to know about `Blob`/`URL`.
 *
 * The object URL is revoked in `finally`: the click has already started the download, and
 * leaving the URL alive would retain the whole record in memory for the life of the page.
 *
 * @module
 */

/**
 * Save `content` as a downloaded file named `filename`.
 *
 * Uses a throwaway `<a download>` anchored to the document: `Blob` + `URL.createObjectURL` gives
 * the browser an in-memory source, and the programmatic click starts the same save flow as a
 * user-clicked link. Pure browser API surface — nothing here imports a Node module, so the
 * client bundle stays self-contained.
 *
 * @param filename - The suggested file name (`exportLedger` supplies one; callers pass a
 *   fallback for a host that predates it).
 * @param content - The exact text to save (JSON/JSONL/Markdown/transcript).
 * @param mime - Optional MIME type; defaults to UTF-8 plain text.
 */
export function downloadTextFile(filename: string, content: string, mime?: string): void {
  const blob = new Blob([content], { type: mime ?? 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  try {
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    URL.revokeObjectURL(url)
  }
}
