/**
 * DeliverableGroup — the file cards a bot turn declared for the user.
 *
 * The room's equivalent of DSH's delivery cards: one card group under the reply, each
 * file previewable in-panel and openable with the OS application association (or revealed
 * in Finder). Everything here reads from the ledger row's metadata — no file bytes are
 * kept in the transcript; previews are fetched on demand through the host RPC.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { CommunityRemote } from '../community/types.ts'
import type { DeliveredFile } from './types.ts'
import { Markdown } from './Markdown.tsx'

/** Matches DSH's own collapse threshold for delivery cards. */
const COLLAPSED_COUNT = 4

interface FileKind {
  readonly label: string
  readonly bg: string
  readonly fg: string
}

const KIND_BY_EXT: Record<string, FileKind> = {
  md: { label: 'MD', bg: '#e7f0ff', fg: '#1b4fc4' },
  markdown: { label: 'MD', bg: '#e7f0ff', fg: '#1b4fc4' },
  txt: { label: 'TXT', bg: '#eef1f5', fg: '#45505d' },
  pdf: { label: 'PDF', bg: '#ffe9e6', fg: '#b3261e' },
  doc: { label: 'DOC', bg: '#e7efff', fg: '#1b4fc4' },
  docx: { label: 'DOC', bg: '#e7efff', fg: '#1b4fc4' },
  xls: { label: 'XLS', bg: '#e6f6ec', fg: '#156b3a' },
  xlsx: { label: 'XLS', bg: '#e6f6ec', fg: '#156b3a' },
  csv: { label: 'CSV', bg: '#e6f6ec', fg: '#156b3a' },
  ppt: { label: 'PPT', bg: '#fff0e5', fg: '#a34a00' },
  pptx: { label: 'PPT', bg: '#fff0e5', fg: '#a34a00' },
  png: { label: 'IMG', bg: '#f1e8ff', fg: '#5b2bb8' },
  jpg: { label: 'IMG', bg: '#f1e8ff', fg: '#5b2bb8' },
  jpeg: { label: 'IMG', bg: '#f1e8ff', fg: '#5b2bb8' },
  gif: { label: 'IMG', bg: '#f1e8ff', fg: '#5b2bb8' },
  webp: { label: 'IMG', bg: '#f1e8ff', fg: '#5b2bb8' },
  svg: { label: 'SVG', bg: '#f1e8ff', fg: '#5b2bb8' },
  html: { label: 'HTM', bg: '#fff6e0', fg: '#8a5a00' },
  json: { label: 'JSON', bg: '#f0f2f5', fg: '#3d4854' },
  yaml: { label: 'YML', bg: '#f0f2f5', fg: '#3d4854' },
  yml: { label: 'YML', bg: '#f0f2f5', fg: '#3d4854' },
  zip: { label: 'ZIP', bg: '#f0f2f5', fg: '#3d4854' },
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase()
}

function kindOf(name: string): FileKind {
  return KIND_BY_EXT[extensionOf(name)] ?? { label: 'FILE', bg: '#eef1f5', fg: '#45505d' }
}

/** Card subtitle: the model's description, else the upper-cased extension, else 文件. */
function subtitleOf(file: DeliveredFile): string {
  const description = file.description?.trim() ?? ''
  if (description !== '') {
    // DSH drops a trailing parenthetical aside from the description before using it.
    return description.replace(/\s*[（(][^（）()]*[)）]\s*$/u, '').trim() || description
  }
  const ext = extensionOf(file.name)
  return ext === '' ? '文件' : ext.toUpperCase()
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ── icons (inline, so the bundle gains no dependency) ────────────────────────

function ChevronIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ExternalIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.5H2.7A1.2 1.2 0 0 0 1.5 3.7v5.6a1.2 1.2 0 0 0 1.2 1.2h5.6a1.2 1.2 0 0 0 1.2-1.2V7.5M7 1.5h3.5V5M10 2 5.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FolderIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M1.5 3.2a1 1 0 0 1 1-1h2l1 1.2h4a1 1 0 0 1 1 1v4.4a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

// ── the group ────────────────────────────────────────────────────────────────

export interface DeliverableGroupProps {
  readonly files: readonly DeliveredFile[]
  readonly roomId: string
  readonly runId: string
  readonly remote?: CommunityRemote | undefined
}

export function DeliverableGroup({ files, roomId, runId, remote }: DeliverableGroupProps): ReactElement | null {
  const [expanded, setExpanded] = useState(files.length <= COLLAPSED_COUNT)
  const [previewIndex, setPreviewIndex] = useState<number | undefined>(undefined)
  if (files.length === 0) return null
  const shown = expanded ? files : files.slice(0, COLLAPSED_COUNT)
  const hidden = files.length - shown.length
  return (
    <div
      data-chat-flow-kind="deliverable"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{
        display: 'grid',
        gridTemplateColumns: shown.length === 1 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))',
        gap: 8,
      }}>
        {shown.map((file, index) => (
          <DeliverableCard
            key={`${file.path}:${index}`}
            file={file}
            onPreview={() => setPreviewIndex(index)}
            roomId={roomId}
            runId={runId}
            index={index}
            remote={remote}
          />
        ))}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{
            alignSelf: 'flex-start',
            border: 'none',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary, #5b6470)',
            fontSize: 12,
            cursor: 'pointer',
            padding: '2px 2px',
          }}
        >
          还有 {hidden} 个文件
        </button>
      )}
      {previewIndex !== undefined && files[previewIndex] !== undefined && (
        <DeliverablePreviewDialog
          file={files[previewIndex]!}
          roomId={roomId}
          runId={runId}
          index={previewIndex}
          remote={remote}
          onClose={() => setPreviewIndex(undefined)}
        />
      )}
    </div>
  )
}

