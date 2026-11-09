/**
 * Tool-row model — every non-visual part of the tool cards: the shared types, the parsers
 * (diff/read/search/web/details/ask) and the row model they feed.
 *
 * Extracted from ToolRow.tsx, which had grown to ~2,000 lines mixing these ~1,100 lines of
 * framework-free logic with eight renderers and four primitives. Nothing here touches component
 * state, hooks or the DOM, so it moved without a single edit — and it is now the half of that file
 * a behavioural test can reach.
 *
 * @module
 */
import type { CSSProperties, ReactNode } from 'react'
import type { LedgerEntry } from '../types.ts'
import { IconAgentPresetOutlineRegular, IconApiOutlineRegular, IconBranchOutlineRegular,
  IconBrowseOutlineRegular, IconCheckOutlineRegular, IconChecklistOutlineRegular,
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconChevronUpOutlineRegular,
  IconClockOutlineRegular, IconCodeOutlineRegular, IconCopyOutlineRegular,
  IconCordisPluginOutlineRegular, IconEditOutlineRegular, IconGlobeOutlineRegular,
  IconGoalOutlineRegular, IconInspectOutlineRegular, IconPlayOutlineRegular,
  IconQuestionOutlineRegular, IconSearchOutlineRegular, IconSparkleRegular,
  IconUsersOutlineRegular } from '../NativeIcons.tsx'

// ── model types ───────────────────────────────────────────────────────────────

/** `data-state` domain — `tool:276-283` (five values, `ok` included). */
export type ToolRowState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'

/** `data-variant` domain — `TOOL_VARIANTS` (`tool:83-100`). */
export type ToolVariant = 'bash' | 'read' | 'search' | 'write' | 'edit' | 'code' | 'others'

/** Added / removed line counts shown as `+N -M`. */
export interface DiffStat {
  readonly added: number
  readonly removed: number
}

/** One rendered diff row (`DiffBlock`'s `ROW_CLASS` kinds). */
export interface DiffRow {
  readonly kind: 'path' | 'gap' | 'del' | 'add' | 'context'
  readonly text: string
}

/** `DiffBlock` props derived from the call's arguments. */
export interface DiffCardModel {
  readonly path: string
  readonly rows: readonly DiffRow[]
}

/** One numbered line of a read card. */
export interface ReadLine {
  readonly number: number
  readonly text: string
}

/** `ReadBlock` props derived from the call's arguments. */
export interface ReadCardModel {
  readonly path: string
  readonly lines: readonly ReadLine[]
  readonly totalLines: number
  readonly windowed: boolean
}

/** One file group of a grep result. */
export interface SearchFile {
  readonly path: string
  readonly matches: readonly { readonly lineNumber: number; readonly line: string }[]
}

/** `SearchBlock` props derived from the call's arguments and output. */
export interface SearchCardModel {
  readonly kind: 'grep' | 'glob'
  readonly files: readonly SearchFile[]
  readonly paths: readonly string[]
  readonly rawLines: readonly string[]
  readonly parsed: boolean
  readonly matchCount: number
  readonly fileCount: number
  readonly total: number
}

/** One citation of a web search / fetch. */
export interface WebSource {
  readonly title: string
  readonly url: string
  readonly snippet: string | null
  readonly published: string | null
}

/** `WebBlock` props derived from the call's output. */
export interface WebCardModel {
  readonly kind: 'search' | 'fetch'
  readonly answer: string | null
  readonly sources: readonly WebSource[]
  readonly url: string | null
  readonly status: string | null
  readonly content: string | null
  readonly truncated: boolean
}

/** One item of the structured details card (`DetailItem`, `tool:1296-1340`). */
export interface DetailsItem {
  readonly status: 'completed' | 'in_progress' | 'pending'
  readonly title: string
  /** `item.subtitle` — the dim second line under a heading. */
  readonly subtitle: string | null
  /** `item.badge` — the coloured dot + label (`[data-tone]`). */
  readonly badge: { readonly tone: 'info' | 'success' | 'warning' | 'error'; readonly label: string } | null
  readonly fields: readonly { readonly label: string; readonly value: string }[]
  readonly description: string | null
}

/**
 * One `<details>` fold of the details card — native `ToolDetails`' `group`
 * (a collapsible sub-list) rendered with the right-chevron summary.
 */
export interface DetailsGroupModel {
  readonly label: string
  readonly count: number
  readonly items: readonly DetailsItem[]
}

/** `ToolDetails` props. */
export interface DetailsCardModel {
  readonly caption: string | null
  readonly statusText: string | null
  /** Ungrouped items, rendered straight into the root list. */
  readonly items: readonly DetailsItem[]
  /** Grouped items, rendered as native `group` folds after the flat list. */
  readonly groups: readonly DetailsGroupModel[]
}

/** One asked question and its recorded answer. */
export interface AskItem {
  readonly question: string
  readonly answer: string | null
}

/** `AskQuestionCard` props. */
export interface AskCardModel {
  readonly items: readonly AskItem[]
}

/** The row's full model — the plugin-side equivalent of native `toolRowModel()`. */
export interface ToolRowModel {
  readonly state: ToolRowState
  readonly variant: ToolVariant
  readonly toolName: string
  readonly title: string
  readonly summary: string
  readonly diffStat: DiffStat | null
  readonly bodyRaw: string | null
  readonly output: string | null
  readonly errorSummary: string | null
  readonly filePath: string | null
}

// ── native tables (verbatim) ──────────────────────────────────────────────────

