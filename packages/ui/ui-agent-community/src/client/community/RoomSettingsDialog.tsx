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

const blockStyle = {
  display: 'grid',
  gap: 6,
  paddingTop: 12,
  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
} as const

const blockTitleStyle = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 13,
  fontWeight: 500,
} as const

const cardStyle = {
  display: 'grid',
  gap: 2,
  padding: '8px 10px',
  border: '0.5px solid var(--dsw-alias-border-l3)',
  borderRadius: 'var(--dsw-radius-md, 8px)',
  background: 'var(--dsw-alias-bg-layer-1)',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
} as const

const mutedLineStyle = {
  margin: 0,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: '18px',
} as const

export function RoomSettingsDialog({
  room, bots, busy, setBusy, remote, onClose, onSaved,
}: RoomSettingsDialogProps) {
  const [name, setName] = useState(room.name)
  const [members, setMembers] = useState<BotId[]>([...room.memberIds] as BotId[])
  const [mentionOnly, setMentionOnly] = useState(room.mentionOnly)
  const [paused, setPaused] = useState(room.paused ?? false)
  const [error, setError] = useState<string>()

  const [experienceText, setExperienceText] = useState(room.experienceCard?.text ?? '')
  const [experienceSource, setExperienceSource] = useState<'auto' | 'user' | undefined>(room.experienceCard?.source)
  const [experienceError, setExperienceError] = useState<string>()
  const [experienceBusy, setExperienceBusy] = useState(false)
  const adherence = room.taskState?.adherence

  const toggleMember = (id: BotId) => {
    setMembers(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id])
  }

  async function saveExperience(): Promise<void> {
    if (experienceBusy) return
    setExperienceBusy(true)
    setExperienceError(undefined)
    try {
      const result = await remote.updateRoomExperience({ roomId: room.id, text: experienceText })
      if (!result.ok) {
        setExperienceError(result.reason ?? '保存失败')
        return
      }
      setExperienceSource('user')
    } catch (e) {
      setExperienceError(describe(e))
    } finally {
      setExperienceBusy(false)
    }
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
                <span>{bot.name}</span>
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

      {/* ── 协作遵从度 (P2) — read-only ─────────────────────────────────────────────
          A scorecard derived from the persisted board: how much was actually assigned vs
          finished, whether the finish passed the evidence gate, and why not. */}
      {adherence !== undefined && (
        <section style={blockStyle} data-task-adherence="">
          <h4 style={blockTitleStyle}>协作遵从度</h4>
          <div style={cardStyle}>
            <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>
              {adherence.score}/100 · 完成 {adherence.done}/{adherence.assigned}
              {adherence.verifiedFinish ? ' · 证据门通过' : adherence.bypassed ? ' · 未验证放行' : ''}
            </span>
            {adherence.issues.length === 0
              ? <span style={mutedLineStyle}>没有发现未完成或未验证项。</span>
              : <span style={mutedLineStyle}>{adherence.issues.join('；')}</span>}
          </div>
        </section>
      )}

      {/* ── 群经验卡 — ONE editable memory card ─────────────────────────────────────
          The host auto-seeds this from verified group finishes; after the user saves it,
          later finishes must not overwrite the text. Empty text clears the block. */}
      <section style={blockStyle} data-experience-card="">
        <h4 style={blockTitleStyle}>群经验卡</h4>
        <p style={mutedLineStyle}>
          本群的任务经验，只影响这个群，并会进入 Bot 上下文。可手动修改；保存后后续自动提炼不会覆盖你的版本。
        </p>
        <textarea
          data-experience-input=""
          value={experienceText}
          onChange={e => setExperienceText(e.target.value)}
          rows={6}
          maxLength={3000}
          placeholder="还没有经验卡。完成群任务后会自动生成，也可以在这里直接写。"
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'vertical',
            padding: '8px 10px', borderRadius: 'var(--dsw-radius-md, 8px)',
            border: '0.5px solid var(--dsw-alias-border-l3)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            font: 'inherit', fontSize: 12, lineHeight: '18px',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>
          <span style={{ flex: 1 }}>
            {experienceSource === 'user' ? '已手动编辑' : experienceSource === 'auto' ? '自动生成（可修改）' : '暂无（可手动填写）'}
            {' · '}{[...experienceText].length}/3000
          </span>
          <Button variant="outline" type="button" disabled={experienceBusy} onClick={() => { void saveExperience() }}>
            {experienceBusy ? '保存中…' : '保存经验卡'}
          </Button>
        </div>
        {experienceError !== undefined && <p style={mutedLineStyle} role="alert">{experienceError}</p>}
      </section>

      {error !== undefined && (
        <div className={css.error} style={{ marginTop: 12 }}>{error}</div>
      )}
    </NativeDialog>
  )
}
