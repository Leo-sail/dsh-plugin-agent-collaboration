/**
 * RoomSettingsDialog — 群聊设置: rename a group, edit its members, and flip the room's two
 * behaviour switches.
 *
 * The dialog owns its edit buffer (name, members, mention-only, paused) and the save round-trip;
 * the shell only decides *when* it is on screen and re-fetches the snapshot once it saved. That
 * split is why the shell passes `room` in and never reads the fields back: a cancelled edit must
 * leave nothing behind, and mounting the component with `room.name` as the initial state is what
 * guarantees it.
 *
 * The markup is the native `NativeDialog` chrome. It used to hand-roll the mask (`z-index:1050`,
 * its own blur), the header and the × button; Escape, `role="dialog"`/`aria-modal`, the focus
 * handling and the elevation token all come from DSH's `Modal` now. The form, its field order, its
 * validation and every user-visible string are unchanged.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { BotId, BotIdentity, BotRoom } from '@dsh-plugin/agent-community'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { NativeDialog } from '../conversation/NativeDialog.tsx'
import { css } from '../styles.ts'
import type { CommunityRemote } from './types.ts'
import { describe } from './types.ts'

export interface RoomSettingsDialogProps {
  /** The room being edited; also the source of the fields' initial values. */
  room: BotRoom
  /** The live bot directory the member checkboxes are drawn from. */
  bots: BotIdentity[]
  /** The shell's shared busy flag: a save in flight holds every dialog's primary button. */
  busy: boolean
  setBusy: (busy: boolean) => void
  remote: CommunityRemote
  /** Cancel / close: the shell drops `editingRoom` and unmounts this component. */
  onClose: () => void
  /** Saved: the shell closes the dialog and reloads the snapshot. */
  onSaved: () => void
}

export function RoomSettingsDialog({
  room, bots, busy, setBusy, remote, onClose, onSaved,
}: RoomSettingsDialogProps) {
  const [name, setName] = useState(room.name)
  const [members, setMembers] = useState<BotId[]>([...room.memberIds] as BotId[])
  const [mentionOnly, setMentionOnly] = useState(room.mentionOnly)
  const [paused, setPaused] = useState(room.paused ?? false)
  const [error, setError] = useState<string>()

  const toggleMember = (id: BotId) => {
    setMembers(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id])
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await remote.updateRoom({
        id: room.id,
        name: name.trim(),
        memberIds: members,
        mentionOnly,
        paused,
      })
      onSaved()
    } catch (e) {
      setError(describe(e))
    }
    setBusy(false)
  }

  return (
    <NativeDialog
      open
      onClose={onClose}
      title="群聊设置"
      closeLabel="关闭"
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="outline" onClick={onClose}>取消</Button>
          {/* `type`/`form` keep the native submit path: Enter in the name field still saves. */}
          <Button variant="primary" type="submit" form="room-settings-form" disabled={busy}>{busy ? '保存中…' : '保存'}</Button>
        </div>
      )}
    >
      <form id="room-settings-form" className={css.formLegacy} onSubmit={(e) => void handleSave(e)}>
        <label>群聊名称 <input type="text" value={name} onChange={e => setName(e.target.value)} required /></label>
        <fieldset className={css.members}>
          <legend>成员</legend>
          {bots.length === 0
            ? <p className={css.formHint} style={{ margin: '4px 0' }}>还没有 Bot。</p>
            : bots.map(bot => (
              <label key={bot.id} className={css.check}>
                <input type="checkbox" checked={members.includes(bot.id as BotId)} onChange={() => toggleMember(bot.id as BotId)} />
                {bot.avatar.seed} {bot.name}
                <small>{bot.description}</small>
              </label>
            ))}
        </fieldset>
        <label className={css.check}>
          <input type="checkbox" checked={mentionOnly} onChange={e => setMentionOnly(e.target.checked)} />
          仅在被 @ 时响应（所有成员）
        </label>
        <label className={css.check}>
          <input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} />
          暂停（不创建新运行）
        </label>
      </form>
      {error !== undefined && (
        <div className={css.error} style={{ marginTop: 12 }}>{error}</div>
      )}
    </NativeDialog>
  )
}