/** `TOOL_VARIANTS`, `tool:83-100`. */
export const TOOL_VARIANTS: Readonly<Record<string, ToolVariant>> = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  read_image: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
  cordis_run: 'others',
  cordis_stop: 'others',
  cordis_undefine: 'others',
}

/** `VARIANT_TITLE_KEYS`, `tool:65-73`. */
export const VARIANT_TITLE_KEYS: Readonly<Record<ToolVariant, string>> = {
  search: 'tool.title.search',
  read: 'tool.title.read',
  bash: 'tool.title.bash',
  write: 'tool.title.write',
  edit: 'tool.title.edit',
  code: 'tool.title.code',
  others: 'tool.title.generic',
}

/** `TOOL_TITLE_KEYS`, `tool:102-149` — 48 entries, first lookup level. */
export const TOOL_TITLE_KEYS: Readonly<Record<string, string>> = {
  cordis_package_inspect: 'tool.title.inspect',
  cordis_runtime_inspect: 'tool.title.inspect',
  cordis_run: 'tool.title.runCordis',
  cordis_stop: 'tool.title.stopCordis',
  cordis_undefine: 'tool.title.removeCordis',
  pwsh: 'tool.title.pwsh',
  read_image: 'tool.title.readImage',
  todo_write: 'todo.rowTitle',
  ask_user_question: 'ask.rowTitle',
  create_goal: 'tool.title.createGoal',
  get_goal: 'tool.title.getGoal',
  update_goal: 'tool.title.updateGoal',
  schedule_create: 'tool.title.createSchedule',
  schedule_list: 'tool.title.listSchedules',
  schedule_delete: 'tool.title.deleteSchedule',
  schedule_update: 'tool.title.updateSchedule',
  cordis_inspect_list: 'tool.title.inspectProviders',
  cordis_inspect_query: 'tool.title.queryRuntime',
  cordis_inspect_self: 'tool.title.inspectPlugins',
  workflow: 'tool.title.workflow',
  ralph: 'tool.title.ralph',
  session_event_read: 'tool.title.readEvent',
  session_event_search: 'tool.title.searchEvents',
  session_event_trace: 'tool.title.traceEvent',
  session_search: 'tool.title.searchSessions',
  session_trace: 'tool.title.traceSession',
  list_subagent_models: 'tool.title.listModels',
  subagent: 'tool.title.subagent',
  list_agents: 'tool.title.listAgents',
  send_message: 'tool.title.sendMessage',
  interrupt_agent: 'tool.title.interruptAgent',
  job_list: 'tool.title.listJobs',
  job_output: 'tool.title.readJob',
  job_kill: 'tool.title.killJob',
  terminal_open: 'tool.title.openTerminal',
  terminal_read: 'tool.title.readTerminal',
  terminal_list: 'tool.title.listTerminals',
  terminal_signal: 'tool.title.signalTerminal',
  terminal_close: 'tool.title.closeTerminal',
  lsp: 'tool.title.lsp',
  spawn_teammate: 'tool.title.spawnTeammate',
  team_task_create: 'tool.title.createTeamTask',
  team_task_get: 'tool.title.getTeamTask',
  team_task_update: 'tool.title.updateTeamTask',
  team_task_list: 'tool.title.listTeamTasks',
  wait_agent: 'tool.title.waitAgent',
}

/** `zh` values of every key above (the shipped `conversation` dictionary). */
export const TITLES: Readonly<Record<string, string>> = {
  'tool.title.search': '搜索',
  'tool.title.read': '读取',
  'tool.title.bash': '运行命令',
  'tool.title.write': '写入',
  'tool.title.edit': '编辑',
  'tool.title.code': '代码',
  'tool.title.generic': '工具调用',
  'tool.title.inspect': '查询 Cordis 环境',
  'tool.title.runCordis': '运行 Cordis 插件',
  'tool.title.stopCordis': '停止 Cordis 插件',
  'tool.title.removeCordis': '移除 Cordis 插件',
  'tool.title.pwsh': '运行命令',
  'tool.title.readImage': '读取图片',
  'tool.title.grep': '搜索文件内容',
  'tool.title.glob': '查找文件',
  'tool.title.webSearch': '网页搜索',
  'tool.title.webFetch': '网页获取',
  'tool.title.createGoal': '创建目标',
  'tool.title.getGoal': '查看目标',
  'tool.title.updateGoal': '更新目标',
  'tool.title.createSchedule': '创建定时任务',
  'tool.title.listSchedules': '查看定时任务',
  'tool.title.deleteSchedule': '删除定时任务',
  'tool.title.updateSchedule': '修改定时任务',
  'tool.title.inspectProviders': '检查提供方',
  'tool.title.queryRuntime': '查询运行时',
  'tool.title.inspectPlugins': '检查动态插件',
  'tool.title.workflow': '运行工作流',
  'tool.title.ralph': '运行循环工作流',
  'tool.title.readEvent': '读取事件',
  'tool.title.searchEvents': '搜索事件',
  'tool.title.traceEvent': '追踪事件',
  'tool.title.searchSessions': '搜索会话',
  'tool.title.traceSession': '追踪会话',
  'tool.title.listModels': '查看可用模型',
  'tool.title.subagent': '创建子智能体',
  'tool.title.listAgents': '查看子智能体',
  'tool.title.sendMessage': '发送消息',
  'tool.title.interruptAgent': '中断智能体',
  'tool.title.listJobs': '查看后台任务',
  'tool.title.readJob': '读取任务输出',
  'tool.title.killJob': '取消后台任务',
  'tool.title.openTerminal': '创建终端',
  'tool.title.readTerminal': '读取终端',
  'tool.title.listTerminals': '查看终端',
  'tool.title.signalTerminal': '发送终端信号',
  'tool.title.closeTerminal': '关闭终端',
  'tool.title.lsp': '查询代码符号',
  'tool.title.spawnTeammate': '创建队友',
  'tool.title.createTeamTask': '创建团队任务',
  'tool.title.getTeamTask': '读取团队任务',
  'tool.title.updateTeamTask': '更新团队任务',
  'tool.title.listTeamTasks': '查看团队任务',
  'tool.title.waitAgent': '等待子智能体',
  'todo.rowTitle': '更新任务清单',
  'ask.rowTitle': '提问',
}

