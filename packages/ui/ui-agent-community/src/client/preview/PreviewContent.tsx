/**
 * The panel's one preview dispatcher: loading/error states plus the type-to-viewer map.
 *
 * PDF goes to the in-house pdf.js viewer, `.docx` to docx-preview, `.xlsx`/`.csv` to
 * SheetJS, images to `<img>`, HTML to a script-less sandboxed iframe, Markdown to the
 * conversation renderer and everything else to plain text.
 */
import { useEffect, useMemo, type ReactElement } from 'react'
import { Markdown } from '../conversation/Markdown.tsx'
import { DocxViewer } from './DocxViewer.tsx'
import { PdfViewer } from './PdfViewer.tsx'
import { SheetViewer } from './SheetViewer.tsx'
import type { PreviewSource } from './types.ts'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

const muted = { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a929c)' } as const
const errorText = { padding: 12, fontSize: 12, color: 'var(--dsw-alias-status-error, #c0392b)' } as const

/** HTML is untrusted: a sandbox without allow-scripts cannot touch the panel. */
function HtmlPreview({ text, name }: { readonly text: string; readonly name: string }): ReactElement {
  const url = useMemo(() => URL.createObjectURL(new Blob([text], { type: 'text/html' })), [text])
  useEffect(() => () => { URL.revokeObjectURL(url) }, [url])
  return <iframe src={url} title={name} sandbox="" style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }} />
}

function TextPreview({ text, name }: { readonly text: string; readonly name: string }): ReactElement {
  const extension = extensionOf(name)
  if (extension === 'md' || extension === 'markdown') {
    return <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }}><Markdown text={text} /></div>
  }
  return (
    <pre style={{
      flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: 14, fontSize: 12,
      whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55,
      fontFamily: 'var(--dsw-font-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
      color: 'var(--dsw-alias-label-primary, #1b2129)',
    }}>{text}</pre>
  )
}

/** Render one loaded preview source. Assumes a flex-column parent with a bounded height. */
export function PreviewContent({ source, name }: {
  readonly source: PreviewSource
  readonly name: string
}): ReactElement {
  if (source.kind === 'loading') return <div style={muted}>正在加载预览…</div>
  if (source.kind === 'error') return <div style={errorText}>{source.message}</div>
  if (source.kind === 'missing') return <div style={errorText}>文件已不存在。</div>
  if (source.kind === 'binary') {
    return <div style={muted}>该类型不支持内嵌预览（{source.size.toLocaleString()} 字节）。请用「用应用打开」。</div>
  }
  if (source.kind === 'image') {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'center' }}>
        <img src={source.dataUrl} alt={name} style={{ maxWidth: '100%', display: 'block', margin: 12 }} />
      </div>
    )
  }
  if (source.kind === 'text') {
    if (extensionOf(name) === 'csv') return <SheetViewer source={{ kind: 'text', text: source.text }} name={name} />
    if (extensionOf(name) === 'html' || extensionOf(name) === 'htm') return <HtmlPreview text={source.text} name={name} />
    return <TextPreview text={source.text} name={name} />
  }
  // bytes: PDF wins on mime because host-converted Office arrives as application/pdf.
  if (source.mime === 'application/pdf') return <PdfViewer bytes={source.bytes} name={name} />
  if (source.mime === DOCX_MIME) return <DocxViewer bytes={source.bytes} name={name} />
  if (source.mime === XLSX_MIME) return <SheetViewer source={{ kind: 'bytes', bytes: source.bytes }} name={name} />
  return <div style={muted}>该类型不支持内嵌预览。请用「用应用打开」。</div>
}
