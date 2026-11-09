/**
 * Process-group vocabulary and rendering — the step kinds, the native titles they compose, and the
 * collapsible group seat that shows the turn's tool calls.
 *
 * Split out of MessageRows.tsx: everything here is either pure data (`KIND_BY_TOOL`, the three step
 * dictionaries, `processTitle`) or the two components that render it.
 *
 * @module
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { classifyTool, type ToolVariant } from './tool/toolModel.tsx'
import { TextShimmer } from './tool/primitives.tsx'
import { Chevron } from './messageActions.tsx'
import {
  IconAgentPresetOutlineRegular, IconApiOutlineRegular, IconBrowseOutlineRegular,
  IconCodeOutlineRegular, IconEditOutlineRegular, IconGlobeOutlineRegular,
  IconPlanOutlineRegular, IconQuestionOutlineRegular, IconSearchOutlineRegular,
  IconSparkleRegular, IconThinkOutlineRegular,
} from './NativeIcons.tsx'

// ── Process group (native ChatGroupSeat / ProcessGroupHeader, §2.8) ───────────
//
// The group seat owns the *secondary* disclosure under the Turn process row and
// its title. The title is NOT the dictionary orphan
// `message.turnProcess.toolCalls.*` (those six keys have no render site in the
// shipped bundle) — a closed group is titled by `processTitle()` (`chat:1820`),
// which joins the top three activity categories with `joinTwo` / `comma` / `more`
// and drops the shared `已` prefix from the second label.

/** Activity kinds the native process summary ranks (`chat:2186-2201`). */
export type ProcessKind =
  | 'thinking' | 'read' | 'readImage' | 'write' | 'search' | 'edit' | 'commands'
  | 'code' | 'webSearch' | 'webFetch' | 'subagents' | 'plan' | 'questions' | 'tools'

/** `message.stepProcess.done.*` — the closed-group vocabulary (`chat:5393-5406`). */
const STEP_DONE: Record<ProcessKind, string> = {
  thinking: '已完成分析',
  read: '已读取文件',
  readImage: '已读取图片',
  write: '已写入文件',
  search: '已搜索代码',
  edit: '修改了文件',
  commands: '执行了命令',
  code: '运行了代码',
  webSearch: '已搜索网页',
  webFetch: '已访问网页',
  subagents: '已协调子智能体',
  plan: '更新了计划',
  questions: '向用户提出了问题',
  tools: '已调用工具',
}

/** `message.stepProcess.<activity>` — the live vocabulary (`chat:5366-5379`). */
const STEP_LIVE: Record<ProcessKind, string> = {
  thinking: '正在分析请求',
  read: '正在读取文件',
  readImage: '正在读取图片',
  write: '正在写入文件',
  search: '正在搜索代码',
  edit: '正在编辑文件',
  commands: '正在运行命令',
  code: '正在运行代码',
  webSearch: '正在搜索网页',
  webFetch: '正在访问网页',
  subagents: '正在协调子智能体',
  plan: '正在更新计划',
  questions: '等待你的操作',
  tools: '正在调用工具',
}

/**
 * `message.stepProcess.prepare.*` (`chat:5380-5392`). There is deliberately no
 * `prepare.thinking` — `chat:2253` maps the thinking activity onto `prepare.tools`.
 */
const STEP_PREPARE: Record<Exclude<ProcessKind, 'thinking'>, string> = {
  read: '准备读取文件',
  readImage: '准备读取图片',
  write: '准备写入文件',
  search: '准备搜索代码',
  edit: '准备编辑文件',
  commands: '准备运行命令',
  code: '准备运行代码',
  webSearch: '准备搜索网页',
  webFetch: '准备访问网页',
  subagents: '准备协调子智能体',
  plan: '准备更新计划',
  questions: '准备提问',
  tools: '准备调用工具',
}

/** Native connector strings (`chat:5407-5410`). */
const PROCESS_JOIN_TWO = '{first}并{second}'
const PROCESS_COMMA = '，'
/** Typed `string` on purpose: `processTitle` compares it against `''`. */
const PROCESS_SHARED_PREFIX: string = '已'
const PROCESS_MORE = '{title}等'
/** Native `PROCESS_TITLE_MINIMUM_MS` (`chat:2185`) — live title dwell. */
const PROCESS_TITLE_MINIMUM_MS = 150

