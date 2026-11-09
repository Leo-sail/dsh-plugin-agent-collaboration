/**
 * RoomSettingsDialog — 群聊设置: rename a group, edit its members, and flip the room's
 * behaviour switches (mention-only, paused, S0-3 admission).
 *
 * The dialog owns its edit buffer (name, members, mention-only, paused, admission) and the save
 * round-trip; the shell only decides *when* it is on screen and re-fetches the snapshot once it
 * saved. That split is why the shell passes `room` in and never reads the fields back: a cancelled
 * edit must leave nothing behind, and mounting the component with `room.name` as the initial state
 * is what guarantees it.
 *
 * The markup is the native `NativeDialog` chrome. It used to hand-roll the mask (`z-index:1050`,
 * its own blur), the header and the × button; Escape, `role="dialog"`/`aria-modal`, the focus
 * handling and the elevation token all come from DSH's `Modal` now. The form, its field order, its
 * validation and every user-visible string are unchanged.
 */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { AdmissionMode, BotId, BotIdentity, BotRoom, SpeculationMode } from '@dsh-plugin-agent-community/agent-community'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { NativeDialog } from '../conversation/NativeDialog.tsx'
import { css } from '../styles.ts'
import type { CommunityRemote } from './types.ts'
import { describe } from './types.ts'
import { downloadTextFile } from './download.ts'

