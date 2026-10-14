/**
 * Transcript export — what the composer's `/export` command downloads.
 *
 * The room's ledger is the transcript (entries are already in display order and carry the tool
 * rows, usage and streaming flags), so the export is the ledger as pretty-printed JSON. The
 * download is deliberately fire-and-forget: it is a convenience action on a live panel, and a
 * failed export must not surface as an error banner over the conversation the user is reading.
 */
import type { CommunityRemote } from './types.ts'

/**
 * How many ledger entries one export may carry.
 *
 * A ceiling rather than "everything": the ledger is re-parsed on every poll, and a room with a
 * long history would otherwise serialise megabytes on the click's turn.
 */
export const TRANSCRIPT_LIMIT = 5000

/** Fetch `roomId`'s ledger and hand it to the browser as `chat-<roomId>.json`. */
export function exportTranscript(remote: Pick<CommunityRemote, 'listLedger'>, roomId: string): void {
  remote.listLedger(roomId, { limit: TRANSCRIPT_LIMIT }).then(entries => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `chat-${roomId}.json`; a.click()
    URL.revokeObjectURL(url)
  }).catch(() => undefined)
}