/** `row.*` status text, zh. `ok` is intentionally absent (`tool:1485-1493`). */
export const STATE_STATUS: Readonly<Partial<Record<ToolRowState, string>>> = {
  preparing: '正在准备调用',
  running: '运行中',
  error: '失败',
  stopped: '已停止',
}

/** Row / card chrome labels, zh (`conversation` + `common` dictionaries). */
export const ROW_INPUT = '输入'
export const ROW_OUTPUT = '输出'
export const ROW_INSPECT = '查看'
export const LABEL_COPY = '复制'
export const LABEL_COPIED = '复制成功'
export const LABEL_COLLAPSE = '收起'
export const LABEL_CODE_BLOCK = '代码块'
export const DIFF_LABELS = {
  collapse: LABEL_COLLAPSE,
  expand: (n: number) => `… 其余 ${n} 行`,
  collapseAria: '收起差异',
  expandAria: (n: number) => `展开其余 ${n} 行差异`,
} as const
export const READ_LABELS = {
  collapse: LABEL_COLLAPSE,
  expand: (n: number) => `… 其余 ${n} 行`,
  collapseAria: '收起内容',
  expandAria: (n: number) => `展开其余 ${n} 行`,
  window: (shown: number, total: number) => `显示 ${shown} / ${total} 行`,
} as const
export const SEARCH_LABELS = {
  collapse: LABEL_COLLAPSE,
  expand: (n: number) => `… 其余 ${n} 行`,
  collapseAria: '收起结果',
  expandAria: (n: number) => `展开其余 ${n} 行结果`,
  noResults: '无结果',
} as const
export const WEB_NO_RESULTS = '未找到结果'
export const WEB_SOURCES_TRUNCATED = '来源列表已截断'
export const WEB_CONTENT_TRUNCATED = '内容已截断'
export const ASK_NOT_ANSWERED = '未回答'

/** `SUMMARY_KEYS`, `tool:204-212`. */
export const SUMMARY_KEYS: Readonly<Record<ToolVariant, readonly string[]>> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

/** Keyed toolviews whose title is hard-coded inside their own row component. */
export const HARD_TITLE_KEYS: Readonly<Record<string, string>> = {
  grep: 'tool.title.grep',
  glob: 'tool.title.glob',
  web_search: 'tool.title.webSearch',
  web_fetch: 'tool.title.webFetch',
}

/** `TEAMMATE_TOOLS`, `tool:3982-3990`. */
export const TEAMMATE_TOOLS = new Set(['spawn_teammate', 'list_agents', 'send_message', 'interrupt_agent', 'wait_agent'])

/** Tools registered against the structured `DetailsRow` toolview (`tool:4038-4227`). */
export const DETAILS_TOOLS = new Set([
  'create_goal', 'get_goal', 'update_goal',
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
  'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
  'workflow', 'ralph',
  'session_event_read', 'session_event_search', 'session_event_trace',
  'session_search', 'session_trace', 'list_subagent_models', 'subagent',
  'job_list', 'job_output', 'job_kill',
  'terminal_open', 'terminal_read', 'terminal_list', 'terminal_signal', 'terminal_close',
  'lsp',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_update', 'team_task_list',
  'wait_agent', 'list_agents', 'send_message', 'interrupt_agent',
])

/** Row-level card caps, taken from the native `ToolRow` call sites. */
export const DIFF_MAX_LINES = 9
export const READ_MAX_LINES = 8
export const SEARCH_MAX_LINES = 8
/** `MAX_DIFF_EDIT_LENGTH` — primitives' diff cap (`index.js:9698`). */
export const MAX_DIFF_EDIT_LENGTH = 256

// ── pure helpers ──────────────────────────────────────────────────────────────

/** `classifyTool()`, `tool:155-157`. */
export function classifyTool(toolName: string): ToolVariant {
  return TOOL_VARIANTS[toolName] ?? 'others'
}

/** `toolTitleKey()`, `tool:163-165` — two-level lookup, never `tool.<name>`. */
export function toolTitleKey(toolName: string): string {
  return TOOL_TITLE_KEYS[toolName] ?? VARIANT_TITLE_KEYS[classifyTool(toolName)]
}

/** Localized row title, including the four hard-coded row overrides (`§10`). */
export function toolTitle(toolName: string): string {
  const key = HARD_TITLE_KEYS[toolName] ?? toolTitleKey(toolName)
  return TITLES[key] ?? toolName
}

/** `firstLine()`, `tool:193-196`. */
export function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** `parseArgs()`, `tool:185-191` — `undefined` when the payload is not a JSON object. */
export function parseArgs(argsRaw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** `deriveSummary()`, `tool:214-233`. */
export function deriveSummary(variant: ToolVariant, argsRaw: string): string {
  const args = parseArgs(argsRaw)
  if (args === undefined) return firstLine(argsRaw)
  if (variant === 'search' && Array.isArray(args['queries'])) {
    const queries = (args['queries'] as unknown[]).filter((q): q is string => typeof q === 'string' && q !== '')
    if (queries.length > 0) return queries.map(firstLine).join(', ')
  }
  for (const key of SUMMARY_KEYS[variant]) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return firstLine(v)
  }
  for (const v of Object.values(args)) if (typeof v === 'string' && v !== '') return firstLine(v)
  return firstLine(argsRaw)
}

