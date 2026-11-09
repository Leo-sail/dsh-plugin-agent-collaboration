/**
 * ApprovalCard — replaces the composer when a pending approval entry exists.
 * Enter = allow once, Esc = reject — but ONLY while this card has focus.
 *
 * ⚠️ The shortcuts used to be bound to `window`. Since the card is mounted for as long as an
 * approval is pending, pressing Enter anywhere in the application — typing in another panel, sending
 * a message, confirming a dialog — silently authorised a privileged tool call. A keyboard shortcut
 * for "grant permission" must never be global; it is bound to the card here, and the card is
 * focusable so the shortcut is still reachable with Tab or a click.
 */
import { useState, useEffect, useCallback } from 'react'
import type { LedgerEntry } from './types.ts'

interface Props {
  entry: LedgerEntry
  onApprove: (callId: string) => void
  onReject: (callId: string) => void
}

export function ApprovalCard({ entry, onApprove, onReject }: Props) {
  const [detailOpen, setDetailOpen] = useState(false)

  const handleApprove = useCallback(() => {
    if (entry.callId) onApprove(entry.callId)
  }, [entry.callId, onApprove])

  const handleReject = useCallback(() => {
    if (entry.callId) onReject(entry.callId)
  }, [entry.callId, onReject])

  // Scoped, not global: the handler lives on the card element (see the file header).
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); handleApprove()
    } else if (e.key === 'Escape') {
      e.preventDefault(); handleReject()
    }
  }, [handleApprove, handleReject])

  return (
    <div
      role="alertdialog"
      aria-label="工具调用等待审批"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
      display: 'flex', flexDirection: 'column', gap: 12,
      padding: '16px 20px',
      borderTop: '0.5px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>
          等待审批
        </span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: '20px' }}>
        工具 <code style={{ fontSize: 12, padding: '1px 4px', borderRadius: 4, background: 'var(--dsw-alias-button-floating-fill)' }}>{entry.toolName ?? entry.name ?? '未知工具'}</code> 请求越权执行
      </div>
      {entry.args !== undefined && entry.args !== '' && (
        <div>
          <button
            onClick={() => setDetailOpen((v: boolean) => !v)}
            style={{ border: 'none', background: 'transparent', padding: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer' }}
          >
            {detailOpen ? '▾ 审批详情' : '▸ 审批详情'}
          </button>
          {detailOpen && (
            <pre style={{
              marginTop: 6, padding: '8px 10px',
              borderRadius: 'var(--dsw-radius-md, 8px)',
              border: '0.5px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)',
              fontSize: 11, lineHeight: '16px', overflowX: 'auto',
              whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
              color: 'var(--dsw-alias-label-primary)',
            }}>
              {entry.args}
            </pre>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={handleReject}
          style={{
            height: 32, padding: '0 14px',
            borderRadius: 'var(--dsw-radius-sm, 4px)',
            border: '0.5px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 13, cursor: 'pointer',
          }}
        >
          拒绝
        </button>
        <button
          onClick={handleApprove}
          style={{
            height: 32, padding: '0 14px',
            borderRadius: 'var(--dsw-radius-sm, 4px)',
            border: 'none',
            background: 'var(--dsw-alias-state-business-primary, #3b82f6)',
            color: '#fff',
            fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >
          允许一次
          <kbd style={{ marginLeft: 6, fontSize: 10, opacity: 0.7, fontFamily: 'monospace' }}>Enter</kbd>
        </button>
      </div>
    </div>
  )
}
