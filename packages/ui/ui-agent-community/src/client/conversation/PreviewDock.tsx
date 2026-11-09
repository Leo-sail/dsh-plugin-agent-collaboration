/** Right-hand preview dock inside the plugin page: conversation stays left, document right. */
import { useEffect, useState, type ReactElement } from 'react'
import type { CommunityRemote } from '../community/types.ts'
import { loadDeliverablePreview } from '../preview/load.ts'
import { PreviewContent } from '../preview/PreviewContent.tsx'
import type { PreviewSource } from '../preview/types.ts'
import type { DeliveredFile } from './types.ts'

export interface PreviewRequest {
  readonly roomId: string
  readonly runId: string
  readonly index: number
  readonly file: DeliveredFile
}

export const PREVIEW_EVENT = 'agent-community:preview'

/** One preview surface, chosen by the file's type. */
export function PreviewDock({ requests, active, remote, onSelect, onCloseTab, onCloseAll }: {
  /** Every file opened in this dock; the header tabs switch between them (DSH parity). */
  readonly requests: ReadonlyArray<PreviewRequest>
  readonly active: number
  readonly remote?: CommunityRemote | undefined
  readonly onSelect: (index: number) => void
  /** Close one tab (its own ×). */
  readonly onCloseTab: (index: number) => void
  /** Rightmost ×: close every open preview. */
  readonly onCloseAll: () => void
}): ReactElement {
  const request = requests[Math.min(Math.max(active, 0), requests.length - 1)]!
  const { file, roomId, runId, index } = request
  const [source, setSource] = useState<PreviewSource>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    setSource({ kind: 'loading' })
    if (remote === undefined) {
      setSource({ kind: 'error', message: '当前宿主不支持预览。' })
      return
    }
    void loadDeliverablePreview(remote, { roomId, runId, index, file }).then((next) => {
      if (alive) setSource(next)
    })
    return () => { alive = false }
  }, [remote, roomId, runId, index, file])

  const openNative = (): void => {
    if (remote === undefined) return
    void remote.deliverableFileAction({ roomId, runId, index, action: 'open' }).catch(() => undefined)
  }

  return (
    <section style={{ flex: '0 0 44%', minWidth: 320, maxWidth: '62%', display: 'flex', flexDirection: 'column', minHeight: 0, borderLeft: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)', background: 'var(--dsw-alias-bg-elevated, #fff)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)', overflowX: 'auto' }}>
        {requests.map((item, i) => (
          <button
            key={`${item.roomId}:${item.runId}:${item.index}`}
            type="button"
            onClick={() => onSelect(i)}
            title={item.file.path}
            style={{
              flex: '0 0 auto', maxWidth: 180, height: 26, padding: '0 10px', borderRadius: 6,
              border: '1px solid ' + (i === active ? 'var(--dsw-alias-border-strong, #b8c0cc)' : 'var(--dsw-alias-border-secondary, #e4e7eb)'),
              background: i === active ? 'var(--dsw-alias-bg-secondary, #f2f4f7)' : 'transparent',
              color: 'var(--dsw-alias-label-primary, #1b2129)', fontSize: 12, cursor: 'pointer',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.file.name}</span>
            <span
              role="button"
              aria-label={`关闭 ${item.file.name}`}
              onClick={(event) => { event.stopPropagation(); onCloseTab(i) }}
              style={{ marginLeft: 6, color: 'var(--dsw-alias-label-tertiary, #8a929c)', cursor: 'pointer' }}
            >
              ×
            </span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={openNative} style={{ flex: '0 0 auto', whiteSpace: 'nowrap', height: 24, padding: '0 8px', border: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)', borderRadius: 6, background: 'transparent', fontSize: 11, lineHeight: '22px', cursor: 'pointer' }}>用应用打开</button>
        <button type="button" onClick={onCloseAll} aria-label="关闭全部预览" title="关闭全部预览" style={{ width: 24, height: 24, border: 'none', background: 'transparent', fontSize: 16, cursor: 'pointer' }}>×</button>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <PreviewContent source={source} name={file.name} />
      </div>
    </section>
  )
}