/** `relativizeToCwd()`, `tool:50-57`. */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (root !== '' && (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`))) return text.slice(root.length + 1)
  return text
}

/** `abbreviateHomePath()`, `tool:41-49`. */
export function abbreviateHomePath(path: string, home: string | undefined): string {
  if (home === undefined || home === '') return path
  const root = home.replace(/\/+$/, '')
  if (root === '' || root === '/') return path
  if (path.replace(/\/+$/, '') === root) return '~'
  if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`
  return path
}

/** `formatToolBody()`, `tool:243-256`. */
export function formatToolBody(variant: ToolVariant, argsRaw: string): string | null {
  if (argsRaw === '') return null
  const parsed = parseArgs(argsRaw)
  if (parsed === undefined) return argsRaw
  if (variant === 'code') {
    const code = parsed['code']
    if (typeof code === 'string' && code !== '') return code
  }
  return JSON.stringify(parsed, null, 2)
}

/** `contentLines()`, primitives — one trailing newline is a terminator. */
export function contentLines(text: string): string[] {
  if (text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/** Longest common subsequence length over two line arrays (rolling rows). */
export function lcsLength(a: readonly string[], b: readonly string[]): number {
  let prev: number[] = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? (prev[j - 1] ?? 0) + 1
        : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0)
    }
    prev = cur
  }
  return prev[b.length] ?? 0
}

/**
 * `+N -M` totals for one intended file mutation.
 *
 * Native counts `structuredPatch` hunks and, above {@link MAX_DIFF_EDIT_LENGTH},
 * falls back to "every old line removed, every new line added". This replica
 * uses an LCS line diff: identical for contiguous replacements, but a
 * duplicate-heavy input can report different totals than Myers' algorithm.
 */
export function diffTotals(oldText: string | null, newText: string): DiffStat {
  const oldLines = contentLines(oldText ?? '')
  const newLines = contentLines(newText)
  if (oldLines.length + newLines.length > MAX_DIFF_EDIT_LENGTH * 2) {
    return { added: newLines.length, removed: oldLines.length }
  }
  const common = lcsLength(oldLines, newLines)
  return { added: newLines.length - common, removed: oldLines.length - common }
}

/**
 * Build `DiffBlock` rows with `context` lines around each change and a `⋯` gap
 * where unchanged lines are dropped — the shape of primitives' `buildRows`.
 */
export function buildDiffRows(oldLines: readonly string[], newLines: readonly string[], context = 3): DiffRow[] {
  if (oldLines.length + newLines.length > MAX_DIFF_EDIT_LENGTH * 2) {
    return [...oldLines.map(text => ({ kind: 'del' as const, text })), ...newLines.map(text => ({ kind: 'add' as const, text }))]
  }
  // Walk the LCS table backwards to recover an edit script.
  const table: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0))
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      const row = table[i]!
      row[j] = oldLines[i] === newLines[j] ? (table[i + 1]![j + 1] ?? 0) + 1 : Math.max(table[i + 1]![j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const ops: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: 'context', text: oldLines[i]! })
      i++
      j++
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      ops.push({ kind: 'del', text: oldLines[i]! })
      i++
    } else {
      ops.push({ kind: 'add', text: newLines[j]! })
      j++
    }
  }
  while (i < oldLines.length) { ops.push({ kind: 'del', text: oldLines[i]! }); i++ }
  while (j < newLines.length) { ops.push({ kind: 'add', text: newLines[j]! }); j++ }

  // Keep `context` unchanged rows around every change; fold the rest into `⋯`.
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach((op, index) => {
    if (op.kind === 'del' || op.kind === 'add') {
      for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep[k] = true
    }
  })
  const rows: DiffRow[] = []
  let gap = false
  ops.forEach((op, index) => {
    if (keep[index] === true) {
      rows.push(op)
      gap = false
    } else if (!gap) {
      rows.push({ kind: 'gap', text: '⋯' })
      gap = true
    }
  })
  return rows
}

/**
 * Argument-derived diff stat for `write` / `edit` — the "intended diff" the
 * native row uses while the call runs and whenever the result carries no
 * applied-diff metadata (`tool:388-410`).
 */
export function deriveDiffStat(toolName: string, argsRaw: string | null): DiffStat | null {
  if (argsRaw === null || argsRaw === '') return null
  const args = parseArgs(argsRaw)
  if (args === undefined) return null
  if (toolName === 'write') {
    const content = args['content']
    return typeof content === 'string' ? diffTotals(null, content) : null
  }
  if (toolName === 'edit') {
    const oldText = args['old_string']
    const newText = args['new_string']
    if (typeof newText !== 'string') return null
    return diffTotals(typeof oldText === 'string' && oldText !== '' ? oldText : null, newText)
  }
  return null
}

/** `stateStatus$1()`, `tool:1485-1493` — `ok` deliberately returns `null`. */
export function stateStatus(state: ToolRowState): string | null {
  return STATE_STATUS[state] ?? null
}

/** `FILE_PATH_KEYS` = `path` / `file_path`, never `url` (`tool:235-241`). */
export function pickPath(argsRaw: string | null): string | null {
  if (argsRaw === null || argsRaw === '') return null
  const args = parseArgs(argsRaw)
  if (args === undefined) return null
  for (const key of ['path', 'file_path'] as const) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return firstLine(v)
  }
  return null
}

