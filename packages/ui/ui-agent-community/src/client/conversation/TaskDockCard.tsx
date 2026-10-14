/**
 * TaskDockCard — the card docked above the composer, native InputBar `dock` geometry.
 *
 * WHY IT LOOKS LIKE THIS
 * Native renders session cards in the composer's dock (`conversation.composer.dock`,
 * `conversation.input.dock`), and their shell is a fixed recipe in
 * `dsh-client-ui-conversation`'s InputBar CSS module (`w9rwOa_*`):
 *
 *   width: calc(100% - 2*side-clearance - 4*dock-inset)
 *   max-width: calc(--dsh-composer-card-max-width - 4*dock-inset)
 *   border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu)
 *   backdrop-filter: var(--dsw-menu-backdrop-filter); box-shadow: var(--dsw-elevation-panel)
 *   border: 0; flex: none; margin: 0 auto; overflow: hidden
 *
 * …with a CLICKABLE HEADER (`background:none;border:none;gap:10px`) that folds the body
 * (`padding:6px 12px; gap:8px; flex-direction:column`). This file reproduces that recipe
 * verbatim so the card sits in the composer stack like all the other docks, and it is
 * `flex:none` + OUTSIDE the transcript's scroll container, so folding it never shifts
 * the reading position (the sticky-bottom hook keys off the scroll area).
 *
 * WHAT IT SHOWS
 *   1. the room's task board — the leader's cards, their owner and their state;
 *   2. each bot's current todo list, read from the newest `todo_write` call in the
 *      ledger, which is what a bot maintains while it works.
 * Both layers are optional: with neither, the card renders nothing at all.
 */
import { useState } from 'react'
import type { LedgerEntry } from './types.ts'
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular } from './NativeIcons.tsx'

export type RoomTaskRow = {
  readonly id: string
  readonly subject: string
  readonly status: string
  readonly assigneeName?: string | undefined
  /** Which round of the room's work this card belongs to. */
  readonly round?: number | undefined
}

export type BotTodoRow = {
  readonly botId: string
  readonly botName: string
  readonly items: ReadonlyArray<{ readonly text: string; readonly status: string }>
}

/** Native dock shell — values transcribed from InputBar's CSS module. */
const dockShell = {
  flex: 'none',
  margin: '0 auto',
  overflow: 'hidden',
  border: 0,
  borderRadius: 'var(--dsw-radius-lg, 16px)',
  background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base))',
  backdropFilter: 'var(--dsw-menu-backdrop-filter)',
  boxShadow: 'var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,.12))',
  width: 'calc(100% - var(--dsh-composer-side-clearance, 48px) - var(--dsh-composer-side-clearance, 48px))',
  maxWidth: 'calc(var(--dsh-composer-card-max-width, 760px) - 24px)',
} as const

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '6px 12px',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: '18px',
} as const

const bodyStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '0 12px 8px',
} as const

const STATUS_LABEL: Record<string, string> = {
  open: '待认领',
  assigned: '已派发',
  working: '进行中',
  reported: '已汇报',
  done: '已完成',
  blocked: '受阻',
  cancelled: '已取消',
}

/**
 * The board rows that belong to the CURRENT round.
 *
 * A round is one user instruction fanned out to the room, and the board keeps every round's
 * cards forever (`BotTask.round`). Showing the newest round is what makes the card refresh
 * when new work starts instead of accumulating every task the room has ever done.
 */
export function currentRoundTasks(tasks: ReadonlyArray<RoomTaskRow>, round?: number | undefined): RoomTaskRow[] {
  if (tasks.length === 0) return []
  // The room's own round counter wins when the caller knows it: between "work dispatched" and
  // "leader assigned the first card" the newest CARDS still belong to the previous round, and
  // showing them under a live round reads as if the new work were already done.
  const wanted = round ?? Math.max(...tasks.map(t => t.round ?? 0))
  return tasks.filter(t => (t.round ?? 0) === wanted)
}

const TASK_UNFINISHED = (status: string): boolean =>
  status !== 'done' && status !== 'cancelled'

/**
 * Each bot's todo list for the CURRENT round, from the ledger rows the panel holds.
 *
 * A bot rewrites the whole list on every `todo_write`, so the newest call is the current
 * list — but only counted from the moment the current round began (the newest user row).
 * Without that cutoff the card kept showing the previous round's finished todos forever,
 * which is exactly why it never went away.
 */
export function currentRoundTodos(
  entries: ReadonlyArray<LedgerEntry>,
  roundStartAt: string | undefined,
): BotTodoRow[] {
  const scoped = roundStartAt === undefined
    ? entries
    : entries.filter(e => String((e as { at?: string }).at ?? '') >= roundStartAt)
  return latestTodosByBot(scoped)
}

/**
 * Whether the dock is worth showing at all.
 *
 * The card is for WORK, not for conversation. A plain "你好" turn runs a bot and produces
 * neither a board card nor a todo list, and showing a task dock for it was noise — the user
 * asked for the card to appear only when something is actually being worked on.
 *
 * So the signal is the work itself, scoped to the current round:
 *
 *   · the leader put cards on this round's board        → show
 *   · some bot in this room keeps a todo list this round → show (a bot only writes one when
 *     it is executing a task, which is exactly "a real task is under way")
 *   · neither                                            → hide, and the composer keeps its space
 *
 * Both inputs are already round-scoped by the caller (`currentRoundTasks` /
 * `currentRoundTodos`), so a NEW round starts hidden and shows itself again the moment that
 * round's work appears — which is the refresh the user asked for. `running` is still passed
 * in for the live dot; it is no longer a reason to appear on its own.
 */
