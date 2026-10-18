/** Right-hand preview dock inside the plugin page: conversation stays left, document right. */
import { useEffect, useState, type ReactElement } from 'react'
import type { CommunityRemote, DeliverablePreview } from '../community/types.ts'
import type { DeliveredFile } from './types.ts'
import { Markdown } from './Markdown.tsx'

export interface PreviewRequest {
  readonly roomId: string
  readonly runId: string
  readonly index: number
  readonly file: DeliveredFile
}

export const PREVIEW_EVENT = 'agent-community:preview'

type State =
  | { status: 'loading' }
  | { status: 'ready'; value: DeliverablePreview }
  | { status: 'error'; message: string }

const OFFICE = /[.](docx?|xlsx?|pptx?)$/iu
const IMAGE = /[.](png|jpe?g|gif|webp|bmp|svg)$/iu

function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** One preview surface, chosen by the file's type. */
export function PreviewDock({ request, remote, onClose }: {
  readonly request: PreviewRequest
  readonly remote?: CommunityRemote | undefined
  readonly onClose: () => void
}): ReactElement {
  const { file, roomId, runId, index } = request
  const [state, setState] = useState<State>({ status: 'loading' })
  const [htmlUrl, setHtmlUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    setHtmlUrl(undefined)
    const load = async (): Promise<void> => {
      if (remote === undefined) { setState({ status: 'error', message: '当前宿主不支持预览。' }); return }
      try {
        if (OFFICE.test(file.name)) {
          const r = await remote.renderDeliverableDocument({ roomId, runId, index })
          if (!alive) return
          if (!r.ok) { setState({ status: 'error', message: r.error }); return }
          const blob = await (await fetch(r.dataUrl)).blob()
          setState({ status: 'ready', value: { kind: 'data', name: file.name, mime: 'application/pdf', dataUrl: URL.createObjectURL(blob) } })
          return
        }
        const v = await remote.readDeliverablePreview({ roomId, runId, index })
        if (!alive) return
        if (v.kind === 'data') {
          const blob = await (await fetch(v.dataUrl)).blob()
          const url = URL.createObjectURL(blob)
          if (ext(file.name) === 'html' || ext(file.name) === 'htm') {
            const text = await blob.text()
            setHtmlUrl(URL.createObjectURL(new Blob([text], { type: 'text/html' })))
            setState({ status: 'ready', value: { kind: 'binary', name: file.name, size: blob.size } })
            return
          }
          setState({ status: 'ready', value: { ...v, dataUrl: url } })
          return
        }
        setState({ status: 'ready', value: v })
      } catch (error: unknown) {
        if (alive) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
    void load()
    return () => { alive = false }
  }, [remote, roomId, runId, index, file.name])

  const openNative = (): void => {
    if (remote === undefined) return
    void remote.deliverableFileAction({ roomId, runId, index, action: 'open' }).catch(() => undefined)
  }

  const e = ext(file.name)
  const body = ((): ReactElement => {
    if (state.status === 'loading') return <div style={{ padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a929c)' }}>正在加载预览…</div>
    if (state.status === 'error') return <div style={{ padding: 12, fontSize: 12, color: 'var(--dsw-alias-status-error, #c0392b)' }}>{state.message}</div>
    const v = state.value
    if (v.kind === 'missing') return <div style={{ padding: 12, fontSize: 12, color: 'var(--dsw-alias-status-error, #c0392b)' }}>文件已不存在。</div>
    if (v.kind === 'data') {
      if (v.mime.startsWith('image/')) return <img src={v.dataUrl} alt={file.name} style={{ maxWidth: '100%', display: 'block', margin: '12px auto' }} />
      // PDF: the browser's own viewer, same as DSH's document preview.
      return <iframe src={v.dataUrl} title={file.name} style={{ flex: 1, width: '100%', border: 'none' }} />
    }
    if (v.kind === 'binary') return <div style={{ padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a929c)' }}>该类型不支持内嵌预览（{v.size.toLocaleString()} 字节）。请用「打开」。</div>
    if (htmlUrl !== undefined) return <iframe src={htmlUrl} title={file.name} sandbox="" style={{ flex: 1, width: '100%', border: 'none' }} />
    if (e === 'html' || e === 'htm') {
      const url = URL.createObjectURL(new Blob([v.text], { type: 'text/html' }))
      return <iframe src={url} title={file.name} sandbox="" style={{ flex: 1, width: '100%', border: 'none' }} />
    }
    if (e === 'csv') {
      const rows = v.text.split('\n').filter(line => line.trim() !== '').map(line => line.split(','))
      return (
        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
              {rows.map((cells, r) => (
                <tr key={r}>
                  {cells.map((cell, c) => (
                    <td key={c} style={{ border: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)', padding: '4px 8px' }}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    if (e === 'md' || e === 'markdown') return <div style={{ flex: 1, overflow: 'auto', padding: 14 }}><Markdown text={v.text} /></div>
    return <pre style={{ flex: 1, overflow: 'auto', padding: 14, margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--dsw-font-code, ui-monospace, Menlo, monospace)' }}>{v.text}</pre>
  })()

  return (
    <section style={{ flex: '0 0 44%', minWidth: 320, maxWidth: '62%', display: 'flex', flexDirection: 'column', minHeight: 0, borderLeft: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)', background: 'var(--dsw-alias-bg-elevated, #fff)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)' }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600 }}>{file.name}</span>
        <button type="button" onClick={openNative} style={{ height: 24, padding: '0 8px', border: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)', borderRadius: 6, background: 'transparent', fontSize: 11, cursor: 'pointer' }}>用应用打开</button>
        <button type="button" onClick={onClose} aria-label="关闭预览" style={{ width: 24, height: 24, border: 'none', background: 'transparent', fontSize: 16, cursor: 'pointer' }}>×</button>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>{body}</div>
    </section>
  )
}