/** Extension → the language id the card toolbar prints (`languageForPath`). */
export const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', md: 'markdown', markdown: 'markdown', css: 'css', scss: 'scss',
  less: 'less', html: 'html', htm: 'html', py: 'python', sh: 'shell', bash: 'shell',
  zsh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'toml', rs: 'rust', go: 'go',
  java: 'java', rb: 'ruby', php: 'php', sql: 'sql', xml: 'xml', svg: 'xml',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', txt: 'text',
}

/**
 * The language id for a workspace path — primitives' `languageForPath`, minus the
 * grammar registry (the replica has no highlighter, so it prints the id itself).
 */
export function languageForPath(path: string | null): string | null {
  if (path === null || path === '') return null
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot === path.length - 1) return null
  return LANGUAGE_LABELS[path.slice(dot + 1).toLowerCase()] ?? null
}

/** `detailIcon()`, `tool:3991-4001` — order matters. */
export function detailIcon(toolName: string): ReactNode {
  if (TEAMMATE_TOOLS.has(toolName)) return <IconUsersOutlineRegular size={14} />
  if (toolName.startsWith('schedule_')) return <IconClockOutlineRegular size={14} />
  if (toolName.endsWith('_goal')) return <IconGoalOutlineRegular size={14} />
  if (toolName.startsWith('cordis_')) return <IconCordisPluginOutlineRegular />
  if (toolName.startsWith('terminal_')) return <IconCodeOutlineRegular size={14} />
  if (toolName.startsWith('session_') || toolName === 'lsp') return <IconSearchOutlineRegular size={14} />
  if (toolName.startsWith('job_') || toolName.startsWith('team_task_')) return <IconChecklistOutlineRegular />
  if (toolName === 'workflow' || toolName === 'ralph') return <IconBranchOutlineRegular size={14} />
  // `tool:4000` — the DetailsRow fallback glyph (`subagent`, `list_subagent_models`).
  return <IconAgentPresetOutlineRegular size={14} />
}

/** Row leading icon: the keyed toolviews' own icons first, `detailIcon` last. */
export function toolIcon(toolName: string, variant: ToolVariant): ReactNode {
  switch (toolName) {
    case 'bash':
    case 'pwsh':
      return <IconApiOutlineRegular size={14} />
    case 'read':
    case 'read_image':
    case 'web_fetch':
      return <IconBrowseOutlineRegular size={14} />
    case 'web_search':
      return <IconGlobeOutlineRegular size={14} />
    case 'grep':
    case 'glob':
      return <IconSearchOutlineRegular size={14} />
    case 'write':
    case 'edit':
      return <IconEditOutlineRegular size={14} />
    case 'run_code':
      return <IconCodeOutlineRegular size={14} />
    case 'todo_write':
      return <IconChecklistOutlineRegular />
    case 'ask_user_question':
      return <IconQuestionOutlineRegular />
    default:
      break
  }
  if (DETAILS_TOOLS.has(toolName)) return detailIcon(toolName)
  // `VARIANT_ICONS`, `tool:1744-1752` — the GenericToolCard fallback.
  switch (variant) {
    case 'search': return <IconSearchOutlineRegular size={14} />
    case 'read': return <IconBrowseOutlineRegular size={14} />
    case 'bash': return <IconApiOutlineRegular size={14} />
    case 'write':
    case 'edit': return <IconEditOutlineRegular size={14} />
    case 'code': return <IconCodeOutlineRegular size={14} />
    default: return <IconSparkleRegular size={14} />
  }
}

// ── card models ───────────────────────────────────────────────────────────────

/** `diffCardModel()` — `write` adds every line, `edit` diffs `old_string` → `new_string`. */
export function diffCardModel(toolName: string, argsRaw: string | null): DiffCardModel | null {
  if (argsRaw === null || argsRaw === '') return null
  const args = parseArgs(argsRaw)
  if (args === undefined) return null
  const path = pickPath(argsRaw) ?? ''
  if (toolName === 'write') {
    const content = args['content']
    if (typeof content !== 'string') return null
    return { path, rows: [{ kind: 'path', text: path }, ...contentLines(content).map(text => ({ kind: 'add' as const, text }))] }
  }
  if (toolName !== 'edit') return null
  const oldText = args['old_string']
  const newText = args['new_string']
  if (typeof newText !== 'string') return null
  return {
    path,
    rows: [{ kind: 'path', text: path }, ...buildDiffRows(contentLines(typeof oldText === 'string' ? oldText : ''), contentLines(newText))],
  }
}

/** `readCardModel()` — numbered lines from the call's arguments and output. */
export function readCardModel(toolName: string, argsRaw: string | null, output: string | null): ReadCardModel | null {
  if (toolName !== 'read' && toolName !== 'read_image') return null
  if (output === null || output === '') return null
  const args = argsRaw === null ? undefined : parseArgs(argsRaw)
  const rawOffset = args?.['offset']
  const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0
  const lines = contentLines(output).map((text, index) => ({ number: offset + index + 1, text }))
  return { path: pickPath(argsRaw) ?? '', lines, totalLines: offset + lines.length, windowed: offset > 0 }
}

