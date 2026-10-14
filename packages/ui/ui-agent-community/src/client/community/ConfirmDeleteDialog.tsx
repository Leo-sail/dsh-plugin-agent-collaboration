/**
 * ConfirmDeleteDialog — the "really delete this bot / group?" gate.
 *
 * This used to be a hand-rolled `position:fixed` mask plus a panel div, which meant it had no
 * Escape handling, no close button, no `role="dialog"` and a mask whose z-index (1100) had to be
 * kept above every other overlay by hand. It now rides `NativeDialog`, so the mask, the blur, the
 * elevation, Escape, the mask click and the `aria-label` all come from DSH's own `Modal`.
 *
 * The shell keeps the decision: it renders this only while a delete target is armed and passes
 * `onConfirm`/`onCancel`, so `busy` (and the "删除中…" label) still belongs to the page.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { NativeDialog } from '../conversation/NativeDialog.tsx'

/** What the shell armed for deletion. */
export interface ConfirmDeleteTarget {
  readonly type: 'bot' | 'room'
  readonly id: string
  readonly name: string
}

export interface ConfirmDeleteDialogProps {
  target: ConfirmDeleteTarget
  /** A delete is already in flight; both buttons are held until it settles. */
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDeleteDialog({ target, busy, onCancel, onConfirm }: ConfirmDeleteDialogProps) {
  return (
    <NativeDialog
      open
      onClose={onCancel}
      title={`删除${target.type === 'bot' ? ' Bot' : '群聊'}`}
      closeLabel="关闭"
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>{busy ? '删除中…' : '删除'}</Button>
        </div>
      )}
    >
      <p style={{ margin: 0, fontSize: 14, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 }}>
        确认在本机删除「{target.name}」？此操作不可撤销。
      </p>
    </NativeDialog>
  )
}