export interface RoomSettingsDialogProps {
  /** The room being edited; also the source of the fields' initial values. */
  room: BotRoom
  /** Deployment default for rooms that have no explicit admission setting. */
  defaultAdmission?: AdmissionMode | undefined
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

/** P4 record formats the host can export (the RPC's own union). */
type LedgerExportFormat = 'json' | 'jsonl' | 'markdown' | 'transcript'

/**
 * P5-2: the host's per-room knowledge cap, mirrored only for the live counter.
 *
 * The HOST is the authority (it refuses an over-long write with a Chinese reason), so the
 * textarea deliberately has no `maxLength`: typing past the cap must show the host's refusal,
 * not silently swallow the user's keystrokes. The counter turns red past the cap instead.
 */
const KNOWLEDGE_MAX_CHARS = 65536

/** What a browser should treat each exported record as. */
const EXPORT_MIME: Readonly<Record<LedgerExportFormat, string>> = {
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  markdown: 'text/markdown;charset=utf-8',
  transcript: 'text/plain;charset=utf-8',
}

/** Used only when the host does not propose a filename (an older host may omit it). */
const EXPORT_FALLBACK_NAME: Readonly<Record<LedgerExportFormat, string>> = {
  json: 'ledger.json',
  jsonl: 'ledger.jsonl',
  markdown: 'ledger.md',
  transcript: 'ledger.txt',
}

/** The four download buttons, in the order a user is likely to want them. */
const EXPORT_BUTTONS: ReadonlyArray<{ readonly format: LedgerExportFormat; readonly label: string }> = [
  { format: 'json', label: 'JSON 文件' },
  { format: 'jsonl', label: '逐行 JSON 文件' },
  { format: 'markdown', label: 'Markdown 文档' },
  { format: 'transcript', label: '纯文本对话' },
]

export function RoomSettingsDialog({
  room, defaultAdmission = 'legacy', bots, busy, setBusy, remote, onClose, onSaved,
}: RoomSettingsDialogProps) {
  const [name, setName] = useState(room.name)
  const [members, setMembers] = useState<BotId[]>([...room.memberIds] as BotId[])
  const [mentionOnly, setMentionOnly] = useState(room.mentionOnly)
  const [paused, setPaused] = useState(room.paused ?? false)
  /** S0-3: absent on old rooms and for `legacy`; the select edits it. */
  const [admissionMode, setAdmissionMode] = useState<AdmissionMode>(room.admission?.mode ?? defaultAdmission)
  /** S2-4: off/observe/on; absent = off. The experiment is bounded by the host's daily budget. */
  const [speculationMode, setSpeculationMode] = useState<SpeculationMode>(room.speculation?.mode ?? 'off')
  const [error, setError] = useState<string>()

  const [experienceText, setExperienceText] = useState(room.experienceCard?.text ?? '')
  const [experienceSource, setExperienceSource] = useState<'auto' | 'user' | undefined>(room.experienceCard?.source)
  const [experienceError, setExperienceError] = useState<string>()
  const [experienceBusy, setExperienceBusy] = useState(false)
  const [experienceCompacting, setExperienceCompacting] = useState(false)
  const [experienceNotice, setExperienceNotice] = useState<string>()

  /**
   * P5-2: the room's "knowledge" document — user-written Markdown the host injects into the
   * next turn's bot prompt as `[本房间知识]`. It is NOT the bot's accumulated memory: it is a
   * user-maintained document, read once when this dialog opens, edited locally, and written back
   * by its own 保存知识 / 清空知识 buttons — deliberately independent of the settings form's 保存.
   */
  const [knowledgeText, setKnowledgeText] = useState('')
  const [knowledgeLoading, setKnowledgeLoading] = useState(true)
  const [knowledgeBusy, setKnowledgeBusy] = useState(false)
  const [knowledgeError, setKnowledgeError] = useState<string>()
  const [knowledgeNotice, setKnowledgeNotice] = useState<string>()
  /** Invalidates an in-flight knowledge read when the room changes or the dialog closes. */
  const knowledgeSeqRef = useRef(0)
  const [addOpen, setAddOpen] = useState(false)
  /** The export format whose round-trip is in flight, if any. */
  const [exportFormat, setExportFormat] = useState<LedgerExportFormat>()
  const [exportError, setExportError] = useState<string>()
  const [exportNotice, setExportNotice] = useState<string>()
  const [addSelected, setAddSelected] = useState<BotId[]>([])
  const [memberBusy, setMemberBusy] = useState(false)
  const [memberError, setMemberError] = useState<string>()
  const [removeTarget, setRemoveTarget] = useState<string>()
  const adherence = room.taskState?.adherence
  const currentMembers = bots.filter(bot => members.includes(bot.id as BotId))
  const availableBots = bots.filter(bot => !members.includes(bot.id as BotId))

  // Read the knowledge document once per room, and again on 刷新. `room.id` is the only input:
  // the shell mounts this dialog for one room, and `remote` is a stable face for the plugin's
  // lifetime. The cleanup bumps the sequence so a read that lands after a room switch / close is
  // dropped instead of overwriting the next room's editor.
  useEffect(() => {
    void loadKnowledge()
    return () => { knowledgeSeqRef.current += 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id])

  const toggleAddMember = (id: BotId): void => {
    setAddSelected(prev => prev.includes(id) ? prev.filter(memberId => memberId !== id) : [...prev, id])
  }

  /** Remove one current member; the host reassigns leadership or dissolves as needed. */
  async function removeMember(botId: string): Promise<void> {
    if (memberBusy) return
    if (members.length <= 1) {
      setMemberError('群聊至少保留一名成员。')
      setRemoveTarget(undefined)
      return
    }
    setMemberBusy(true)
    setMemberError(undefined)
    try {
      const result = await remote.removeBots({
        roomId: room.id,
        botIds: [botId],
        reason: '用户从群聊设置移除',
      })
      if (!result.ok) {
        setMemberError(result.error ?? result.refused[0]?.reason ?? '移除失败')
        return
      }
      setMembers(result.memberIds !== undefined
        ? [...result.memberIds] as BotId[]
        : members.filter(id => id !== botId))
      setRemoveTarget(undefined)
    } catch (e) {
      setMemberError(describe(e))
    } finally {
      setMemberBusy(false)
    }
  }

  /** Add the selected non-members immediately; the main save only handles name/switches. */
  async function addMembers(): Promise<void> {
    if (memberBusy || addSelected.length === 0) return
    setMemberBusy(true)
    setMemberError(undefined)
    try {
      const next = [...members, ...addSelected]
      await remote.updateRoom({
        id: room.id,
        name: name.trim() !== '' ? name.trim() : room.name,
        memberIds: next,
        mentionOnly,
        paused,
        admission: { mode: admissionMode },
        speculation: {
          mode: speculationMode,
          ...(room.speculation?.dailyLimit !== undefined ? { dailyLimit: room.speculation.dailyLimit } : {}),
        },
      })
      setMembers(next)
      setAddSelected([])
      setAddOpen(false)
    } catch (e) {
      setMemberError(describe(e))
    } finally {
      setMemberBusy(false)
    }
  }

  /** 2026-11-09: ask the host to condense the experience card now (hidden leader turn). */
  async function compactExperience(): Promise<void> {
    if (experienceCompacting) return
    setExperienceCompacting(true)
    setExperienceError(undefined)
    setExperienceNotice(undefined)
    try {
      const result = await remote.compactGroupExperience({ roomId: room.id })
      if (result.ok) setExperienceNotice(result.reason)
      else setExperienceError(result.reason)
    } catch (e) {
      setExperienceError(describe(e))
    } finally {
      setExperienceCompacting(false)
    }
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

  /**
   * Download one record format.
   *
   * The HOST owns serialization — it returns the full text plus a filename — so this handler only
   * reports refusals and saves the bytes. A refusal is data (`ok:false, reason`), not an exception,
   * and it is shown next to the buttons instead of failing silently.
   */
  async function exportRecord(format: LedgerExportFormat): Promise<void> {
    if (exportFormat !== undefined) return
    setExportFormat(format)
    setExportError(undefined)
    setExportNotice(undefined)
    try {
      const result = await remote.exportLedger(room.id, format)
      if (!result.ok) {
        setExportError(result.reason ?? '导出失败')
        return
      }
      const filename = result.filename ?? EXPORT_FALLBACK_NAME[format]
      downloadTextFile(filename, result.content ?? '', EXPORT_MIME[format])
      setExportNotice(`已导出 ${filename}`)
    } catch (e) {
      setExportError(describe(e))
    } finally {
      setExportFormat(undefined)
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
        admission: { mode: admissionMode },
        speculation: {
          mode: speculationMode,
          ...(room.speculation?.dailyLimit !== undefined ? { dailyLimit: room.speculation.dailyLimit } : {}),
        },
      })
      onSaved()
    } catch (e) {
      setError(describe(e))
    }
    setBusy(false)
  }

  /**
   * Read the room's knowledge document (also the 刷新 button).
   *
   * A REFUSAL is data, not an exception: `{ ok: false, reason }` is painted in the section and the
   * textarea keeps its current content. `knowledgeSeqRef` drops a response that was overtaken by a
   * room switch or a newer read, so the editor never shows another room's text.
   */
  async function loadKnowledge(): Promise<void> {
    const seq = ++knowledgeSeqRef.current
    setKnowledgeLoading(true)
    setKnowledgeError(undefined)
    setKnowledgeNotice(undefined)
    try {
      const result = await remote.getRoomKnowledge(room.id)
      if (seq !== knowledgeSeqRef.current) return
      if (!result.ok) {
        setKnowledgeError(`读取知识失败：${result.reason ?? '宿主拒绝了这次读取。'}`)
        return
      }
      setKnowledgeText(result.content ?? '')
    } catch (e) {
      if (seq !== knowledgeSeqRef.current) return
      setKnowledgeError(`读取知识失败：${describe(e)}`)
    } finally {
      if (seq === knowledgeSeqRef.current) setKnowledgeLoading(false)
    }
  }

  /**
   * Write the knowledge draft back; a whitespace-only draft means 清空知识.
   *
   * The host owns the cap (65536 characters) and the trim/clear semantics, so an over-long text is
   * sent as-is and its Chinese refusal is painted under the editor — the client never guesses the
   * limit. `knowledgeBusy` holds both buttons for the whole round-trip (no double submit).
   */
  async function saveKnowledge(): Promise<void> {
    if (knowledgeBusy || knowledgeLoading) return
    const draft = knowledgeText
    const clearing = draft.trim() === ''
    setKnowledgeBusy(true)
    setKnowledgeError(undefined)
    setKnowledgeNotice(undefined)
    try {
      const result = await remote.setRoomKnowledge(room.id, clearing ? '' : draft)
      if (!result.ok) {
        setKnowledgeError(`保存失败：${result.reason ?? '宿主拒绝了这次修改。'}`)
        return
      }
      if (clearing) setKnowledgeText('')
      setKnowledgeNotice(clearing ? '已清空' : '已保存')
    } catch (e) {
      setKnowledgeError(`保存失败：${describe(e)}`)
    } finally {
      setKnowledgeBusy(false)
    }
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
          <legend style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
            <span style={{ flex: 1 }}>成员</span>
            <Button variant="outline" type="button" onClick={() => { setAddOpen(open => !open); setMemberError(undefined) }}>
              {addOpen ? '收起添加' : '添加成员'}
            </Button>
          </legend>
          {currentMembers.length === 0
            ? <p className={css.formHint} style={{ margin: '4px 0' }}>本群还没有 Bot。</p>
            : currentMembers.map(bot => (
              <div key={bot.id} data-room-member={bot.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                <span style={{ flex: 1, minWidth: 0 }}>{bot.name}</span>
                {removeTarget === bot.id
                  ? (
                    <>
                      <Button variant="outline" type="button" disabled={memberBusy} onClick={() => { void removeMember(bot.id) }}>确认移除</Button>
                      <Button variant="outline" type="button" onClick={() => setRemoveTarget(undefined)}>取消</Button>
                    </>
                  )
                  : (
                    <Button
                      variant="outline"
                      type="button"
                      disabled={memberBusy || members.length <= 1}
                      onClick={() => { setRemoveTarget(bot.id); setMemberError(undefined) }}
                    >
                      移除
                    </Button>
                  )}
              </div>
            ))}
          {addOpen && (
            <div data-add-members="" style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--dsw-alias-border-l3)' }}>
              <p className={css.formHint} style={{ margin: '0 0 6px' }}>选择要加入的 Bot（可多选）：</p>
              {availableBots.length === 0
                ? <p className={css.formHint} style={{ margin: '4px 0' }}>所有 Bot 都已经在本群。</p>
                : availableBots.map(bot => (
                  <label key={bot.id} className={css.check}>
                    <input
                      type="checkbox"
                      checked={addSelected.includes(bot.id as BotId)}
                      onChange={() => toggleAddMember(bot.id as BotId)}
                    />
                    <span>{bot.name}</span>
                  </label>
                ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button
                  variant="primary"
                  type="button"
                  disabled={memberBusy || addSelected.length === 0}
                  onClick={() => { void addMembers() }}
                >
                  {memberBusy ? '添加中…' : `确认添加${addSelected.length > 0 ? `（${addSelected.length}）` : ''}`}
                </Button>
                <Button variant="outline" type="button" onClick={() => { setAddOpen(false); setAddSelected([]) }}>取消</Button>
              </div>
              {memberError !== undefined && <p className={css.error} style={{ marginTop: 6 }} role="alert">{memberError}</p>}
            </div>
          )}
          {memberError !== undefined && !addOpen && (
            <p className={css.error} style={{ marginTop: 6 }} role="alert">{memberError}</p>
          )}
        </fieldset>
        <label className={css.check}>
          <input type="checkbox" checked={mentionOnly} onChange={e => setMentionOnly(e.target.checked)} />
          只有被 @ 时才回复
        </label>
        <label className={css.check}>
          <input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} />
          暂停自动回复
        </label>
        {/* ── S0-3 准入 — what an UNNAMED message may wake ─────────────────────────
            `legacy` keeps the pre-S0-3 behaviour exactly; `observe` records who would
            have been woken as one grey line per minute and creates no run; `auto` runs
            them (the same runs as legacy) after the user has looked at the evidence. */}
        <label className={css.check} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
          <span>未点名消息的处理</span>
          <select
            data-room-admission=""
            value={admissionMode}
            onChange={e => setAdmissionMode(e.target.value as AdmissionMode)}
            style={{ minWidth: 260, padding: '4px 8px', borderRadius: 6, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l1)', color: 'var(--dsw-alias-label-primary)' }}
          >
            <option value="legacy">按当前规则回复（默认）</option>
            <option value="observe">只记录，不自动回复</option>
            <option value="auto">由群主判断并安排</option>
          </select>
          <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
            选「只记录」时不会有人回复，群里只显示一条提示，告诉你这条消息本来会由谁接手；
            选「由群主判断」时，群主会看消息内容、成员分工和最近的群聊，决定自己回答、派给合适的成员，或简单收尾。
            点名、@所有人、管理指令和私聊始终直接回复。
          </span>
        </label>
        {/* ── 提前准备：后台先做一份草稿，不发送 ─────────────────────────────── */}
        <label className={css.check} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
          <span>提前准备回复</span>
          <select
            data-room-speculation=""
            value={speculationMode}
            onChange={e => setSpeculationMode(e.target.value as SpeculationMode)}
            style={{ minWidth: 260, padding: '4px 8px', borderRadius: 6, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l1)', color: 'var(--dsw-alias-label-primary)' }}
          >
            <option value="off">关闭（默认）</option>
            <option value="observe">只在记录里提示可以提前准备</option>
            <option value="on">自动提前准备（草稿不发送）</option>
          </select>
          <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
            对没有点名、但看起来是任务的消息，Bot 会先在后台准备一份草稿。草稿不会发到群里，
            也不会写进记忆，只在记录里标记是否用得上。每天最多 100 次；如果本群选择「由群主判断」，
            这条消息不会再重复提前准备。
          </span>
        </label>
      </form>

      {/* ── 协作遵从度 (P2) — read-only ─────────────────────────────────────────────
          A scorecard derived from the persisted board: how much was actually assigned vs
          finished, whether the finish passed the evidence gate, and why not. */}
      {adherence !== undefined && (
        <section style={blockStyle} data-task-adherence="">
          <h4 style={blockTitleStyle}>任务完成情况</h4>
          <div style={cardStyle}>
            <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>
              已完成 {adherence.done}/{adherence.assigned} 项
              {adherence.verifiedFinish ? ' · 已核对交付' : adherence.bypassed ? ' · 有未核对但已放行的项' : ''}
            </span>
            {adherence.issues.length === 0
              ? <span style={mutedLineStyle}>没有发现未完成或未核对的任务。</span>
              : <span style={mutedLineStyle}>{adherence.issues.join('；')}</span>}
          </div>
        </section>
      )}

      {/* ── 群经验卡 — ONE editable memory card ─────────────────────────────────────
          The host auto-seeds this from verified group finishes; after the user saves it,
          later finishes must not overwrite the text. Empty text clears the block. */}
      <section style={blockStyle} data-experience-card="">
        <h4 style={blockTitleStyle}>本群经验</h4>
        <p style={mutedLineStyle}>
          只影响这个群，Bot 回答时会参考。每完成一次群任务会自动补充一条经验；接近字数上限的
          80% 时会自动提炼压缩。可以手动修改；保存后系统自动更新不会覆盖你的版本。
        </p>
        <textarea
          data-experience-input=""
          value={experienceText}
          onChange={e => setExperienceText(e.target.value)}
          rows={6}
          maxLength={3000}
          placeholder="还没有经验。完成群任务后会自动生成，也可以在这里直接写。"
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
          <Button variant="outline" type="button" disabled={experienceCompacting || experienceBusy} onClick={() => { void compactExperience() }}>
            {experienceCompacting ? '整理中…' : '立即整理'}
          </Button>
          <Button variant="outline" type="button" disabled={experienceBusy} onClick={() => { void saveExperience() }}>
            {experienceBusy ? '保存中…' : '保存经验卡'}
          </Button>
        </div>
        {experienceError !== undefined && <p style={mutedLineStyle} role="alert">{experienceError}</p>}
        {experienceNotice !== undefined && <p style={mutedLineStyle}>{experienceNotice}</p>}
      </section>

      {/* ── 知识 (P5-2) — user-written Markdown injected as [本房间知识] ──────────────
          OUTSIDE the <form> on purpose: knowledge has its own save round-trip and its own
          character cap, and a textarea inside the settings form would make the form's 保存
          button (or Enter in the name field) carry knowledge text into `updateRoom`. It is
          read once on open (plus 刷新), never polled; the host owns the 65536-char refusal. */}
      <section style={blockStyle} data-room-knowledge-section="">
        <h4 style={blockTitleStyle}>群规则</h4>
        <p style={mutedLineStyle}>
          这里写的 Markdown 会作为本群必须遵守的规则，Bot 回答时会看到。最多 65536 个字符。
        </p>
        <textarea
          data-room-knowledge-input=""
          value={knowledgeText}
          onChange={e => { setKnowledgeText(e.target.value); setKnowledgeNotice(undefined) }}
          disabled={knowledgeLoading || knowledgeBusy}
          rows={8}
          spellCheck={false}
          placeholder={knowledgeLoading
            ? '读取中…'
            : '还没有群规则。可以写 Markdown，例如必须遵守的约定、术语表、参考资料。'}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            minHeight: 160,
            maxHeight: 360,
            resize: 'vertical',
            overflow: 'auto',
            padding: '8px 10px',
            borderRadius: 'var(--dsw-radius-md, 8px)',
            border: '0.5px solid var(--dsw-alias-border-l3)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            fontFamily: 'var(--dsw-font-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
            fontSize: 12,
            lineHeight: '18px',
          }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>
          <span
            data-room-knowledge-count=""
            style={{
              flex: 1,
              color: knowledgeText.length > KNOWLEDGE_MAX_CHARS
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-label-tertiary)',
            }}
          >
            {knowledgeLoading ? '读取中…' : `${knowledgeText.length} / ${KNOWLEDGE_MAX_CHARS}`}
          </span>
          <Button
            variant="outline"
            type="button"
            disabled={knowledgeLoading || knowledgeBusy}
            onClick={() => { void loadKnowledge() }}
          >{knowledgeLoading ? '读取中…' : '刷新'}</Button>
          <Button
            variant="primary"
            type="button"
            disabled={knowledgeLoading || knowledgeBusy}
            onClick={() => { void saveKnowledge() }}
          >
            {knowledgeBusy ? '保存中…' : knowledgeText.trim() === '' ? '清空知识' : '保存知识'}
          </Button>
        </div>
        {knowledgeError !== undefined && <p style={mutedLineStyle} role="alert">{knowledgeError}</p>}
        {knowledgeNotice !== undefined && <p style={mutedLineStyle}>{knowledgeNotice}</p>}
      </section>

      {/* ── 记录 (P4) — export ────────────────────────────────────────────────────
          The host owns the serialization (`exportLedger`); this section only downloads the text
          it returns. It sits OUTSIDE the <form>: a download button must never submit the
          settings form. */}
      <section style={blockStyle} data-room-records-section="">
        <h4 style={blockTitleStyle}>导出聊天记录</h4>
        <p style={mutedLineStyle}>把本群的完整聊天记录导出为文件。</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {EXPORT_BUTTONS.map(entry => (
            <Button
              key={entry.format}
              variant="outline"
              type="button"
              disabled={exportFormat !== undefined}
              onClick={() => { void exportRecord(entry.format) }}
            >
              {exportFormat === entry.format ? '导出中…' : entry.label}
            </Button>
          ))}
        </div>
        {exportError !== undefined && (
          <p style={mutedLineStyle} role="alert">{`导出失败：${exportError}`}</p>
        )}
        {exportNotice !== undefined && <p style={mutedLineStyle}>{exportNotice}</p>}
      </section>

      {error !== undefined && (
        <div className={css.error} style={{ marginTop: 12 }}>{error}</div>
      )}
    </NativeDialog>
  )
}