/** `searchCardModel()` — groups grep matches by file, lists glob paths. */
export function searchCardModel(toolName: string, argsRaw: string | null, output: string | null): SearchCardModel | null {
  if (toolName !== 'grep' && toolName !== 'glob') return null
  const outputLines = contentLines(output ?? '')
  if (toolName === 'glob') {
    const paths = outputLines.map(l => l.trim()).filter(l => l !== '')
    return { kind: 'glob', files: [], paths, rawLines: [], parsed: true, matchCount: paths.length, fileCount: paths.length, total: paths.length }
  }
  const args = argsRaw === null ? undefined : parseArgs(argsRaw)
  const pattern = typeof args?.['pattern'] === 'string' ? args['pattern'] : null
  const files: SearchFile[] = []
  const byPath = new Map<string, { lineNumber: number; line: string }[]>()
  let matches = 0
  let parsed = true
  for (const raw of outputLines) {
    const m = /^(.*?):(\d+):(.*)$/.exec(raw)
    if (m === null) { parsed = false; break }
    const path = m[1] ?? ''
    const lineNumber = Number(m[2])
    const line = (m[3] ?? '').trim()
    matches++
    const bucket = byPath.get(path)
    if (bucket === undefined) byPath.set(path, [{ lineNumber, line }])
    else bucket.push({ lineNumber, line })
  }
  if (parsed && matches > 0) {
    for (const [path, ms] of byPath) files.push({ path, matches: ms })
    return { kind: 'grep', files, paths: [], rawLines: [], parsed: true, matchCount: matches, fileCount: files.length, total: matches }
  }
  // Unrecognised output shape (`--count`, custom formats…): keep the raw text,
  // the same way the native row falls back to the io card for unstructured results.
  const raw = outputLines.filter(l => l !== '')
  return {
    kind: 'grep',
    files: [],
    paths: [],
    rawLines: raw,
    parsed: false,
    matchCount: raw.length,
    fileCount: pattern === null ? 0 : 1,
    total: raw.length,
  }
}

/** `webCardModel()` — parses the JSON payload DSH's web tools return. */
export function webCardModel(toolName: string, argsRaw: string | null, output: string | null): WebCardModel | null {
  if (toolName !== 'web_search' && toolName !== 'web_fetch') return null
  if (output === null || output === '') return null
  const kind = toolName === 'web_search' ? 'search' : 'fetch'
  let parsed: Record<string, unknown> | undefined
  try {
    const raw: unknown = JSON.parse(output)
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) parsed = raw as Record<string, unknown>
  } catch {
    parsed = undefined
  }
  const args = argsRaw === null ? undefined : parseArgs(argsRaw)
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const pickList = (...keys: string[]): unknown[] => {
    for (const key of keys) {
      const found = parsed?.[key]
      if (Array.isArray(found) && found.length > 0) return found
    }
    return []
  }
  const rawSources = pickList('results', 'sources', 'items')
  const sources: WebSource[] = []
  for (const entry of rawSources) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const url = str(record['url']) ?? str(record['link']) ?? ''
    const title = str(record['title']) ?? str(record['name']) ?? url
    if (url === '' && title === '') continue
    sources.push({ title, url, snippet: str(record['snippet']) ?? str(record['description']) ?? str(record['content']), published: str(record['published']) ?? str(record['date']) })
  }
  const answer = str(parsed?.['answer']) ?? str(parsed?.['summary']) ?? str(parsed?.['text'])
  const url = str(parsed?.['url']) ?? str(args?.['url']) ?? (kind === 'fetch' ? str(args?.['url']) : null)
  const statusCode = parsed?.['status'] ?? parsed?.['statusCode'] ?? parsed?.['httpStatus']
  const status = statusCode === undefined || statusCode === null ? null : `HTTP ${String(statusCode)}`
  const content = str(parsed?.['content']) ?? str(parsed?.['text'])
  const truncated = parsed?.['truncated'] === true || list(parsed?.['images']).length > 0
  if (answer === null && sources.length === 0 && url === null && status === null && content === null) return null
  return { kind, answer, sources, url, status, content: kind === 'fetch' ? content : null, truncated }
}

/**
 * Native `detail.field.*` labels (zh), copied from the shipped `conversation`
 * dictionary. Keys without a native template keep the raw argument name — see
 * the divergence list in the task report.
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  id: 'ID',
  agent: '智能体 ID',
  job: '任务 ID',
  task: '任务内容',
  owner: '负责人',
  ready: '可开始',
  dependencies: '前置任务',
  writeScopes: '文件范围',
  message: '消息',
  content: '内容',
  source: '来源',
  result: '结果',
  type: '类型',
  time: '时间',
  seq: '事件序号',
  turn: '轮次',
  step: '步骤',
  callId: '调用 ID',
  exitCode: '退出码',
  signal: '信号',
  previousStatus: '中断前状态',
  pid: '进程 ID',
  depth: '层级',
  parent: '父级',
  model: '模型',
  provider: '提供方',
  role: '角色',
  platform: '平台',
  revision: '版本',
  methods: '方法',
  warnings: '提示',
  diagnostics: '诊断',
}

/** The record-array each list-shaped tool reports, in preference order. */
export const LIST_KEYS: Readonly<Record<string, readonly string[]>> = {
  job_list: ['jobs'],
  team_task_list: ['tasks'],
  list_agents: ['agents'],
  schedule_list: ['schedules', 'reminders'],
  session_search: ['events', 'hits', 'results', 'matches'],
  session_event_search: ['events', 'hits', 'results', 'matches'],
  session_event_read: ['events'],
  session_trace: ['events', 'nodes'],
  session_event_trace: ['events', 'nodes'],
  terminal_list: ['terminals', 'sessions'],
  lsp: ['symbols', 'definitions', 'references', 'implementations'],
}