/** Tool name → activity kind; the long tail falls back to `classifyTool()`. */
const KIND_BY_TOOL: Record<string, ProcessKind> = {
  read: 'read', readFile: 'read', read_file: 'read',
  readImage: 'readImage', read_image: 'readImage',
  write: 'write', writeFile: 'write', write_file: 'write',
  edit: 'edit', editFile: 'edit', edit_file: 'edit', multiEdit: 'edit', multi_edit: 'edit', applyPatch: 'edit',
  search: 'search', grep: 'search', glob: 'search', searchFiles: 'search', listFiles: 'search',
  bash: 'commands', shell: 'commands', terminal: 'commands', runCommand: 'commands', run_command: 'commands',
  code: 'code', runCode: 'code', run_code: 'code', python: 'code', node: 'code',
  webSearch: 'webSearch', web_search: 'webSearch',
  webFetch: 'webFetch', web_fetch: 'webFetch', fetch: 'webFetch',
  agent: 'subagents', task: 'subagents', subagent: 'subagents',
  plan: 'plan', todoWrite: 'plan', todo_write: 'plan', updatePlan: 'plan',
  ask: 'questions', askUser: 'questions', ask_user: 'questions', questions: 'questions',
}

/** Native `classifyTool()` variant → activity kind (`tool:155-157`). */
const VARIANT_KIND: Record<ToolVariant, ProcessKind> = {
  bash: 'commands', read: 'read', search: 'search', write: 'write',
  edit: 'edit', code: 'code', others: 'tools',
}

export function processKindOf(toolName: string): ProcessKind {
  const named = KIND_BY_TOOL[toolName]
  return named !== undefined ? named : VARIANT_KIND[classifyTool(toolName)]
}

/** One ranked category of the native `summary.counts`. */
interface ProcessCount {
  readonly kind: ProcessKind
  readonly count: number
}

/**
 * Rank the turn's tool calls by activity kind, most frequent first. Native ranks
 * its own `summary.counts`; the ledger only carries tool names, so ties keep
 * first-appearance order (JS `sort` is stable).
 */
export function processCounts(toolNames: ReadonlyArray<string>): ProcessCount[] {
  const order: ProcessKind[] = []
  const tally = new Map<ProcessKind, number>()
  for (const name of toolNames) {
    const kind = processKindOf(name)
    if (!tally.has(kind)) order.push(kind)
    tally.set(kind, (tally.get(kind) ?? 0) + 1)
  }
  return order
    .map(kind => ({ kind, count: tally.get(kind) ?? 0 }))
    .sort((a, b) => b.count - a.count)
}

/**
 * `processTitle()`, `chat:1820-1836` — verbatim, including the `charAt(0)
 * .toLowerCase()` continuation and the shared-prefix slice. Chinese labels are
 * unaffected by the lowercase call (`sharedPrefix` = `已`), English ones are.
 */
function processTitle(counts: ReadonlyArray<ProcessCount>): string {
  const labels = counts.slice(0, 3).map(({ kind }) => STEP_DONE[kind])
  const first = labels[0]
  if (first === undefined) return STEP_DONE.thinking
  const continuation = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1)
  const second = labels[1]
  if (second === undefined) return first
  if (labels.length === 2) {
    const prefix = PROCESS_SHARED_PREFIX
    const tail = prefix !== '' && first.startsWith(prefix) && second.startsWith(prefix)
      ? second.slice(prefix.length)
      : second
    return PROCESS_JOIN_TWO
      .replace('{first}', first)
      .replace('{second}', continuation(tail))
  }
  const title = [first, ...labels.slice(1).map(continuation)].join(PROCESS_COMMA)
  return counts.length > 3 ? PROCESS_MORE.replace('{title}', title) : title
}

/** The live half of the native title (activity + preparing phase). */
interface LiveProcessTitle {
  readonly activity: ProcessKind
  readonly preparing: boolean
}

function sameLiveProcessTitle(left: LiveProcessTitle, right: LiveProcessTitle): boolean {
  return left.activity === right.activity && left.preparing === right.preparing
}

/**
 * `useStableLiveProcessTitle()` (`chat:2205-2235`): a live title change is held
 * for {@link PROCESS_TITLE_MINIMUM_MS} so the header does not flicker when a run
 * fires several short tool calls in a row. A settled group returns the desired
 * title immediately.
 */
