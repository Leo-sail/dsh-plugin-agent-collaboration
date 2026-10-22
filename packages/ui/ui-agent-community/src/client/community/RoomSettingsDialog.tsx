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
import type { BotId, BotIdentity, BotRoom, BotRun } from '@dsh-plugin/agent-community'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { NativeDialog } from '../conversation/NativeDialog.tsx'
import { contextSectionRows } from '../conversation/threadView.ts'
import { css } from '../styles.ts'
import type { CommunityRemote } from './types.ts'
import { describe } from './types.ts'

export interface RoomSettingsDialogProps {
  /** The room being edited; also the source of the fields' initial values. */
  room: BotRoom
  /** The live bot directory the member checkboxes are drawn from. */
  bots: BotIdentity[]
  /**
   * The room's runs. OP-04/OP-15 diagnostics are read-only: `evidence.finishPath` /
   * `faultSide` / `contextSections` are counters the host already persisted, so this dialog
   * renders them from the snapshot it was opened with — no extra RPC, no settings write.
   */
  runs?: readonly BotRun[] | undefined
  /** The shell's shared busy flag: a save in flight holds every dialog's primary button. */
  busy: boolean
  setBusy: (busy: boolean) => void
  remote: CommunityRemote
  /** Cancel / close: the shell drops `editingRoom` and unmounts this component. */
  onClose: () => void
  /** Saved: the shell closes the dialog and reloads the snapshot. */
  onSaved: () => void
}

/** How many recent runs the diagnostics section shows. */
const DIAGNOSTIC_RUN_COUNT = 3

/** Chinese labels for the host's closed run vocabularies (unknown values print verbatim). */
const RUN_STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '运行失败',
  cancelled: '已取消',
  interrupted: '已停止',
}
const FINISH_PATH_LABELS: Readonly<Record<string, string>> = {
  finish_task: 'finish_task',
  reply: '正常回复',
  empty: '没有输出',
  stopped: '用户停止',
  timeout: '超时',
  'no-progress': '无进展',
  failed: '失败',
  unknown: '未知',
}
const FAULT_SIDE_LABELS: Readonly<Record<string, string>> = {
  model: '模型侧',
  harness: '框架侧',
  tool: '工具侧',
  memory: '记忆侧',
  'room-goal': '房间/目标侧',
  user: '用户侧',
  unknown: '未知',
}

/** `2026-10-22 10:05` in local time; the raw string when unparseable. */
function whenText(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
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

const scrollerStyle = {
  display: 'grid',
  gap: 6,
  maxHeight: 240,
  overflowY: 'auto',
} as const

const mutedLineStyle = {
  margin: 0,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: '18px',
} as const

const contextRowStyle = {
  display: 'grid',
  gridTemplateColumns: '80px minmax(0, 1fr) 96px',
  gap: 8,
  alignItems: 'center',
  fontSize: 11,
  lineHeight: '16px',
} as const

const contextTrackStyle = {
  height: 6,
  borderRadius: 3,
  background: 'var(--dsw-alias-interactive-bg-hover)',
  overflow: 'hidden',
} as const

const contextFillStyle = {
  display: 'block',
  height: '100%',
  background: 'var(--dsw-alias-state-business-primary)',
} as const

export function RoomSettingsDialog({
  room, bots, runs, busy, setBusy, remote, onClose, onSaved,
}: RoomSettingsDialogProps) {
  const [name, setName] = useState(room.name)
  const [members, setMembers] = useState<BotId[]>([...room.memberIds] as BotId[])
  const [mentionOnly, setMentionOnly] = useState(room.mentionOnly)
  const [paused, setPaused] = useState(room.paused ?? false)
  const [error, setError] = useState<string>()

  /** Newest-first, capped: the diagnostics section is a summary, not a run log. */
  const diagnosticRuns = [...(runs ?? [])]
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .slice(0, DIAGNOSTIC_RUN_COUNT)
  const patternCards = [...(room.patternCards ?? [])].sort(
    (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
  )
  const adherence = room.taskState?.adherence

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

      {/* ── 群协作模式 (OP-09) — read-only ──────────────────────────────────────────
          Cards the host learned from finished tasks in THIS group. Display only: there is
          no delete/edit RPC and none is needed — the host bounds the list itself. */}
      <section style={blockStyle} data-pattern-cards="">
        <h4 style={blockTitleStyle}>群协作模式</h4>
        {patternCards.length === 0
          ? <p style={mutedLineStyle}>暂无</p>
          : (
            <div style={scrollerStyle}>
              {patternCards.map(card => (
                <article key={card.id} style={cardStyle} data-pattern-card={card.id}>
                  <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>{card.task}</span>
                  <span>做法：{card.approach}</span>
                  {card.pitfalls !== undefined && card.pitfalls.length > 0 && (
                    <span>注意：{card.pitfalls.join('；')}</span>
                  )}
                  {card.evidence !== undefined && card.evidence.length > 0 && (
                    <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
                      证据：{card.evidence.join('、')}
                    </span>
                  )}
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{whenText(card.createdAt)}</span>
                </article>
              ))}
            </div>
          )}
      </section>

      {/* ── 运行诊断 (OP-04 / OP-15) — read-only ───────────────────────────────────
          The most recent runs plus their prompt-section cost. Everything here comes from
          the snapshot's run evidence: counters, no prompt text. */}
      <section style={blockStyle} data-run-diagnostics="">
        <h4 style={blockTitleStyle}>运行诊断（最近 {diagnosticRuns.length} 次）</h4>
        {diagnosticRuns.length === 0
          ? <p style={mutedLineStyle}>暂无运行数据</p>
          : (
            <div style={scrollerStyle}>
              {diagnosticRuns.map(run => {
                const rows = contextSectionRows(run.evidence?.contextSections)
                const finishPath = run.evidence?.finishPath
                const faultSide = run.evidence?.faultSide ?? run.faultSide
                const promptTokens = run.evidence?.promptTokensEstimate
                return (
                  <article key={run.id} style={cardStyle} data-diagnostic-run={run.id}>
                    <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>
                      {RUN_STATUS_LABELS[run.status] ?? run.status}
                      {finishPath !== undefined && ` · ${FINISH_PATH_LABELS[finishPath] ?? finishPath}`}
                      {faultSide !== undefined && ` · 责任：${FAULT_SIDE_LABELS[faultSide] ?? faultSide}`}
                      {promptTokens !== undefined && ` · 约 ${promptTokens} tokens`}
                    </span>
                    {rows.length === 0
                      ? <span style={mutedLineStyle}>暂无上下文分段统计</span>
                      : rows.map(row => (
                        <span key={row.key} style={contextRowStyle} data-context-section={row.key}>
                          <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{row.label}</span>
                          <span style={contextTrackStyle}>
                            <span style={{ ...contextFillStyle, width: `${Math.round(row.ratio * 100)}%` }} />
                          </span>
                          <span style={{ textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' }}>
                            {row.chars} 字 · {Math.round(row.ratio * 100)}%
                          </span>
                        </span>
                      ))}
                  </article>
                )
              })}
            </div>
          )}
      </section>

      {error !== undefined && (
        <div className={css.error} style={{ marginTop: 12 }}>{error}</div>
      )}
    </NativeDialog>
  )
}