/** Title / field keys per list tool; the first present key wins. */
export const ENTRY_TITLE_KEYS: Readonly<Record<string, readonly string[]>> = {
  job_list: ['command', 'description', 'name', 'id'],
  team_task_list: ['subject', 'title', 'content', 'id'],
  list_agents: ['name', 'botName', 'id'],
  schedule_list: ['prompt', 'cron', 'expression', 'id'],
  session_search: ['message', 'type', 'id'],
  session_event_search: ['message', 'type', 'id'],
  session_event_read: ['message', 'type', 'id'],
  session_trace: ['message', 'type', 'id'],
  session_event_trace: ['message', 'type', 'id'],
  terminal_list: ['command', 'name', 'sessionId', 'id'],
  lsp: ['name', 'symbol', 'id'],
}

/** Field keys per list tool, in display order. */
export const ENTRY_FIELD_KEYS: Readonly<Record<string, readonly string[]>> = {
  job_list: ['id', 'pid', 'exitCode', 'signal'],
  team_task_list: ['id', 'owner', 'ready', 'dependencies', 'writeScopes'],
  list_agents: ['id', 'model', 'provider'],
  schedule_list: ['id', 'type', 'time'],
  session_search: ['type', 'time', 'seq', 'turn', 'step', 'callId', 'agent'],
  session_event_search: ['type', 'time', 'seq', 'turn', 'step', 'callId', 'agent'],
  session_event_read: ['type', 'time', 'seq', 'turn', 'step', 'callId'],
  session_trace: ['type', 'time', 'seq', 'turn', 'step', 'callId', 'depth', 'parent'],
  session_event_trace: ['type', 'time', 'seq', 'turn', 'depth', 'parent'],
  terminal_list: ['id', 'pid', 'exitCode', 'signal'],
  lsp: ['type', 'source', 'result'],
}

/** Group labels, in the order the folds render. */
export const GROUP_LABELS: Readonly<Record<string, string>> = {
  in_progress: '进行中',
  pending: '待处理',
  completed: '已完成',
  failed: '失败',
}
export const GROUP_ORDER = ['in_progress', 'pending', 'completed', 'failed'] as const

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export function asScalar(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : firstLine(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return null
}

export function parseJsonRecord(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined
  try {
    const raw: unknown = JSON.parse(text)
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Map a recorded status string onto the three native marks. */
export function statusOf(value: unknown): DetailsItem['status'] {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  if (text === 'completed' || text === 'done' || text === 'ok' || text === 'success' || text === 'succeeded') return 'completed'
  if (text === 'running' || text === 'in_progress' || text === 'active' || text === 'started') return 'in_progress'
  return 'pending'
}

/** A failed/blocked entry renders native's `pending` mark plus a tone badge. */
export function badgeOf(value: unknown): DetailsItem['badge'] {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  if (text === 'failed' || text === 'error' || text === 'errored') return { tone: 'error', label: '失败' }
  if (text === 'cancelled' || text === 'canceled' || text === 'stopped' || text === 'interrupted') return { tone: 'warning', label: '已停止' }
  return null
}

export function fieldsFrom(record: Record<string, unknown>, keys: readonly string[]): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  for (const key of keys) {
    const value = record[key]
    const text = Array.isArray(value)
      ? (value.length === 0 ? null : `${value.length} 项`)
      : asScalar(value)
    if (text === null) continue
    out.push({ label: FIELD_LABELS[key] ?? key, value: text })
  }
  return out
}

/** One recorded list entry → one native `DetailItem`. */
export function itemFromEntry(toolName: string, entry: unknown, state: ToolRowState): DetailsItem | null {
  if (typeof entry !== 'object' || entry === null) {
    const text = asScalar(entry)
    return text === null ? null : { status: statusOf(state), title: text, subtitle: null, badge: null, fields: [], description: null }
  }
  const record = entry as Record<string, unknown>
  const titleKeys = ENTRY_TITLE_KEYS[toolName] ?? ['title', 'name', 'id']
  let title: string | null = null
  for (const key of titleKeys) {
    title = asString(record[key])
    if (title !== null) break
  }
  if (title === null) title = toolTitle(toolName)
  const statusValue = record['status'] ?? record['state']
  return {
    status: statusOf(statusValue),
    title: firstLine(title),
    subtitle: asString(record['description']) !== null && record['description'] !== title ? firstLine(String(record['description'])) : null,
    badge: badgeOf(statusValue),
    fields: fieldsFrom(record, ENTRY_FIELD_KEYS[toolName] ?? []),
    description: null,
  }
}

/** Group a list of items by their native status mark (≥2 groups only). */
export function groupItems(rows: readonly { readonly status: string; readonly item: DetailsItem }[]): DetailsGroupModel[] | null {
  const buckets = new Map<string, DetailsItem[]>()
  for (const row of rows) {
    const key = row.item.badge !== null ? 'failed' : row.item.status
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [row.item])
    else bucket.push(row.item)
  }
  if (buckets.size < 2) return null
  const groups: DetailsGroupModel[] = []
  for (const key of GROUP_ORDER) {
    const items = buckets.get(key)
    if (items === undefined || items.length === 0) continue
    groups.push({ label: GROUP_LABELS[key] ?? key, count: items.length, items })
  }
  return groups.length > 0 ? groups : null
}

/**
 * `detailsCardModel()` — the row's structured card.
 *
 * Native builds one model per tool from structured meta; this ledger carries
 * only `args` + `output`, so the items come from the recorded JSON payload and
 * fall back to a single argument-derived item (`tool:2926-3974`).
 */
export function detailsCardModel(
  toolName: string,
  state: ToolRowState,
  argsRaw: string | null,
  output: string | null,
): DetailsCardModel | null {
  if (!DETAILS_TOOLS.has(toolName) && toolName !== 'todo_write') return null
  const args = argsRaw === null ? undefined : parseArgs(argsRaw)

  // `todo_write` is a flat list in native (one item per to-do, no groups).
  if (toolName === 'todo_write') {
    const todos = Array.isArray(args?.['todos']) ? (args?.['todos'] as unknown[]) : []
    const items: DetailsItem[] = []
    for (const entry of todos) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const title = asString(record['content']) ?? asString(record['text'])
      if (title === null) continue
      items.push({
        status: statusOf(record['status']),
        title,
        subtitle: null,
        badge: null,
        fields: [],
        description: null,
      })
    }
    if (items.length === 0) return null
    return { caption: null, statusText: null, items, groups: [] }
  }

  // List-shaped tools: one item per recorded entry, grouped by status when the
  // payload carries more than one.
  const payload = parseJsonRecord(output)
  const listKeys = LIST_KEYS[toolName]
  if (payload !== undefined && listKeys !== undefined) {
    for (const key of listKeys) {
      const value = payload[key]
      if (!Array.isArray(value) || value.length === 0) continue
      const rows: { status: string; item: DetailsItem }[] = []
      for (const entry of value) {
        const item = itemFromEntry(toolName, entry, state)
        if (item !== null) rows.push({ status: item.status, item })
      }
      if (rows.length === 0) continue
      const groups = groupItems(rows)
      return {
        caption: `${rows.length} 项`,
        statusText: stateStatus(state),
        items: groups === null ? rows.map(row => row.item) : [],
        groups: groups ?? [],
      }
    }
  }

  // Single-record tools (goal / task / job / terminal / lsp …): prefer the
  // recorded payload, fall back to the call arguments.
  const record = payload ?? args
  const fields = record === undefined ? [] : fieldsFrom(record, Object.keys(record))
  const status: DetailsItem['status'] =
    state === 'ok' ? 'completed' : state === 'error' || state === 'stopped' ? 'pending' : 'in_progress'
  const title = payload === undefined
    ? toolTitle(toolName)
    : (asString(payload['subject']) ?? asString(payload['title']) ?? asString(payload['objective']) ?? toolTitle(toolName))
  const items: DetailsItem[] = [{
    status,
    title,
    subtitle: null,
    badge: state === 'error' ? { tone: 'error', label: '失败' } : null,
    fields,
    description: output !== null && payload === undefined ? output : null,
  }]
  return { caption: argsRaw === null && output === null ? null : ROW_INPUT, statusText: stateStatus(state), items, groups: [] }
}