function useStableLiveProcessTitle(desired: LiveProcessTitle, active: boolean): LiveProcessTitle {
  const [displayed, setDisplayed] = useState(desired)
  const displayedRef = useRef(displayed)
  const desiredRef = useRef(desired)
  const displayedAtRef = useRef(Date.now())
  useEffect(() => {
    desiredRef.current = desired
    if (!active || sameLiveProcessTitle(displayedRef.current, desired)) return
    const commit = (): void => {
      const next = desiredRef.current
      displayedRef.current = next
      displayedAtRef.current = Date.now()
      setDisplayed(next)
    }
    const remaining = PROCESS_TITLE_MINIMUM_MS - (Date.now() - displayedAtRef.current)
    if (remaining <= 0) { commit(); return }
    const timer = setTimeout(commit, remaining)
    return () => { clearTimeout(timer) }
  }, [active, desired.activity, desired.preparing])
  return active ? displayed : desired
}

/** Native `PROCESS_ICONS` (`chat:2186-2201`) — artwork + native sizes. */
const PROCESS_ICONS: Record<ProcessKind, ReactNode> = {
  thinking: <IconThinkOutlineRegular />,
  read: <IconBrowseOutlineRegular size={14} />,
  readImage: <IconBrowseOutlineRegular size={14} />,
  search: <IconSearchOutlineRegular size={14} />,
  edit: <IconEditOutlineRegular size={14} />,
  write: <IconEditOutlineRegular size={14} />,
  commands: <IconApiOutlineRegular />,
  code: <IconCodeOutlineRegular size={14} />,
  webSearch: <IconGlobeOutlineRegular />,
  webFetch: <IconBrowseOutlineRegular size={14} />,
  subagents: <IconAgentPresetOutlineRegular size={14} />,
  plan: <IconPlanOutlineRegular />,
  questions: <IconQuestionOutlineRegular />,
  tools: <IconSparkleRegular size={14} />,
}

/**
 * `ProcessGroupHeader` (`chat:2244-2287`). A live group is titled by its current
 * activity, a closed one by {@link processTitle}; the activity icon and the
 * chevron share the 16px leading slot (CSS swaps them on hover/focus/expanded).
 */
function ProcessGroupHeader({ counts, live, activity, preparing = false, open, bodyId, onToggle }: {
  counts: ReadonlyArray<ProcessCount>
  live: boolean
  activity?: ProcessKind | undefined
  preparing?: boolean | undefined
  open: boolean
  bodyId: string
  onToggle: () => void
}) {
  const fallback = counts[0]?.kind ?? 'thinking'
  const desired: LiveProcessTitle = { activity: activity ?? fallback, preparing }
  const stable = useStableLiveProcessTitle(desired, live)
  const resolved = live ? stable : { activity: fallback, preparing: false }
  const label = !live
    ? processTitle(counts)
    : stable.preparing
      ? STEP_PREPARE[stable.activity === 'thinking' ? 'tools' : stable.activity]
      : STEP_LIVE[stable.activity]

  return (
    <button
      type="button"
      className="ac-pgroup-title"
      aria-expanded={open}
      aria-controls={bodyId}
      data-process-activity={resolved.activity}
      onClick={(event) => {
        // Native focuses the header before toggling, so the hover-chevron does
        // not disappear from under the pointer.
        event.currentTarget.focus()
        onToggle()
      }}
    >
      <span className="ac-pgroup-leading" aria-hidden="true">
        <span className="ac-pgroup-activity" data-step-process-icon="true">{PROCESS_ICONS[resolved.activity]}</span>
        <span className="ac-pgroup-chevron" data-step-process-chevron="true">
          <Chevron open={open} />
        </span>
      </span>
      <TextShimmer active={live} className="ac-pgroup-label">{label}</TextShimmer>
    </button>
  )
}

/**
 * The group seat around the step rows: header plus its collapsible body.
 *
 * Native `ChatGroupSeat` keeps the body closed behind the header (`useDisclosure()`
 * starts collapsed). This replica starts it **open** — the outer Turn process row
 * is the disclosure the user already opened, so a second closed layer would hide
 * the very rows that row just revealed. Everything else is native: the same
 * `data-step-process` root, `aria-controls`/`aria-expanded`, and the body class.
 */
export function ProcessGroup({ counts, live, activity, children }: {
  counts: ReadonlyArray<ProcessCount>
  live: boolean
  activity?: ProcessKind | undefined
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  const bodyId = useId()
  return (
    <div className="ac-pgroup-root" data-step-process="true">
      <ProcessGroupHeader
        counts={counts}
        live={live}
        {...(activity === undefined ? {} : { activity })}
        open={open}
        bodyId={bodyId}
        onToggle={() => setOpen(prev => !prev)}
      />
      {open && <div id={bodyId} className="ac-pgroup-body">{children}</div>}
    </div>
  )
}

