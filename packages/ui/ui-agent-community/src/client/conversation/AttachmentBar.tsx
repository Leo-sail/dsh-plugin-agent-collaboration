/**
 * AttachmentBar — the chip row above the input area.
 *
 * It owns no <input type="file">. The picker lives in `ComposerArea`, mounted
 * unconditionally, because this row only exists once `attachments.length > 0` — and a
 * picker that only exists after the first file is a picker that can never add one. Both
 * the row's `+ 添加` button and the composer's `/文件` menu item click that single input.
 */
import type { AttachmentItem } from './types.ts'

interface Props {
  attachments: AttachmentItem[]
  /** Open the composer's file picker. */
  onPick: () => void
  onRemove: (id: string) => void
}

export function AttachmentBar({ attachments, onPick, onRemove }: Props) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 6,
      padding: '8px 16px 0',
      background: 'var(--dsw-alias-bg-base)',
    }}>
      {attachments.map(a => (
        <AttachChip key={a.id} item={a} onRemove={() => onRemove(a.id)} />
      ))}
      <button
        onClick={onPick}
        title="添加文件"
        style={{
          height: 28, padding: '0 8px',
          borderRadius: 'var(--dsw-radius-sm, 4px)',
          border: '0.5px dashed var(--dsw-alias-border-l2)',
          background: 'transparent', color: 'var(--dsw-alias-label-tertiary)',
          fontSize: 12, cursor: 'pointer',
        }}
      >+ 添加</button>
    </div>
  )
}

function AttachChip({ item, onRemove }: { item: AttachmentItem; onRemove: () => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      height: 28, padding: '0 6px',
      borderRadius: 'var(--dsw-radius-sm, 4px)',
      border: '0.5px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-button-floating-fill)',
    }}>
      {item.kind === 'image' && item.dataUrl !== undefined ? (
        <img src={item.dataUrl} alt={item.name} style={{ width: 18, height: 18, borderRadius: 2, objectFit: 'cover' }} />
      ) : (
        <span style={{ fontSize: 14 }}>📎</span>
      )}
      <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.name}
      </span>
      <button
        onClick={onRemove}
        style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1, fontSize: 12 }}
        title="移除"
      >✕</button>
    </div>
  )
}

export { AttachmentBar as default }
