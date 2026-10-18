/**
 * Client plugin entry — registers Agent Community into sidebar.panellist + main slots.
 *
 * Two Host faces are used, both acquired the way Cordis requires:
 *
 * 1. `remote.agentCommunity` — this package publishes its own descriptors with
 *    `ctx.remote.$mount(contribution)`, so the namespace service is created by this
 *    very plugin. Reading `ctx.remote.agentCommunity` from a context that has not
 *    declared it throws `cannot get property "remote.agentCommunity" without
 *    inject`; the supported way in is `ctx.inject(['remote.agentCommunity'], …)`,
 *    which hands back a scoped context once the service exists. Injecting the
 *    dotted key at plugin level instead would deadlock: apply() could not run
 *    until a service that only apply() itself publishes.
 * 2. `remote.session` and `uiWorkspace` — mounted by other packages, used for the
 *    model catalog and the directory picker. These are optional capabilities, so
 *    they are acquired through ctx.inject too: the panel must still register when
 *    one of them is missing, and report it per feature instead of vanishing.
 *
 * Every call runs under a deadline, so a stalled mount or transport is reported
 * instead of hanging the panel silently.
 */
import { createContext, createElement, useContext } from 'react'
import type {
  CommunityRemote, CommunityPageProps, CommunityDiagnostics, ModelCatalog, ModelCatalogFailure, ModelGroup,
} from './CommunityPage.tsx'
import { CommunityPage } from './CommunityPage.tsx'
import { installNavBadge } from './navBadge.ts'
// The native-conversation surface is deliberately NOT embedded: the plugin draws its own
// transcript and composer from its own ledger. The two components that used to do that
// (ConversationSlotPanel, RoomTranscriptView) were deleted on  — they were imported
// nowhere and only kept a typecheck surface alive.

// the native conversation surface is no longer embedded (see the registration
// notes at the bottom of this file).

export type { CommunityRemote, CommunityPageProps, CommunityDiagnostics, ModelGroup }

const PANEL_ID = 'agent-community'
const NS = 'agent-community'

/** How long the namespace may take to appear before a stall is reported. */
const MOUNT_DEADLINE_MS = 8000
/** How long one Remote call may take before it is reported as stuck. */
const CALL_DEADLINE_MS = 15000
/**
 * How long `compactRoom` may take.
 *
 * It is the one RPC that WAITS ON A MODEL: the host summarises the room's older messages
 * (bounded there at 45 s) before it rewrites anything. The shared 15 s deadline reported
 * 压缩失败 while the host was still working — and the host then finished and compressed the
 * room anyway, so the user saw a failure and a compressed transcript at the same time.
 */
const COMPACT_CALL_DEADLINE_MS = 90000
/** Directory picking waits for a human. */
const PICK_DEADLINE_MS = 300000
const POLL_INTERVAL_MS = 120

// Hand-written Context type that names the client-side services this plugin
// uses. The real declarations come from DSH client packages that are
// provided at runtime and cannot be installed from npm. Using `as any` on
// the whole ctx parameter would silence all structural checks; this at least
// keeps the callsites typed against what the slots API actually expects.
interface ClientContext {
  readonly remote: {
    // $mount returns Promise<TypertDisposer>; it only publishes descriptors. The
    // namespace service it creates is reached through ctx.inject below.
    $mount(contribution: object): Promise<unknown>
  }
  readonly locale: {
    register(namespace: string, dict: Record<string, Record<string, string>>): void
    /**
     * Namespace-bound translator.
     *
     * There is NO unbound `t`: the service exposes `translate(ns, key)` privately and
     * hands callers a per-namespace function through `bind`. Calling `locale.t(...)`
     * throws (`t is not a function`) — and because the sidebar resolves EVERY panel
     * label inside one map, that throw took the whole panel list down with it, not just
     * this entry.
     */
    bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
  }
  readonly slots: {
    inject(slot: string, factory: () => void): void
    register(opts: Record<string, unknown>, component: unknown): void
  }
  /** Run `callback` on a scope that injects `keys`, once every key is available. */
  inject(keys: readonly string[], callback: (scope: ScopedContext) => void | (() => void)): unknown
}

