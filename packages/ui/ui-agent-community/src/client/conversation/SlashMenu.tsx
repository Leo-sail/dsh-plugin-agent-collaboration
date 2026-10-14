/**
 * SlashMenu — command palette triggered by typing "/" in the composer.
 * Groups: Commands | Skills (placeholder) | Models (populated from remote)
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  IconPaperclipOutlineRegular, IconGoalOutlineRegular, IconPlanOutlineRegular,
  IconSendOutlineRegular, IconDownloadOutlineRegular, IconShieldOutlineRegular,
  IconDatabaseOutlineRegular, IconCircleOutlineRegular, IconCheckOutlineRegular,
  IconSkillOutlineRegular,
} from './NativeIcons.tsx'

export interface SlashCommand {
  id: string
  /** The English command name shown next to the title, e.g. `compact`. */
  label: string
  /** The localised title, e.g. `压缩`. Native shows this first, in primary colour. */
  title?: string
  description: string
  group: string
  /** Native menu icons, supplied by the caller. */
  icon?: React.ReactNode
  hasSubmenu?: boolean
  /** Sub-directory entries. `value` marks the row currently in effect (✓). */
  submenuItems?: Array<{ id: string; label: string; description?: string | undefined; value?: string | undefined }>
}

interface Props {
  query: string
  commands: SlashCommand[]
  onSelect: (cmd: SlashCommand, subId?: string) => void
  onClose: () => void
  openSubmenu: string | null
  setOpenSubmenu: (id: string | null) => void
}


/** One selectable option, native shape: icon + name + alias + right-aligned detail. */
interface MenuOption {
  id: string
  /** Primary text: the localised label (e.g. 压缩). */
  name: string
  /** Secondary text: the raw command name (e.g. compact), shown only when different. */
  alias?: string | undefined
  description?: string | undefined
  badge?: string | undefined
  icon?: React.ReactNode
  active?: boolean
  /** Has a sub-directory: renders the drill affordance and opens on select. */
  drill?: boolean
}

/**
 * SlashMenu — the native command menu.
 *
 * Reproduces the `tki__G` module from `dsh-client-ui-input-trigger`: a 400px card
 * anchored 4px above the composer, section titles, 34px rows laid out as
 * icon · name (40%) · alias (20%) · right-aligned description, breadcrumbs for
 * sub-directories, a search field, loading skeletons and status rows.
 */
