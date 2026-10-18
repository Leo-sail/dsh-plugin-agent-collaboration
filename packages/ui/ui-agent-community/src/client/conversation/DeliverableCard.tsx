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
import { PREVIEW_EVENT } from './PreviewDock.tsx'

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
    </div>
  )
}

// ── one card ─────────────────────────────────────────────────────────────────

interface AppItem { readonly id: string; readonly name: string; readonly default: boolean; readonly icon?: string | null }

function DeliverableCard({ file, roomId, runId, index, remote }: {
  readonly file: DeliveredFile
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
    // The preview docks INSIDE the plugin page as a split right column (the DSH right
    // Sidebar only exists while the main Conversation surface is mounted, and this panel
    // replaces that surface).
    window.dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: { roomId, runId, index, file } }))
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