/** A context that declared the injects it was handed, so their services are readable. */
interface ScopedContext {
  readonly remote: Record<string, unknown>
  readonly uiWorkspace?: { pickDirectory(): Promise<string | null> }
}

type RemoteFace = Record<string, (...args: unknown[]) => Promise<unknown>>

// Minimal codec factory — satisfies requireStrictCodec (mode === 'strict') without pulling
// in schemastery on the client bundle; server validates the actual shape.
function str() {
  return { mode: 'strict' as const, typeSymbol: 'string', create: () => ({ type: 'string' }) }
}
function optstr() {
  return { mode: 'strict' as const, typeSymbol: 'string?', create: () => ({ type: 'string', optional: true }) }
}
function obj(typeSymbol: string) {
  return { mode: 'strict' as const, typeSymbol, create: () => ({ type: 'object' }) }
}

function descriptor(method: string, parameters: { name: string; wire: string; source: string; codec: ReturnType<typeof str> }[]) {
  return {
    id: `@dsh-plugin-agent-community/ui-agent-community#agentCommunity/${method}`,
    service: 'agentCommunity',
    namespace: 'agentCommunity',
    method,
    invocation: { kind: 'direct' as const },
    parameters,
    result: { mode: 'src-json' as const },
  }
}

function param(name: string, codec: ReturnType<typeof str>) {
  return { name, wire: name, source: 'json', codec }
}

const contribution = {
  package: '@dsh-plugin-agent-community/ui-agent-community',
  descriptors: [
    descriptor('snapshot', []),
    descriptor('listBots', []),
    descriptor('getBot', [param('id', str())]),
    descriptor('createBot', [param('input', obj('CreateBotRequest'))]),
    descriptor('updateBot', [param('input', obj('UpdateBotRequest'))]),
    descriptor('deleteBot', [param('input', obj('DeleteBotRequest'))]),
    descriptor('listRooms', []),
    descriptor('createRoom', [param('input', obj('CreateRoomRequest'))]),
    descriptor('updateRoom', [param('input', obj('UpdateRoomRequest'))]),
    descriptor('deleteRoom', [param('input', obj('DeleteRoomRequest'))]),
    descriptor('listMessages', [param('roomId', str())]),
    descriptor('sendMessage', [param('input', obj('SendRoomMessageRequest'))]),
    descriptor('listSkillFiles', [param('dir', str())]),
    descriptor('listRuns', [param('botId', optstr())]),
    descriptor('getBotPresence', [param('botId', str())]),
    descriptor('ensureRoomAgentSession', [param('roomId', str()), param('botId', str())]),
    descriptor('getDefaults', []),
    descriptor('controlRun', [param('input', obj('ControlBotRunRequest'))]),
    descriptor('retryRun', [param('input', obj('RetryBotRunRequest'))]),
    descriptor('ensureRoomSession', [param('roomId', str())]),
    descriptor('proposeGroup', [param('input', obj('ProposeGroupRequest'))]),
    descriptor('confirmGroup', [param('input', obj('ConfirmGroupRequest'))]),
    descriptor('declineGroup', [param('input', obj('DeclineGroupRequest'))]),
    // P0-2/P0-3/P0-1 new RPCs
    descriptor('listLedger', [param('roomId', str()), param('opts', obj('LedgerPageOpts'))]),
    // Deliverable cards: preview one declared file (the host never accepts a bare path).
    descriptor('readDeliverablePreview', [param('input', obj('ReadDeliverablePreviewRequest'))]),
    descriptor('approveBotToolCall', [param('callId', str()), param('outcome', str())]),
    // A bot's question card answers back here: `answer` or `skip`.
    descriptor('answerBotQuestion', [param('input', obj('AnswerBotQuestionRequest'))]),
    // Unread badges: the panel clears a room's count while that room is on screen.
    descriptor('markRoomRead', [param('input', obj('MarkRoomReadRequest'))]),
    // The sidebar entry's background refresh: totals only, no messages attached.
    descriptor('unreadTotals', []),
    descriptor('getSessionVisibility', []),
    descriptor('reconcileSessionVisibility', []),
    // P1-2: host session predicate for conversation.view slot
    // P-clear: clear room messages + cancel stale failed runs
    descriptor('clearMessages', [param('roomId', str())]),
    // Notice rows: a model/permission/command result becomes a durable grey divider row.
    descriptor('noticeRoom', [param('input', obj('NoticeRoomRequest'))]),
    // Compaction: summarise the room's older messages with the host's own LLM path.
    descriptor('compactRoom', [param('input', obj('CompactRoomRequest'))]),
    descriptor('listSkills', [param('roomId', str())]),
    descriptor('loadSkill', [param('roomId', str()), param('name', str())]),
    // Fork: copy a bot into a new bot + its own direct room
    descriptor('copyBot', [param('botId', str()), param('sourceRoomId', str()), param('upToMessageId', str())]),
  ],
}