export function SlashMenu({ query, commands, onSelect, onClose, openSubmenu, setOpenSubmenu }: Props) {
  const [active, setActive] = useState(0)
  // ONLY keyboard navigation may scroll the menu.
  //
  // Hovering a row is itself proof that the row is on screen, so scrolling for a
  // hover is unnecessary — and it was harmful: `onMouseMove` set the active row and
  // the scroll effect then ran while layout was mid-flight, producing an oversized
  // correction that clamped to the maximum. That is the "mouse enters the menu → it
  // jumps to the bottom" report.
  const keyboardMoved = useRef(false)
  const [search, setSearch] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Measured cap for the open menu, in px; `null` until the first layout pass. */
  const [maxHeight, setMaxHeight] = useState<number | null>(null)

  const submenuCmd = openSubmenu === null ? undefined : commands.find(c => c.id === openSubmenu)

  // Top level is filtered by the typed query; a sub-directory is filtered by its
  // own search field (so the typed "/model" prefix does not hide every model).
  const needle = (submenuCmd !== undefined ? search : query).toLowerCase()

  const sections = React.useMemo(() => {
    if (submenuCmd !== undefined && submenuCmd.submenuItems !== undefined) {
      const items: MenuOption[] = submenuCmd.submenuItems.map(it => ({
        id: it.id, name: it.label,
        ...(it.description !== undefined ? { description: it.description } : {}),
        active: it.id === submenuCmd.submenuItems?.find(x => x.value !== undefined)?.value,
      }))
      return [{ title: submenuCmd.title ?? submenuCmd.label, options: items }]
    }
    const groups = new Map<string, MenuOption[]>()
    for (const cmd of commands) {
      const hit = cmd.title?.toLowerCase().includes(needle) === true
        || cmd.label.toLowerCase().includes(needle)
        || cmd.description.toLowerCase().includes(needle)
      if (!hit) continue
      const list = groups.get(cmd.group) ?? []
      list.push({
        id: cmd.id,
        name: cmd.title ?? cmd.label,
        ...(cmd.title !== undefined && cmd.title.toLowerCase() !== cmd.label.toLowerCase()
          ? { alias: cmd.label } : {}),
        description: cmd.description,
        ...(cmd.icon !== undefined ? { icon: cmd.icon } : {}),
        ...(cmd.hasSubmenu === true ? { drill: true } : {}),
      })
      groups.set(cmd.group, list)
    }
    return [...groups.entries()].map(([title, options]) => ({ title, options }))
  }, [commands, needle, submenuCmd])

  /**
   * Flat position of every row, keyed by its STABLE id.
   *
   * WHY THIS IS NOT JUST `index === active` DURING RENDER: the row's `onMouseMove` handler
   * closed over a `let index` that the render loop mutated as it walked the sections, and
   * every handler captured the SAME binding — so they all read its final value. Measured:
   * hovering any row of a 12-row menu highlighted row 11, whatever the pointer did
   * (closureIndex was 11 for dom rows 1, 5 and 9 alike), which is exactly the reported
   * "只有最后一个 skills 高亮".
   *
   * Deriving the number from the DATA instead of from a counter keeps it correct through
   * every render pass (including the double-invoked ones) and survives the `active` field
   * clashing between a command id and a model id.
   */
  const flatIndexOf = React.useMemo(() => {
    const map = new Map<string, number>()
    let n = 0
    for (const sec of sections) {
      for (const opt of sec.options) map.set(`${sec.title}\u0000${opt.id}`, n++)
    }
    return map
  }, [sections])

  const flat = React.useMemo(() => sections.flatMap(sec => sec.options), [sections])

  // Native shows a skeleton while options load; ours resolve synchronously, so the
  // state is driven only by an empty first paint to avoid a flash.
  // Derived, not mirrored: `loading` was state written from `flat.length` in an effect, which added a
  // render per keystroke and could flash a skeleton after the list had already resolved.
  const loading = flat.length === 0

  // Every change of the list the user is looking at — a keystroke narrowing the query, a
  // drill into a sub-directory, a crumb back out — must show that list from its FIRST row.
  //
  // Resetting only `active` was not enough: the viewport kept the scrollTop the PREVIOUS
  // list had been scrolled to, so after arrowing down and then typing another letter the
  // list painted from the middle (measured: scrollTop 78 with active 0, so the first row
  // sat 48px above the viewport's top edge and the 添加/文件 rows were simply not visible).
  // That is the "菜单应该每次显示都在首页" report. `useLayoutEffect` so the reset lands
  // before the browser paints the new list — no visible jump.
  useLayoutEffect(() => {
    setActive(0)
    keyboardMoved.current = false
    const viewport = listRef.current
    if (viewport !== null) viewport.scrollTop = 0
  }, [needle, openSubmenu])

  // Bound the open menu to the room that actually exists between its bottom edge and the
  // nearest ancestor that clips it (`overflow: hidden|clip` — the panel column does).
  //
  // CSS alone can only guess: `min(60vh, 420px)` still overflows above the panel when the
  // composer itself is tall (a 6-line draft plus attachment chips), and the composer's
  // height is exactly what eats the space the menu opens into. Measuring keeps the first
  // row on screen whatever the composer does; the excess is scrolled inside `.ac-menu-viewport`.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (el === null) return
    const fit = (): void => {
      // The menu is `bottom: calc(100% + 4px)` of the composer card, so its bottom edge is
      // fixed by the composer and does not depend on the height being computed here.
      let ceiling = 0
      for (let p = el.parentElement; p !== null; p = p.parentElement) {
        const cs = getComputedStyle(p)
        if (cs.overflowY === 'hidden' || cs.overflowY === 'clip'
          || cs.overflowX === 'hidden' || cs.overflowX === 'clip') {
          ceiling = p.getBoundingClientRect().top
          break
        }
      }
      const room = el.getBoundingClientRect().bottom - ceiling - 8
      // 160px is a floor only while the room above the composer can hold it. A bare
      // `Math.max(160, …)` could exceed `room` on a window shorter than the composer plus
      // that floor, and the menu then lost its top to the panel's `overflow: hidden`
      // (measured: vh=260 → top -4, vh=240 → top -24). `Math.min(160, room)` keeps the cap
      // <= room by construction — on a tiny window the menu simply gets shorter and scrolls
      // internally instead of being cut off. The ceiling stays the native 420px.
      const cap = Math.min(room, window.innerHeight * 0.6, 420)
      setMaxHeight(Math.max(cap, Math.min(160, room)))
    }
    fit()
    window.addEventListener('resize', fit)
    // The composer card is the anchor: if it grows under an open menu (a taller draft),
    // the room above it shrinks and the cap has to follow.
    const card = el.parentElement
    const ro = card === null ? null : new ResizeObserver(fit)
    if (card !== null && ro !== null) ro.observe(card)
    return () => {
      window.removeEventListener('resize', fit)
      ro?.disconnect()
    }
  }, [])

  // Keyboard: ↑↓ move, Enter selects, Esc closes, Tab drills into a directory.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (flat.length === 0) return
      if (e.key === 'ArrowDown') { e.preventDefault(); keyboardMoved.current = true; setActive(a => (a + 1) % flat.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); keyboardMoved.current = true; setActive(a => (a - 1 + flat.length) % flat.length); return }
      const opt = flat[active]
      if (opt === undefined) return
      if (e.key === 'Tab' && opt.drill === true) { e.preventDefault(); setSearch(''); setOpenSubmenu(opt.id); return }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (opt.drill === true) { setSearch(''); setOpenSubmenu(opt.id) }
        else if (submenuCmd !== undefined) { onSelect(submenuCmd, opt.id) }
        else { const cmd = commands.find(c => c.id === opt.id); if (cmd !== undefined) onSelect(cmd) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flat, active, commands, onClose, onSelect, openSubmenu, setOpenSubmenu, submenuCmd])

  // Keep the active row in view by moving the MENU's own scrollTop.
  //
  // `element.scrollIntoView()` bubbles: it also scrolls every scrollable ancestor,
  // which dragged the whole message list to the bottom whenever the menu opened.
  // Adjusting this one container cannot touch anything outside the menu.
  useEffect(() => {
    if (!keyboardMoved.current) return
    const viewport = listRef.current
    const el = viewport?.querySelector<HTMLElement>('[data-active]')
    if (viewport === null || viewport === undefined || el === null || el === undefined) return
    // Measure with rects, not offsetTop: `offsetTop` is relative to the nearest
    // POSITIONED ancestor, and this viewport is static, so it reported a distance
    // from `.ac-menu` — too large, which clamped scrollTop to the maximum and made
    // the menu jump straight to its bottom.
    const row = el.getBoundingClientRect()
    const box = viewport.getBoundingClientRect()
    // A degenerate box (not laid out yet) would make any correction meaningless.
    if (box.height <= 0 || row.height <= 0) return
    // Clamp the correction to one row plus a little slack: a correct adjustment never
    // exceeds the row height, so an oversized delta can only come from a bad
    // measurement — and acting on it is what threw the menu to its bottom.
    const maxStep = row.height * 2
    const clamp = (d: number): number => Math.max(-maxStep, Math.min(maxStep, d))
    if (row.top < box.top) {
      viewport.scrollTop += clamp(row.top - box.top)
    } else if (row.bottom > box.bottom) {
      viewport.scrollTop += clamp(row.bottom - box.bottom)
    }
  }, [active])

  const pick = (opt: MenuOption): void => {
    if (opt.drill === true) { setSearch(''); setOpenSubmenu(opt.id); return }
    if (submenuCmd !== undefined) { onSelect(submenuCmd, opt.id); return }
    const cmd = commands.find(c => c.id === opt.id)
    if (cmd !== undefined) onSelect(cmd)
  }

  return (
    <div className="ac-menu" role="listbox" ref={rootRef}
      {...(maxHeight === null ? {} : { style: { maxHeight } })}>
      {submenuCmd !== undefined && (
        <div className="ac-menu-crumbs" aria-label="目录导航">
          <button type="button" className="ac-menu-crumb"
            onClick={() => { setSearch(''); setOpenSubmenu(null) }}>指令</button>
          <span className="ac-menu-crumb-sep" aria-hidden="true">›</span>
          <span className="ac-menu-crumb" data-current="true">{submenuCmd.title ?? submenuCmd.label}</span>
        </div>
      )}

      {submenuCmd !== undefined && (
        <input
          ref={searchRef}
          className="ac-menu-search"
          type="text"
          placeholder="搜索…"
          aria-label="筛选选项"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
      )}

      <div className="ac-menu-viewport" ref={listRef}>
        {loading && flat.length === 0 && (
          <>
            <div className="ac-menu-skeleton"><span className="ac-menu-skeleton-bar" style={{ width: '55%' }} /></div>
            <div className="ac-menu-skeleton"><span className="ac-menu-skeleton-bar" style={{ width: '40%' }} /></div>
            <div className="ac-menu-skeleton"><span className="ac-menu-skeleton-bar" style={{ width: '62%' }} /></div>
          </>
        )}

        {!loading && flat.length === 0 && (
          <div className="ac-menu-status">没有匹配的指令</div>
        )}

        {sections.map(sec => (
          <React.Fragment key={sec.title}>
            <div className="ac-menu-section" role="presentation">{sec.title}</div>
            {sec.options.map(opt => {
              // Read the row's own position — never a counter mutated during render.
              const rowIndex = flatIndexOf.get(`${sec.title}\u0000${opt.id}`) ?? 0
              const isActive = rowIndex === active
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive ? 'true' : undefined}
                  data-flat-index={rowIndex}
                  className="ac-menu-item"
                  onMouseDown={(e) => { e.preventDefault(); pick(opt) }}
                  // Hover moves the highlight, and the row it moves to is THIS row.
                  onMouseMove={() => { if (!isActive) setActive(rowIndex) }}
                >
                  {opt.icon !== undefined && <span className="ac-menu-icon" aria-hidden="true">{opt.icon}</span>}
                  <span className="ac-menu-name">{opt.name}</span>
                  {opt.alias !== undefined && <span className="ac-menu-alias">{opt.alias}</span>}
                  {opt.badge !== undefined && <sup className="ac-menu-badge">{opt.badge}</sup>}
                  {opt.description !== undefined && <span className="ac-menu-desc">{opt.description}</span>}
                  {opt.active === true && <span className="ac-menu-check" aria-hidden="true"><IconCheckOutlineRegular size={14} /></span>}
                  {opt.drill === true && (
                    <span className="ac-menu-trailing">
                      <span className="ac-menu-drill-hint-text">进入目录</span>
                      <kbd className="ac-menu-drill-hint">Tab</kbd>
                    </span>
                  )}
                </button>
              )
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

export function buildSlashCommands(
  modelGroups: Array<{ id: string; label?: string; models: Array<{ id: string; name?: string }> }>,
  skills: ReadonlyArray<{ id: string; name: string; description: string; path: string }> = [],
  skillsError?: string | undefined,
): SlashCommand[] {
  // ── ONE ROW PER MODEL, NAMED WITH ITS PROVIDER ──────────────────────────────
  //
  // Two providers in the catalog can offer the SAME model ids (deepseek-account and
  // deepseek-official do), and the menu rendered one row per occurrence labelled only
  // with the model name — so a list showed duplicates and picking one switched the
  // provider as a side effect the user could not see. Now each model appears once and
  // its provider rides the row's description.
  const seenModels = new Set<string>()
  const modelItems: Array<{ id: string; label: string; description?: string | undefined }> = []
  for (const g of modelGroups) {
    for (const m of g.models) {
      if (seenModels.has(m.id)) continue
      seenModels.add(m.id)
      modelItems.push({ id: m.id, label: m.name ?? m.id, description: g.label ?? g.id })
    }
  }

  return [
    // 添加 — the native `file` command registered by the conversation bundle.
    {
      id: 'file', label: 'file', title: '文件', description: '选择文件以添加到消息', group: '添加',
      icon: <IconPaperclipOutlineRegular size={14} />,
    },
    // 指令
    {
      id: 'compact', label: 'compact', title: '压缩',
      // Describes what the row actually does now: the older messages become ONE summary and
      // the newest few stay verbatim. "压缩以上对话内容" said nothing about the tail, so a
      // user could not tell whether their latest messages were at risk.
      description: '把更早的对话压缩成摘要，保留最近几条', group: '指令',
      icon: <IconCircleOutlineRegular size={14} />,
    },
    {
      id: 'permission', label: 'permission', title: '权限',
      description: '切换权限预设（沙箱模式与审批策略）', group: '指令',
      icon: <IconShieldOutlineRegular size={14} />,
      hasSubmenu: true,
      submenuItems: [
        { id: 'read-only', label: '仅可查看', description: 'Read Only' },
        { id: 'workspace-write', label: '工作区内修改', description: 'Workspace Write' },
        { id: 'full-access', label: '完全权限', description: 'Full access' },
      ],
    },
    {
      id: 'model', label: 'model', title: '模型', description: '选择本会话使用的模型', group: '指令',
      icon: <IconDatabaseOutlineRegular size={14} />,
      hasSubmenu: true,
      submenuItems: modelItems.length > 0 ? modelItems : [{ id: 'default', label: '(使用默认)' }],
    },
    // 技能 — each skill is its own top-level row under the 技能 section, so they are
    // visible immediately instead of hidden behind a drill-in sub-menu.
    ...skills.map(sk => ({
      id: `skill:${sk.id}`,
      label: sk.name,
      title: sk.name,
      description: sk.description || '（无说明）',
      group: '技能',
      icon: <IconSkillOutlineRegular size={14} />,
    })),
    // An explicit empty state, because a section with no rows renders nothing at all.
    ...(skills.length === 0
      ? [{
        id: 'skill:none',
        label: 'skill',
        title: '技能',
        description: skillsError !== undefined ? `读取失败：${skillsError}` : '未发现技能',
        group: '技能',
        icon: <IconSkillOutlineRegular size={14} />,
      }]
      : []),
  ]
}