// ── one card ─────────────────────────────────────────────────────────────────

interface AppItem { readonly id: string; readonly name: string; readonly default: boolean; readonly icon?: string | null }

function DeliverableCard({ file, onPreview, roomId, runId, index, remote }: {
  readonly file: DeliveredFile
  readonly onPreview: () => void
  readonly roomId: string
  readonly runId: string
  readonly index: number
  readonly remote?: CommunityRemote | undefined
}): ReactElement {
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [apps, setApps] = useState<AppItem[] | undefined>(undefined)
  const [appsError, setAppsError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const kind = kindOf(file.name)
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => () => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
  }, [])

  /** Failures stay until the next attempt; successes fade after the native five seconds. */
  const flash = (kind: 'ok' | 'error', text: string): void => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    setNotice({ kind, text })
    if (kind === 'ok') {
      noticeTimer.current = setTimeout(() => setNotice(undefined), 5_000)
    }
  }

  // Click outside closes the menu; Esc closes it too.
  useEffect(() => {
    if (!menuOpen) return undefined
    const onPointer = (event: MouseEvent): void => {
      if (cardRef.current !== null && !cardRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const openWith = async (application?: string): Promise<void> => {
    if (remote === undefined) return
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await remote.deliverableFileAction({
        roomId, runId, index, action: 'open',
        ...(application === undefined ? {} : { application }),
      })
      if (!result.ok) throw new Error(result.error)
      setMenuOpen(false)
      flash('ok', '已打开')
    } catch (error: unknown) {
      setNotice({ kind: 'error', text: describeError(error) })
    } finally {
      setBusy(false)
    }
  }

  const reveal = async (): Promise<void> => {
    if (remote === undefined) return
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await remote.deliverableFileAction({ roomId, runId, index, action: 'reveal' })
      if (!result.ok) throw new Error(result.error)
      setMenuOpen(false)
      flash('ok', '已显示位置')
    } catch (error: unknown) {
      setNotice({ kind: 'error', text: describeError(error) })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Click behaviour, matching DSH's delivery cards: open the file in the right
   * Sidebar's document preview (Office/Excel included, through the host renderers).
   * The in-panel dialog stays as the fallback for deployments without a Session or
   * without the right Sidebar.
   */
  const openPreview = (): void => {
    const pending = remote?.openFilePreview(file.path)
    if (pending === undefined) {
      onPreview()
      return
    }
    void pending.then((opened) => { if (!opened) onPreview() }).catch(() => onPreview())
  }

  const toggleMenu = async (): Promise<void> => {
    const next = !menuOpen
    setMenuOpen(next)
    if (!next || apps !== undefined || remote === undefined) return
    try {
      const result = await remote.deliverableFileAction({ roomId, runId, index, action: 'applications' })
      if (!result.ok) throw new Error(result.error)
      setApps((result.applications ?? []).map(app => ({
        id: app.id, name: app.name, default: app.default, icon: app.icon,
      })))
      setAppsError(undefined)
    } catch (error: unknown) {
      // Surface the reason: silently printing a generic line is what made the first
      // report impossible to act on.
      setAppsError(`无法获取应用列表：${describeError(error)}`)
    }
  }

  return (
    <div
      ref={cardRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
        padding: '8px 8px 8px 10px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)',
        background: 'var(--dsw-alias-bg-elevated, #ffffff)',
        boxShadow: hover ? '0 2px 10px rgba(20, 30, 50, 0.08)' : 'none',
        transition: 'box-shadow 120ms ease',
      }}
    >
      {/* File-type tile */}
      <span style={{
        flex: '0 0 auto',
        width: 30,
        height: 30,
        borderRadius: 8,
        background: kind.bg,
        color: kind.fg,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.3,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {kind.label}
      </span>

      {/* Name + subtitle; the whole block is the preview button. */}
      <button
        type="button"
        onClick={openPreview}
        title={`预览 ${file.name}\n${file.path}`}
        aria-label={`预览 ${file.name}`}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 2,
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
        }}
      >
        <span style={{
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--dsw-alias-label-primary, #1b2129)',
        }}>
          {file.name}
        </span>
        <span style={{
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 11,
          color: 'var(--dsw-alias-label-tertiary, #8a929c)',
        }}>
          {hover ? '预览文件' : subtitleOf(file)}
        </span>
      </button>

      {/* Open / more-ways-to-open */}
      {remote !== undefined && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 0, flex: '0 0 auto' }}>
          <button
            type="button"
            onClick={() => void openWith()}
            disabled={busy}
            title="用默认应用打开"
            aria-label={`用默认应用打开 ${file.name}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              height: 24,
              padding: '0 7px',
              border: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)',
              borderRight: 'none',
              borderRadius: '6px 0 0 6px',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary, #5b6470)',
              fontSize: 11,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            <ExternalIcon />
            打开
          </button>
          <button
            type="button"
            onClick={() => void toggleMenu()}
            disabled={busy}
            title="更多打开方式"
            aria-label="更多打开方式"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 24,
              border: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)',
              borderRadius: '0 6px 6px 0',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary, #5b6470)',
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            <ChevronIcon />
          </button>
        </span>
      )}

      {menuOpen && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 6,
            top: 'calc(100% + 4px)',
            zIndex: 40,
            minWidth: 190,
            maxHeight: 260,
            overflowY: 'auto',
            padding: 4,
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)',
            background: 'var(--dsw-alias-bg-elevated, #ffffff)',
            boxShadow: '0 8px 24px rgba(20, 30, 50, 0.18)',
          }}
        >
          {apps === undefined && appsError === undefined && (
            <div style={menuNoteStyle}>正在读取应用…</div>
          )}
          {appsError !== undefined && (
            <div style={{ ...menuNoteStyle, color: 'var(--dsw-alias-status-error, #c0392b)' }}>{appsError}</div>
          )}
          {(apps ?? []).map((app) => (
            <button
              key={app.id}
              type="button"
              role="menuitem"
              onClick={() => void openWith(app.id)}
              style={menuItemStyle}
            >
              {app.icon !== undefined && app.icon !== null && (
                <img src={app.icon} alt="" width={14} height={14} style={{ marginRight: 6 }} />
              )}
              {app.default ? `${app.name}（默认）` : app.name}
            </button>
          ))}
          <div style={{ height: 1, margin: '4px 6px', background: 'var(--dsw-alias-border-secondary, #e4e7eb)' }} />
          <button type="button" role="menuitem" onClick={() => void reveal()} style={menuItemStyle}>
            <FolderIcon />
            <span style={{ marginLeft: 6 }}>显示文件位置</span>
          </button>
        </div>
      )}

      {notice !== undefined && (
        <div
          title={notice.text}
          style={{
            position: 'absolute',
            left: 10,
            bottom: -18,
            maxWidth: '90%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 11,
            color: notice.kind === 'ok'
              ? 'var(--dsw-alias-status-success, #1f7a45)'
              : 'var(--dsw-alias-status-error, #c0392b)',
          }}
        >
          {notice.text}
        </div>
      )}
    </div>
  )
}

const menuItemStyle = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  padding: '6px 8px',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary, #1b2129)',
  fontSize: 12,
  textAlign: 'left' as const,
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
}

const menuNoteStyle = {
  padding: '6px 8px',
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary, #8a929c)',
}

// ── preview dialog ───────────────────────────────────────────────────────────

function DeliverablePreviewDialog({ file, roomId, runId, index, remote, onClose }: {
  readonly file: DeliveredFile
  readonly roomId: string
  readonly runId: string
  readonly index: number
  readonly remote?: CommunityRemote | undefined
  readonly onClose: () => void
}): ReactElement {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; value: Awaited<ReturnType<CommunityRemote['readDeliverablePreview']>> }
    | { status: 'error'; message: string }
  >({ status: 'loading' })
  const [extra, setExtra] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      if (remote === undefined) {
        setState({ status: 'error', message: '当前宿主不支持内嵌预览，请用应用打开。' })
        return
      }
      try {
        const value = await remote.readDeliverablePreview({ roomId, runId, index })
        if (alive) {
          setState({ status: 'ready', value })
          setTruncated(value.kind === 'text' && value.truncated)
        }
      } catch (error: unknown) {
        if (alive) setState({ status: 'error', message: describeError(error) })
      }
    }
    void load()
    return () => { alive = false }
  }, [remote, roomId, runId, index])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** Append the next text window; the host pages by line offset, so nothing is re-read. */
  const loadMore = async (): Promise<void> => {
    if (remote === undefined || state.status !== 'ready' || state.value.kind !== 'text') return
    setLoadingMore(true)
    try {
      const offset = (state.value.text + extra).split('\n').length
      const next = await remote.readDeliverablePreview({ roomId, runId, index, offset })
      if (next.kind === 'text') {
        setExtra(previous => previous + next.text)
        setTruncated(next.truncated)
      } else {
        setTruncated(false)
      }
    } catch {
      // Keep what is already on screen; the user can retry or open the file natively.
    } finally {
      setLoadingMore(false)
    }
  }

  const openExternally = (): void => {
    if (remote === undefined) return
    void remote.openWorkspacePath({ path: file.path }).catch(() => undefined)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${file.name}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(12, 16, 22, 0.42)',
      }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div style={{
        width: 'min(780px, 88vw)',
        maxHeight: '82vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: 14,
        background: 'var(--dsw-alias-bg-elevated, #ffffff)',
        boxShadow: '0 24px 60px rgba(10, 16, 26, 0.32)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderBottom: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)',
        }}>
          <span style={{
            maxWidth: '60%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--dsw-alias-label-primary, #1b2129)',
          }}>
            {file.name}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={openExternally}
            style={{
              height: 24,
              padding: '0 8px',
              border: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary, #5b6470)',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            用应用打开
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭预览"
            style={{
              height: 24,
              width: 24,
              border: 'none',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary, #5b6470)',
              fontSize: 16,
              lineHeight: '24px',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px' }}>
          {state.status === 'loading' && (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a929c)' }}>正在加载预览…</div>
          )}
          {state.status === 'error' && (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-status-error, #c0392b)' }}>{state.message}</div>
          )}
          {state.status === 'ready' && (
            <>
              <PreviewBody
                value={state.value}
                name={file.name}
                text={state.value.kind === 'text' ? state.value.text + extra : ''}
              />
              {state.value.kind === 'text' && truncated && (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  style={{
                    marginTop: 10,
                    height: 26,
                    padding: '0 12px',
                    border: '1px solid var(--dsw-alias-border-secondary, #e4e7eb)',
                    borderRadius: 6,
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary, #5b6470)',
                    fontSize: 11,
                    cursor: loadingMore ? 'default' : 'pointer',
                  }}
                >
                  {loadingMore ? '加载中…' : '加载更多'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PreviewBody({ value, name, text }: {
  readonly value: Awaited<ReturnType<CommunityRemote['readDeliverablePreview']>>
  readonly name: string
  /** Accumulated text windows (first page + any loaded pages). */
  readonly text: string
}): ReactElement {
  if (value.kind === 'missing') {
    return <div style={{ fontSize: 12, color: 'var(--dsw-alias-status-error, #c0392b)' }}>文件已不存在，或在当前主机上不可读。</div>
  }
  if (value.kind === 'binary') {
    return (
      <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a929c)' }}>
        该类型不支持内嵌预览（{value.size.toLocaleString()} 字节）。请用「用应用打开」。
      </div>
    )
  }
  if (value.kind === 'data') {
    if (value.mime.startsWith('image/')) {
      return <img src={value.dataUrl} alt={name} style={{ maxWidth: '100%', borderRadius: 8 }} />
    }
    return (
      <iframe
        src={value.dataUrl}
        title={name}
        style={{ width: '100%', height: '60vh', border: 'none', borderRadius: 8 }}
      />
    )
  }
  const ext = extensionOf(name)
  if (ext === 'md' || ext === 'markdown') {
    return <Markdown text={text} />
  }
  return (
    <pre style={{
      margin: 0,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      fontSize: 12,
      lineHeight: 1.55,
      fontFamily: 'var(--dsw-font-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
      color: 'var(--dsw-alias-label-primary, #1b2129)',
    }}>
      {text}
    </pre>
  )
}