// React context for passing the RPC remote into the slot component tree without
// going through window globals, which break under hot-reload and multiple instances.
const RemoteContext = createContext<CommunityRemote | undefined>(undefined)
const DiagnosticsContext = createContext<(() => CommunityDiagnostics) | undefined>(undefined)

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** Reject `promise` with a named deadline error once `ms` elapses. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} 在 ${ms / 1000}s 内没有任何响应（Promise 未 settle）`))
    }, ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Unwrap the RemoteResult<T> envelope the Gateway always returns. */
function unwrap<T>(result: unknown, what: string): T {
  if (result !== null && typeof result === 'object' && 'ok' in result) {
    const r = result as { ok: boolean; value?: unknown; error?: { code?: string; message?: string } }
    if (r.ok) return r.value as T
    const { code, message } = r.error ?? {}
    throw new Error(`${what} 失败：${code ?? 'unknown'}${message ? ` — ${message}` : ''}`)
  }
  // Fallback: if the face ever returns a bare value, pass it through.
  return result as T
}

function CommunityPagePanel() {
  const remote = useContext(RemoteContext)
  const diagnostics = useContext(DiagnosticsContext)
  if (!remote || !diagnostics) {
    return createElement(
      'div',
      { style: { padding: 24, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 } },
      'Bots团队 初始化中…',
    )
  }
  return createElement(CommunityPage, { remote, diagnostics })
}

// Panel icon — 20×20 SVG rendered in the sidebar panel list
//
// Carries `data-community-panel`, an anchor for the unread badge. The badge used to find
// the sidebar button by accessible name — i.e. by the panel ID, because the entry had no
// label — and once the entry got a real name ("Bots团队") that lookup silently stopped
// matching, taking the unread count with it. The icon is the one node this plugin owns
// inside that button, so the marker lives here and `navBadge` walks up to the button.
function CommunityPanelIcon({ size, active }: { size: number; active: boolean }) {
  const stroke = active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)'
  return createElement(
    'svg',
    {
      width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
      'aria-hidden': true, 'data-community-panel': PANEL_ID,
    },
    createElement('circle', { cx: 7, cy: 10, r: 4.5, stroke, strokeWidth: 1.5 }),
    createElement('circle', { cx: 13, cy: 10, r: 4.5, stroke, strokeWidth: 1.5 }),
  )
}

export const inject = ['slots', 'remote', 'locale', 'sessions']

export function apply(ctx: ClientContext): void {
  const state: { status: CommunityDiagnostics['status']; detail: string } = {
    status: 'pending',
    detail: '$mount 已调用，等待 agentCommunity 命名空间就绪…',
  }
  const diagnostics = (): CommunityDiagnostics => ({ status: state.status, detail: state.detail })

  interface Capabilities {
    community: RemoteFace | undefined
    session: {
      modelCatalog(): Promise<unknown>
      canOpenWorkspacePath(): Promise<boolean>
      workspacePathApplications(request: { path: string }, signal?: AbortSignal): Promise<Array<{
        id: string; name: string; default: boolean; icon: string | null
      }>>
      openWorkspacePath(request: {
        path: string
        application?: string
        action?: 'reveal'
      }, signal?: AbortSignal): Promise<{ opened: boolean }>
    } | undefined
    workspace: { pickDirectory(): Promise<string | null> } | undefined
    /** The right Sidebar's navigation controller; only present while a Session is on screen. */
    sidebarRight: { openResource(address: string): void } | undefined
  }
  const caps: Capabilities = { community: undefined, session: undefined, workspace: undefined, sidebarRight: undefined }

  // The mount promise is observed, never awaited blindly: a rejection is captured
  // for the diagnostic message, a stall is caught by the deadline below.
  const mountFailure: { error?: unknown } = {}
  console.info('[agent-community] client plugin applying; mounting RPC contribution')
  const ready = ctx.remote.$mount(contribution)
  ready.then(
    () => undefined,
    (error: unknown) => { mountFailure.error = error },
  )

  // Cordis grants access to a dotted namespace service only through a context
  // that injects it. This callback fires as soon as $mount has published the
  // namespace, and is the one legal handle on it.
  ctx.inject(['remote.agentCommunity'], (scope) => {
    caps.community = scope.remote['agentCommunity'] as RemoteFace
    state.status = 'ready'
    state.detail = 'RPC 已就绪'
    return () => { caps.community = undefined }
  })

  // Optional Host faces: the panel must survive their absence.
  ctx.inject(['remote.session'], (scope) => {
    caps.session = scope.remote['session'] as {
      modelCatalog(): Promise<unknown>
      canOpenWorkspacePath(): Promise<boolean>
      workspacePathApplications(request: { path: string }, signal?: AbortSignal): Promise<Array<{
        id: string; name: string; default: boolean; icon: string | null
      }>>
      openWorkspacePath(request: {
        path: string
        application?: string
        action?: 'reveal'
      }, signal?: AbortSignal): Promise<{ opened: boolean }>
    }
    return () => { caps.session = undefined }
  })
  ctx.inject(['uiWorkspace'], (scope) => {
    caps.workspace = scope.uiWorkspace
    return () => { caps.workspace = undefined }
  })
  // The right Sidebar's navigation controller. Optional: a deployment without it simply
  // falls back to the in-panel preview dialog.
  ctx.inject(['sidebarRight'], (scope) => {
    caps.sidebarRight = (scope as unknown as {
      sidebarRight?: { openResource(address: string): void }
    }).sidebarRight
    return () => { caps.sidebarRight = undefined }
  })

  /**
   * A cancellation signal with a deadline for one host call.
   *
   * `workspacePathApplications` and `openWorkspacePath` declare a `signal` parameter;
   * calling them without one made the native menu answer "无法获取应用列表" — the call
   * never reached the host. Every DSH call site passes a signal, so this one does too.
   */
  function deadlineSignal(timeoutMs: number): { signal: AbortSignal; done(): void } {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    return { signal: controller.signal, done: () => { clearTimeout(timer) } }
  }

  /** One `dsh-resource://file/…` path segment, encoded the way DSH's chat encodes it. */
  function encodeSegment(segment: string): string {
    return encodeURIComponent(segment).replace(/%3A/gi, ':')
  }

  /**
   * The `dsh-resource://file/session/<id>/<path>` address of one file.
   *
   * Same grammar as `ui-chat`'s `fileAddressFor`: absolute paths stay absolute, so a
   * file outside the Session workspace still resolves through that Session's read
   * authority (which is what lets a Bot-workspace file preview in the Sidebar at all).
   */
  function fileAddress(sessionId: string, path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
    const encoded = normalized.split('/').map(encodeSegment).join('/')
    return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encoded}`
  }

  /**
   * The Session currently retained by the main view.
   *
   * The plugin's own panel renders in a root-scope main slot, so it has no session
   * prop of its own. DSH's `UiSession` solves the same problem the same way: the one
   * Session the main view retains is the one on screen. Returns undefined when the
   * user is somewhere without a Session, and the caller then keeps the in-panel preview.
   */
  function currentViewSessionId(): string | undefined {
    const sessions = (ctx as unknown as {
      sessions?: {
        list?: {
          getSnapshot?: () => {
            byId?: Record<string, { retainedBy?: { mainView?: number } }>
          }
        }
      }
    }).sessions
    try {
      const byId = sessions?.list?.getSnapshot?.()?.byId ?? {}
      for (const [id, entry] of Object.entries(byId)) {
        if ((entry?.retainedBy?.mainView ?? 0) > 0) return id
      }
    } catch {
      // A missing or changed Session store only costs the Sidebar preview.
    }
    return undefined
  }

  /**
   * Open one file in the right Sidebar's document preview, the way DSH's own file
   * cards do. Returns false when this deployment has no Session or no right Sidebar,
   * and the card then falls back to its in-panel preview.
   */
  function openFilePreview(path: string): boolean {
    const sessionId = currentViewSessionId()
    const right = caps.sidebarRight
    if (sessionId === undefined || right === undefined) return false
    try {
      right.openResource(fileAddress(sessionId, path))
      return true
    } catch {
      return false
    }
  }

  async function ensureNamespace(): Promise<RemoteFace> {
    const deadline = Date.now() + MOUNT_DEADLINE_MS
    for (;;) {
      if (caps.community !== undefined) return caps.community
      if (mountFailure.error !== undefined) {
        const message = describe(mountFailure.error)
        state.status = 'failed'
        state.detail = `$mount 失败：${message}`
        throw new Error(`agentCommunity RPC 挂载失败：${message}`)
      }
      if (Date.now() >= deadline) {
        state.status = 'failed'
        state.detail = `$mount 在 ${MOUNT_DEADLINE_MS / 1000}s 内未完成（Promise 既未 resolve 也未 reject）`
        throw new Error(`agentCommunity RPC 挂载超时：ctx.remote.$mount() ${state.detail}`)
      }
      await delay(POLL_INTERVAL_MS)
    }
  }

  // call() is the single point that resolves the namespace, invokes the method
  // under a deadline, and unwraps the RemoteResult<T> envelope.
  async function call<T>(method: string, ...args: unknown[]): Promise<T> {
    return callWithDeadline<T>(method, CALL_DEADLINE_MS, ...args)
  }

  /** `call` for the one method whose work legitimately outlives the shared deadline. */
  async function callWithDeadline<T>(method: string, deadlineMs: number, ...args: unknown[]): Promise<T> {
    const ns = await ensureNamespace()
    const fn = ns[method]
    if (typeof fn !== 'function') {
      throw new Error(`agentCommunity/${method} 未在 RPC 面上注册（当前可用方法：${Object.keys(ns).join(', ') || '无'}）`)
    }
    return unwrap<T>(await withDeadline(fn(...args), deadlineMs, `${NS}/${method}`), `${NS}/${method}`)
  }

  /**
   * Providers and models configured in DSH Settings, as the model selector sees them.
   *
   * The catalog is the ONLY source of provider ids, model ids and display names here:
   * nothing is baked in, so a provider the user added or renamed in Settings appears
   * without a code change. `modelCatalog` also carries the deployment default and the
   * providers Settings configured but whose catalog could not be built — the Bot form
   * needs both to start on the user's default and to explain a missing provider.
   */
  async function modelCatalog(): Promise<ModelCatalog> {
    const session = caps.session
    if (session === undefined) throw new Error('模型目录不可用：remote.session 未就绪')
    const value = unwrap<{
      groups?: ModelGroup[]
      failures?: ModelCatalogFailure[]
      default?: { provider?: string; model?: string; reasoningEffort?: string }
    }>(
      await withDeadline(session.modelCatalog(), CALL_DEADLINE_MS, 'session/modelCatalog'),
      'session/modelCatalog',
    )
    const fallback = value?.default?.provider !== undefined && value?.default?.model !== undefined
      ? {
        provider: value.default.provider,
        model: value.default.model,
        ...(value.default.reasoningEffort !== undefined
          ? { reasoningEffort: value.default.reasoningEffort }
          : {}),
      }
      : undefined
    const source = value?.groups ?? []
    // Settings owns the default model; order it first so a form or menu that starts at
    // `groups[0]` starts where the user configured it, not on an arbitrary provider.
    const ordered = fallback === undefined
      ? source
      : [...source].sort((a, b) => Number(b.id === fallback.provider) - Number(a.id === fallback.provider))
    const groups: ModelGroup[] = ordered.map(group => {
      const models = [...group.models]
      if (fallback !== undefined && group.id === fallback.provider) {
        const mi = models.findIndex(model => model.id === fallback.model)
        if (mi > 0) models.unshift(...models.splice(mi, 1))
      }
      return { ...group, models }
    })
    return {
      groups,
      failures: [...(value?.failures ?? [])],
      ...(fallback !== undefined ? { default: fallback } : {}),
    }
  }

  /** The ordered groups alone — the composer's menu needs neither failures nor the default. */
  async function listModelGroups(): Promise<ModelGroup[]> {
    return [...(await modelCatalog()).groups]
  }

  /** Native/browser directory picker; resolves null when the user cancels. */
  async function pickDirectory(): Promise<string | null> {
    const workspace = caps.workspace
    if (workspace === undefined) throw new Error('目录选择器不可用：uiWorkspace 未就绪')
    return await withDeadline(workspace.pickDirectory(), PICK_DEADLINE_MS, 'uiWorkspace/pickDirectory')
  }

  const remote: CommunityRemote = {
    snapshot: () => call('snapshot'),
    createBot: (input) => call('createBot', input),
    updateBot: (input) => call('updateBot', input),
    deleteBot: (input) => call('deleteBot', input),
    listRooms: () => call('listRooms'),
    createRoom: (input) => call('createRoom', input),
    updateRoom: (input) => call('updateRoom', input),
    deleteRoom: (input) => call('deleteRoom', input),
    sendMessage: (input) => call('sendMessage', input),
    listSkillFiles: (dir) => call('listSkillFiles', dir),
    listRuns: (botId) => call('listRuns', botId),
    getBotPresence: (botId) => call('getBotPresence', botId),
    listModelGroups,
    modelCatalog,
    pickDirectory,
    getDefaults: () => call('getDefaults'),
    controlRun: (input) => call('controlRun', input),
    retryRun: (input) => call('retryRun', input),
    ensureRoomSession: (roomId) => call('ensureRoomSession', roomId),
    proposeGroup: (input) => call('proposeGroup', input),
    confirmGroup: (input) => call('confirmGroup', input),
    declineGroup: (input) => call('declineGroup', input),
    listLedger: (roomId, opts) => call('listLedger', roomId, opts),
    readDeliverablePreview: (input) => call('readDeliverablePreview', input),
    // The OS-open surface is the host's Session Remote, already mounted for the panel
    // (`remote.session`); only the type was narrowed to modelCatalog. A host without a
    // desktop answers `false`, and the card then simply hides its open control.
    canOpenWorkspacePath: async () => {
      const session = caps.session
      if (session === undefined) return false
      try {
        return await session.canOpenWorkspacePath()
      } catch {
        return false
      }
    },
    workspacePathApplications: async (path) => {
      const session = caps.session
      if (session === undefined) return []
      const deadline = deadlineSignal(10_000)
      try {
        return await session.workspacePathApplications({ path }, deadline.signal)
      } finally {
        deadline.done()
      }
    },
    openWorkspacePath: async (request) => {
      const session = caps.session
      if (session === undefined) throw new Error('当前宿主没有可用的文件打开能力')
      const deadline = deadlineSignal(15_000)
      try {
        return await session.openWorkspacePath(request, deadline.signal)
      } finally {
        deadline.done()
      }
    },
    // The native path DSH's own cards take: hand the file to the right Sidebar's
    // document preview (which renders Office/Excel through the host converters).
    // False means this deployment has no on-screen Session or no right Sidebar, and
    // the card falls back to its in-panel dialog.
    openFilePreview: (path) => openFilePreview(path),
    approveBotToolCall: (callId, outcome) => call('approveBotToolCall', callId, outcome),
    answerBotQuestion: (input) => call('answerBotQuestion', input),
    markRoomRead: (input) => call('markRoomRead', input),
    unreadTotals: () => call('unreadTotals'),
    getSessionVisibility: () => call('getSessionVisibility'),
    reconcileSessionVisibility: () => call('reconcileSessionVisibility'),
    clearMessages: (roomId) => call('clearMessages', roomId),
    noticeRoom: (input) => call('noticeRoom', input),
    // A compaction WAITS ON A MODEL, so it gets its own deadline. The shared 15 s one is a
    // "stuck RPC" detector for calls that answer from local state; applying it here reported
    // 压缩失败 while the host was still summarising, and the host would then finish and
    // rewrite the room anyway — a failure message followed by the compression actually
    // happening. The host's own 45 s summariser timeout stays the first to fire.
    compactRoom: (input) => callWithDeadline('compactRoom', COMPACT_CALL_DEADLINE_MS, input),
    listSkills: (roomId) => call('listSkills', roomId),
    loadSkill: (roomId, name) => call('loadSkill', roomId, name),
    copyBot: (botId, sourceRoomId, upToMessageId) => call('copyBot', botId, sourceRoomId, upToMessageId),
  }

  // Self-contained panel: the entry declares no child slot, so it consumes no
  // renderSlot. remote and diagnostics arrive through React Context below.
  function CommunityPageWithRemote(_props: Record<string, unknown>) {
    const slotProps: CommunityPageProps = { remote, diagnostics }
    return createElement(
      RemoteContext.Provider,
      { value: remote },
      createElement(
        DiagnosticsContext.Provider,
        { value: diagnostics },
        createElement(CommunityPagePanel, slotProps),
      ),
    )
  }

  // The sidebar entry's visible name. `PANEL_ID` stays `agent-community` on purpose:
  // the host addresses this panel by id (the sidebar button's aria-label is the id, not
  // this label) and `navBadge.ts` finds it by that same id to hang the unread count on,
  // so renaming the id would silently drop the badge.
  ctx.locale.register(NS, {
    zh: { panel: 'Bots团队' },
    en: { panel: 'Bots团队' },
  })
  // Bound ONCE: `bind` is the documented way in (there is no unbound `t`), and the
  // sidebar re-reads the label through this function on every locale change.
  const t = ctx.locale.bind(NS)

  // Registration is wrapped: a throw inside a slot factory removes the entry with no
  // trace, which is indistinguishable from "the plugin never loaded". The label makes
  // the cause findable in the browser console.
  const registerSlot = (name: string, fn: () => void): void => {
    try {
      fn()
    } catch (error: unknown) {
      console.error(
        `[agent-community] failed to register slot "${name}":`,
        error instanceof Error ? error.stack ?? error.message : error,
      )
    }
  }

  // The plugin's own sidebar entry carries the TOTAL unread count. The slot has no badge prop
  // (registration is id/order/label only, and the icon cell gets { size, active }), so the badge is
  // decorated onto the button the sidebar renders for PANEL_ID — see navBadge.ts.
  //
  // The disposer is handed to the host so the observer and the badge go away with the plugin; a
  // failed install must not take the whole panel down with it.
  try {
    const disposeNavBadge = installNavBadge(PANEL_ID, async () => {
      // One tiny read, and only while another panel is in front: the panel's own poll covers the
      // time it is visible. This is what keeps the number right when the user is somewhere else.
      const totals = await call<{ total?: number }>('unreadTotals')
      return typeof totals?.total === 'number' ? totals.total : undefined
    })
    ctx.inject([], () => disposeNavBadge)
  } catch (error: unknown) {
    console.error('[agent-community] failed to install the sidebar-entry badge:', error)
  }

  // sidebar.panellist: kind="list", scope="root"
  registerSlot('sidebar.panellist', () => ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 22,
        locale: NS,
        // ── THE ROW'S VISIBLE NAME ──────────────────────────────────────────────
        //
        // Without `label`, the sidebar falls back to the panel's ID, which is why this
        // entry read "agent-community" no matter what the namespace dictionary said:
        // `locale: NS` only tells the sidebar which dictionary to re-render on, it does
        // not look the label up. A FUNCTION, not a string, so the row re-reads it when
        // the language changes (`resolveSlotLabel` calls it; the sidebar re-syncs on
        // `ctx.locale.subscribe`).
        label: () => t('panel'),
      },
      CommunityPanelIcon,
    ),
  ))

  // main: kind="keyed", scope="root"
  // Self-contained panel: NO child slot. The plugin draws its own transcript and
  // composer from its own ledger, so it must not declare a session-scoped child
  // slot nor render the native conversation surface — doing so pulled every room
  // back onto DSH's native session pipeline (and its archived-session lifecycle),
  // which is explicitly not wanted.
  registerSlot('main', () => ctx.slots.inject('main', () =>
    ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
    }, CommunityPageWithRemote),
  ))

  // NOTE: 'agent-community.conversation' and 'conversation.view' are deliberately
  // NOT registered. The native transcript/composer path was removed on purpose.
}