export function shouldShowTaskDock(input: {
  readonly tasks: ReadonlyArray<RoomTaskRow>
  readonly todos: ReadonlyArray<BotTodoRow>
  readonly running?: boolean | undefined
}): boolean {
  return input.tasks.length > 0 || input.todos.length > 0
}

/** Count what is still moving, which is the only number worth putting in the header. */
export function summarizeTasks(tasks: ReadonlyArray<RoomTaskRow>): string {
  if (tasks.length === 0) return ''
  const done = tasks.filter(t => t.status === 'done').length
  const active = tasks.filter(t => t.status === 'working' || t.status === 'assigned' || t.status === 'reported').length
  const parts = [`任务 ${done}/${tasks.length}`]
  if (active > 0) parts.push(`${active} 进行中`)
  const blocked = tasks.filter(t => t.status === 'blocked').length
  if (blocked > 0) parts.push(`${blocked} 受阻`)
  return parts.join(' · ')
}

/**
 * The newest `todo_write` list per bot, from the ledger rows the panel already holds.
 *
 * A bot rewrites the whole list on every call, so the newest call IS the current list —
 * no accumulation, and no extra RPC. Unparseable or empty payloads are skipped rather
 * than rendered as an empty card.
 */
export function latestTodosByBot(entries: ReadonlyArray<LedgerEntry>): BotTodoRow[] {
  const newest = new Map<string, { at: string; botName: string; items: Array<{ text: string; status: string }> }>()
  for (const entry of entries) {
    if (entry.type !== 'tool-call') continue
    if ((entry as { name?: string }).name !== 'todo_write') continue
    const raw = (entry as { args?: string }).args
    if (typeof raw !== 'string' || raw === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const list = (parsed as { todos?: unknown }).todos
    if (!Array.isArray(list)) continue
    const items = list
      .map(item => {
        const it = item as { content?: unknown; status?: unknown }
        const text = typeof it.content === 'string' ? it.content.trim() : ''
        const status = typeof it.status === 'string' ? it.status : 'pending'
        return text === '' ? undefined : { text, status }
      })
      .filter((x): x is { text: string; status: string } => x !== undefined)
    if (items.length === 0) continue
    const botId = String((entry as { botId?: string }).botId ?? '')
    if (botId === '') continue
    const at = String((entry as { at?: string }).at ?? '')
    const previous = newest.get(botId)
    if (previous !== undefined && previous.at >= at) continue
    newest.set(botId, {
      at,
      botName: String((entry as { botName?: string }).botName ?? botId),
      items,
    })
  }
  return [...newest.entries()].map(([botId, v]) => ({ botId, botName: v.botName, items: v.items }))
}

const dot = (status: string): string =>
  status === 'completed' || status === 'done'
    ? 'var(--dsw-alias-state-success-primary)'
    : status === 'in_progress' || status === 'working'
      ? 'var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary))'
      : status === 'blocked'
        ? 'var(--dsw-alias-state-error-primary)'
        : 'var(--dsw-alias-label-tertiary)'

export function TaskDockCard({ tasks, todos, running = false, className }: {
  tasks: ReadonlyArray<RoomTaskRow>
  todos: ReadonlyArray<BotTodoRow>
  /** True while a turn is queued or running in this room. */
  running?: boolean | undefined
  className?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const summary = summarizeTasks(tasks)
  const todoCount = todos.reduce((n, t) => n + t.items.length, 0)
  // Nothing to list means nothing to show: the caller already decided this is a work round.
  if (summary === '' && todoCount === 0) return null
  const headline = [summary, todoCount > 0 ? `${todos.length} 个 bot 待办` : ''].filter(p => p !== '').join(' · ')

  return (
    <div className={className === undefined ? 'ac-taskdock' : `ac-taskdock ${className}`} style={dockShell}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span style={{ flex: 'none', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>任务</span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headline}</span>
        <span style={{ flex: 'none', marginLeft: 'auto' }} aria-hidden="true">
          {running && !open && <span style={{ color: 'var(--dsw-alias-state-business-primary)' }}>●</span>}
          {open ? <IconChevronUpOutlineRegular size={14} /> : <IconChevronDownOutlineRegular size={14} />}
        </span>
      </button>
      {open && (
        <div style={bodyStyle}>
          {tasks.map(task => (
            <div key={task.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, lineHeight: '18px' }}>
              <span style={{ flex: 'none', color: dot(task.status) }}>●</span>
              <span style={{ minWidth: 0, color: 'var(--dsw-alias-label-primary)' }}>{task.subject}</span>
              <span style={{ flex: 'none', marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)' }}>
                {[task.assigneeName, STATUS_LABEL[task.status] ?? task.status].filter(Boolean).join(' · ')}
              </span>
            </div>
          ))}
          {todos.map(row => (
            <div key={row.botId} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' }}>{row.botName}</span>
              {row.items.map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, lineHeight: '18px', paddingLeft: 10 }}>
                  <span style={{ flex: 'none', color: dot(item.status) }}>●</span>
                  <span style={{ minWidth: 0, color: 'var(--dsw-alias-label-primary)' }}>{item.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
