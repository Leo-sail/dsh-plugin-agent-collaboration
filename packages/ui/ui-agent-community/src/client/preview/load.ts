/**
 * One place that turns a delivered file into something the panel can render.
 *
 * The dock and the (now removed) fallback dialog used to duplicate this logic, and the
 * two copies drifted: one converted every Office file through the host, the other
 * rendered a browser `<embed>`. 0.3.1 gives the panel real viewers, so the load path
 * is single: bytes for PDF/DOCX/XLSX (and for host-converted PPT/DOC/XLS), text
 * otherwise, and every failure becomes one `error` state the view can show.
 *
 * Reading still goes through the ledger-addressed RPCs — no client-supplied paths.
 */
import type { CommunityRemote } from '../community/types.ts'
import type { DeliveredFile } from '../conversation/types.ts'
import type { PreviewSource } from './types.ts'

/** One file as the card knows it: the ledger address plus its metadata. */
export interface PreviewLocation {
  readonly roomId: string
  readonly runId: string
  readonly index: number
  readonly file: DeliveredFile
}

/**
 * Legacy/other Office formats the host converts to PDF for the preview.
 *
 * `.docx` and `.xlsx` are deliberately NOT in this set any more: they go to
 * docx-preview / SheetJS from the original bytes, which keeps their text selectable
 * and avoids a LibreOffice round trip just to look at a document.
 */
const HOST_CONVERTED_EXTENSIONS = new Set(['ppt', 'pptx', 'doc', 'xls'])

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** Fetch a `data:` URL the host returned as a small ArrayBuffer. */
async function bytesOfDataUrl(dataUrl: string): Promise<ArrayBuffer> {
  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error(`读取文件数据失败（HTTP ${response.status}）`)
  return await response.arrayBuffer()
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve one delivered file into a renderable source.
 *
 * Never throws: the panel shows the message instead of dropping the preview tab.
 */
export async function loadDeliverablePreview(
  remote: CommunityRemote,
  target: PreviewLocation,
): Promise<PreviewSource> {
  const { roomId, runId, index, file } = target
  const extension = extensionOf(file.name)
  try {
    if (HOST_CONVERTED_EXTENSIONS.has(extension)) {
      const converted = await remote.renderDeliverableDocument({ roomId, runId, index })
      if (!converted.ok) return { kind: 'error', message: converted.error }
      return {
        kind: 'bytes',
        bytes: await bytesOfDataUrl(converted.dataUrl),
        mime: 'application/pdf',
        name: file.name,
      }
    }
    const value = await remote.readDeliverablePreview({ roomId, runId, index })
    if (value.kind === 'missing') return { kind: 'missing', name: file.name }
    if (value.kind === 'binary') return { kind: 'binary', size: value.size }
    if (value.kind === 'text') return { kind: 'text', text: value.text, truncated: value.truncated }
    if (value.mime.startsWith('image/')) return { kind: 'image', dataUrl: value.dataUrl }
    // PDF and the original-bytes Office formats (0.3.1 host returns `data` for them).
    // An older host answers `binary` for docx/xlsx; the view then says "open with an app".
    return { kind: 'bytes', bytes: await bytesOfDataUrl(value.dataUrl), mime: value.mime, name: file.name }
  } catch (error: unknown) {
    return { kind: 'error', message: describeError(error) }
  }
}
