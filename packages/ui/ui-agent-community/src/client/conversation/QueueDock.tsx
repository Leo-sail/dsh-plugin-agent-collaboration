/**
 * QueueDock — shows queued messages below the composer when a run is in progress.
 * Each entry can be edited, deleted, or steer-sent.
 */
import { useState } from 'react'
import type { InFlightMessage } from './types.ts'

interface Props {
  queue: InFlightMessage[]
  onEdit: (id: string, text: string) => void
  onRemove: (id: string) => void
  onSteer: (id: string) => void
}

export function QueueDock({ queue, onEdit, onRemove, onSteer }: Props) {
  if (queue.length === 0) return null
  return (
    <div style={{
      borderTop: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-base)',
    }}>
      {/* Header */}
      <div style={{
        height: 36, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 16px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
      }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' }}>
          {queue.length} 条排队消息
        </span>
      </div>
      {/* Queue rows */}
      <div style={{ maxHeight: 180, overflowY: 'auto' }}>
        {queue.map((item, idx) => (
          <QueueRow
            key={item.id}
            item={item}
            showDivider={idx > 0}
            onEdit={onEdit}
            onRemove={onRemove}
            onSteer={onSteer}
          />
        ))}
      </div>
    </div>
  )
}

function QueueRow({ item, showDivider, onEdit, onRemove, onSteer }: {
  item: InFlightMessage
  showDivider: boolean
  onEdit: (id: string, text: string) => void
  onRemove: (id: string) => void
  onSteer: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)

  return (
    <div style={{
      minHeight: 36, display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '6px 12px',
      borderTop: showDivider ? '0.5px solid var(--dsw-alias-border-l1)' : 'none',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onEdit(item.id, draft); setEditing(false) }
              if (e.key === 'Escape') { setEditing(false); setDraft(item.text) }
            }}
            style={{
              width: '100%', minHeight: 28, maxHeight: 127,
              resize: 'none', fontSize: 13, lineHeight: '20px',
              padding: '4px 6px',
              borderRadius: 'var(--dsw-radius-sm, 4px)',
              border: '1px solid var(--dsw-alias-state-business-primary, #3b82f6)',
              background: 'var(--dsw-alias-bg-base)',
              color: 'var(--dsw-alias-label-primary)',
              outline: 'none',
            }}
            autoFocus
          />
        ) : (
          <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)', lineHeight: '20px', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.text || <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontStyle: 'italic' }}>发送中…</span>}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
        {editing ? (
          <>
            <QBtn title="保存" onClick={() => { onEdit(item.id, draft); setEditing(false) }}>✓</QBtn>
            <QBtn title="取消" onClick={() => { setEditing(false); setDraft(item.text) }}>✕</QBtn>
          </>
        ) : (
          <>
            <QBtn title="编辑" onClick={() => setEditing(true)}>✎</QBtn>
            <QBtn title="插话发送" onClick={() => onSteer(item.id)}>⇈</QBtn>
            <QBtn title="删除" onClick={() => onRemove(item.id)}>🗑</QBtn>
          </>
        )}
      </div>
    </div>
  )
}

function QBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 28, height: 28, borderRadius: '50%',
        border: 'none', background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'pointer', fontSize: 12,
        display: 'grid', placeItems: 'center',
      }}
    >
      {children}
    </button>
  )
}