/** `askCardModel()` — questions from the arguments, answers from the output. */
export function askCardModel(toolName: string, argsRaw: string | null, output: string | null): AskCardModel | null {
  if (toolName !== 'ask_user_question') return null
  const args = argsRaw === null ? undefined : parseArgs(argsRaw)
  const rawQuestions = Array.isArray(args?.['questions']) ? (args?.['questions'] as unknown[]) : []
  const questions: string[] = []
  for (const entry of rawQuestions) {
    if (typeof entry === 'string') { questions.push(entry); continue }
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const text = typeof record['question'] === 'string' ? record['question'] : typeof record['header'] === 'string' ? record['header'] : null
    if (text !== null) questions.push(text)
  }
  if (questions.length === 0) return null
  const answers = contentLines(output ?? '').map(l => l.trim()).filter(l => l !== '')
  return { items: questions.map((question, index) => ({ question, answer: answers[index] ?? null })) }
}

// ── row model ─────────────────────────────────────────────────────────────────

/**
 * Ledger → row model.
 *
 * The plugin's ledger has no `preparing` phase: a `tool-call` entry exists only
 * once the call was dispatched, so a call without a matching `tool-result` is
 * `running`, and a matched result is `ok` / `error` from its `ok` flag.
 */
export function toolRowModel(
  callEntry: LedgerEntry,
  resultEntry: LedgerEntry | undefined,
  options: { readonly cwd?: string | undefined; readonly home?: string | undefined } = {},
): ToolRowModel {
  const toolName = callEntry.name ?? ''
  const variant = classifyTool(toolName)
  const titleKey = toolTitleKey(toolName)
  const state: ToolRowState = resultEntry === undefined ? 'running' : resultEntry.ok === false ? 'error' : 'ok'

  const argsRaw: string | null = callEntry.args ?? null
  const derived = argsRaw === null || argsRaw === '' ? '' : deriveSummary(variant, argsRaw)
  const base = argsRaw === null
    ? ''
    : argsRaw === ''
      ? callEntry.callId ?? ''
      : abbreviateHomePath(relativizeToCwd(derived, options.cwd), options.home)
  const summary = [titleKey === 'tool.title.generic' ? toolName : '', base].filter(Boolean).join(' · ')

  const rawOutput = resultEntry?.output
  const output = rawOutput !== undefined && rawOutput !== '' ? rawOutput : null
  const errorSummary = state === 'error' && output !== null ? firstLine(output) : null
  const filePath = variant === 'read' || variant === 'write' || variant === 'edit' ? pickPath(argsRaw) : null

  return {
    state,
    variant,
    toolName,
    title: toolTitle(toolName),
    summary,
    diffStat: deriveDiffStat(toolName, argsRaw),
    bodyRaw: argsRaw === '' ? null : argsRaw,
    output,
    errorSummary,
    filePath,
  }
}

