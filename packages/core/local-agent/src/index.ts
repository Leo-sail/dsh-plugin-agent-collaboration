/**
 * Local Agent — host service (A1: discovery foundation).
 *
 * WHAT THIS PACKAGE IS FOR. A Bot's model route can be served by an agent CLI already
 * installed and signed in on the user's machine (Claude Code, Codex, any ACP agent). A2/A6
 * register those routes as DSH LLM providers; this file is the base they build on: find the
 * CLIs, keep the user's custom ACP agents, persist the little state involved, and expose the
 * settings snapshot over the plugin's Remote surface.
 *
 * WHY A SEPARATE SERVICE. Discovery is useful even when route registration is unavailable on
 * an older host (`supported` is reported separately), and keeping it out of the 8k-line
 * agent-community service keeps the failure surface small.
 *
 * @module
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { LocalAgentAdapter } from './adapter.ts'
import { CodexDriver } from './drivers/codex.ts'
import type { LocalAgentDriver } from './drivers/types.ts'
import { ENGINES, customRoute, engineOf, validateCustomAgent } from './engines.ts'
import { approveAgentActionTool, type ApprovalPort } from './tools.ts'
import { findExecutable, probeVersion, refreshSearchDirs } from './discover.ts'
import { emptyState, loadState, newCustomAgentId, saveState, type PersistedLocalAgentState } from './state.ts'
import type {
  AddCustomAgentInput,
  Config as LocalAgentConfig,
  CustomAgent,
  LocalAgentKind,
  LocalAgentRouteView,
  LocalAgentSnapshot,
  LocalAgentSessionRecord,
  RemoveCustomAgentInput,
  UpdateCustomAgentInput,
} from './types.ts'

export type * from './types.ts'
export { ENGINES, customRoute, engineOf, isLocalAgentRoute, validateCustomAgent } from './engines.ts'

/** Plugin config schema; every new knob is documented on the interface in types.ts. */
export const Config: z<LocalAgentConfig> = z.object({
  enabled: z.boolean().default(true),
  homeDir: z.string().required(false),
  extraSearchDirs: z.array(z.string()).default([]),
  versionProbeTimeoutMs: z.number().step(1).min(1000).default(10_000),
  toolsBridge: z.boolean().default(true),
})

/** The methods the browser may call through the Remote gateway. */
const REMOTE_METHODS = [
  'snapshot',
  'refresh',
  'addCustomAgent',
  'updateCustomAgent',
  'removeCustomAgent',
] as const

/**
 * Where `local-agent/state.json` lives.
 *
 * Same precedence as the community board: explicit config, then the harness home, then the
 * default. An isolated `$DSH_HOME` must stay isolated.
 */
export function resolveLocalAgentHome(configured?: string): string {
  if (configured !== undefined && configured !== '') return configured
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

interface ViewSpec {
  readonly route: string
  readonly name: string
  readonly kind: LocalAgentKind
  readonly signInHint?: string | undefined
}

function routeView(spec: ViewSpec, custom: boolean, path: string | undefined): LocalAgentRouteView {
  return {
    route: spec.route,
    name: spec.name,
    kind: spec.kind,
    custom,
    available: path !== undefined,
    ...(path === undefined ? {} : { path }),
    ...(spec.signInHint === undefined ? {} : { signInHint: spec.signInHint }),
  }
}

/**
 * Scan every built-in route plus the custom agents.
 *
 * Pure discovery: no state is written, no process is started. Exported so tests and the
 * spike harness can verify discovery without booting the service.
 */
export async function discoverAgents(
  custom: readonly CustomAgent[],
  extraSearchDirs: readonly string[] = [],
): Promise<LocalAgentRouteView[]> {
  await refreshSearchDirs(extraSearchDirs)
  const views: LocalAgentRouteView[] = []
  for (const spec of Object.values(ENGINES)) {
    views.push(routeView(spec, false, findExecutable(spec.command, spec.appPaths)))
  }
  for (const agent of custom) {
    views.push(routeView(
      { route: customRoute(agent.id), name: agent.name, kind: 'acp' },
      true,
      findExecutable(agent.command),
    ))
  }
  return views
}

/** Host service: discovery + custom agents + settings RPC. */
export class LocalAgentService extends TypertRemoteService {
  /** A2/A6 need `llm`; declaring it here keeps activation honest (no half-mounted service). */
  static inject = ['llm'] as const
  static Config: z<LocalAgentConfig> = Config

  private readonly cfg: {
    readonly enabled: boolean
    readonly extraSearchDirs: readonly string[]
    readonly versionProbeTimeoutMs: number
    readonly toolsBridge: boolean
  }
  private readonly home: string
  private readonly statePath: string
  private state: PersistedLocalAgentState = emptyState()
  private detected: LocalAgentRouteView[] = []
  private scannedAt = ''
  private writeQueue: Promise<void> = Promise.resolve()
  /** Driver per registered route (currently Codex only; ACP/Claude add entries later). */
  private drivers = new Map<string, LocalAgentDriver>()
  /** Executable each driver was created for, so a rescan can tell "unchanged" from "moved". */
  private driverPaths = new Map<string, string>()
  private adapter: LocalAgentAdapter | undefined
  private registration: AdapterRegistrationHandle | undefined
  /** Host approval service, captured when present; absent means every agent approval is denied. */
  private approvalService: ApprovalPort | undefined
  private toolsDisposer: (() => void) | undefined
  /** Resolved when Cordis injects the host's LLM registry (absent on hosts that cannot route). */
  private llmService: { registerAdapter(providers: string[], adapter: LocalAgentAdapter): AdapterRegistrationHandle } | undefined

  constructor(ctx: Context, config: LocalAgentConfig = {}) {
    super(ctx, 'localAgent')
    this.cfg = {
      enabled: config.enabled ?? true,
      extraSearchDirs: config.extraSearchDirs ?? [],
      versionProbeTimeoutMs: config.versionProbeTimeoutMs ?? 10_000,
      toolsBridge: config.toolsBridge !== false,
    }
    this.home = resolveLocalAgentHome(config.homeDir)
    this.statePath = join(this.home, 'local-agent', 'state.json')
    // The documented way for a Service to hold an injected service: a scoped callback that
    // fires once the service exists. Reading this.ctx.llm directly during load throws
    // "cannot get required service ... in inactive context" — measured as a fatal load failure.
    ctx.inject(['llm'], (child) => {
      const service = (child as unknown as { llm?: unknown }).llm
      if (service !== null && typeof service === 'object' && typeof (service as { registerAdapter?: unknown }).registerAdapter === 'function') {
        this.llmService = service as { registerAdapter(providers: string[], adapter: LocalAgentAdapter): AdapterRegistrationHandle }
        // REGISTER SYNCHRONOUSLY HERE. `registerAdapter` creates a Cordis effect on the LLM
        // service's context; calling it from a later timer hit "cannot create effect on
        // inactive context" (measured as a silent no-route boot). The injection callback is a
        // lifecycle window where that effect is legal. Later scans only call handle.replace().
        this.scanSync()
        this.rebuildRoutes()
      }
      // No cleanup here on purpose: returning a disposer makes Cordis tear the child scope
      // down again (measured: supported flipped back to false before the first scan finished).
      // This service's own fiber disposal releases the adapter registration.
    })
    // Approval + tool surface: both optional, so discovery still works on a bare host.
    ctx.inject(['approval'], (child) => {
      const approval = (child as unknown as { approval?: ApprovalPort }).approval
      if (approval !== undefined && typeof approval.request === 'function') this.approvalService = approval
    })
    ctx.inject(['tools'], (child) => {
      const tools = (child as unknown as { tools?: { register(definition: unknown): () => void } }).tools
      if (tools === undefined || typeof tools.register !== 'function') return
      this.toolsDisposer = tools.register(approveAgentActionTool(() => this.approvalService))
    })
    ctx.effect(() => () => { void this.dispose() }, 'local-agent: runtime')
    // DEFERRED ON PURPOSE: a Cordis plugin's own fiber is not active while its constructor is
    // still being loaded, and reading an injected service in that window throws
    // "cannot get required service ... in inactive context" — measured on 2026-11-10 as a fatal
    // load failure. A macrotask runs after activation completes.
    const boot = setTimeout(() => {
      void this.initialize().catch((error: unknown) => {
        ctx.logger?.warn?.(`[local-agent] initialization failed: ${String(error)}`)
      })
    }, 0)
    boot.unref?.()
  }

  private async initialize(): Promise<void> {
    this.state = await loadState(this.statePath, message => this.ctx.logger?.warn?.(message))
    if (!this.cfg.enabled) {
      this.ctx.logger?.info?.('[local-agent] disabled by config; no scan performed')
      return
    }
    await this.scan()
    await this.probeVersions()
    this.rebuildRoutes()
  }

  /** The host LLM registry, or undefined on a host that cannot register routes. */
  private llm(): { registerAdapter(providers: string[], adapter: LocalAgentAdapter): AdapterRegistrationHandle } | undefined {
    return this.llmService
  }

  /** Whether this host can register model routes (A2); independent of discovery. */
  private supported(): boolean {
    return this.llm() !== undefined
  }

  /**
   * Synchronous scan used at registration time: PATH + app-bundle candidates only.
   * The login-shell PATH and version probes are filled in by the async scan afterwards.
   */
  private scanSync(): void {
    const detected: LocalAgentRouteView[] = []
    for (const spec of Object.values(ENGINES)) {
      detected.push(routeView(spec, false, findExecutable(spec.command, spec.appPaths)))
    }
    for (const agent of this.state.custom) {
      detected.push(routeView(
        { route: customRoute(agent.id), name: agent.name, kind: 'acp' },
        true,
        findExecutable(agent.command),
      ))
    }
    this.detected = detected
    this.scannedAt = new Date().toISOString()
  }

  private async scan(): Promise<void> {
    this.detected = await discoverAgents(this.state.custom, this.cfg.extraSearchDirs)
    this.scannedAt = new Date().toISOString()
    const found = this.detected.filter(entry => entry.available)
    const summary = found.length === 0
      ? 'no agent CLI found'
      : found.map(entry => `${entry.route}=${entry.path ?? '?'}`).join(', ')
    this.ctx.logger?.info?.(`[local-agent] scan: ${summary}`)
  }

  /** Fill in `--version` for the routes that resolved; display-only, never throws. */
  private async probeVersions(): Promise<void> {
    this.detected = await Promise.all(this.detected.map(async (entry): Promise<LocalAgentRouteView> => {
      if (!entry.available || entry.path === undefined) return entry
      const spec = engineOf(entry.route, this.state.custom)
      if (spec === undefined) return entry
      const version = await probeVersion(entry.path, spec.versionArgs ?? ['--version'], this.cfg.versionProbeTimeoutMs)
      return version === undefined ? entry : { ...entry, version }
    }))
  }

  private persist(): Promise<void> {
    const next = this.state
    this.writeQueue = this.writeQueue
      .then(() => saveState(this.statePath, next))
      .catch((error: unknown) => {
        this.ctx.logger?.warn?.(`[local-agent] cannot save state: ${String(error)}`)
      })
    return this.writeQueue
  }

  /** Detached snapshot for the settings page. */
  snapshot(): LocalAgentSnapshot {
    return {
      enabled: this.cfg.enabled,
      supported: this.supported(),
      home: this.home,
      scannedAt: this.scannedAt,
      detected: this.detected.map(entry => ({ ...entry })),
      custom: this.state.custom.map(agent => ({ ...agent, args: [...agent.args] })),
      registeredRoutes: [...this.drivers.keys()],
    }
  }

  /** Re-scan on demand (settings refresh), including version probes. */
  async refresh(): Promise<LocalAgentSnapshot> {
    if (!this.cfg.enabled) return this.snapshot()
    await this.scan()
    await this.probeVersions()
    this.rebuildRoutes()
    return this.snapshot()
  }

  async addCustomAgent(input: AddCustomAgentInput): Promise<LocalAgentSnapshot> {
    const clean = validateCustomAgent(input)
    const agent: CustomAgent = { id: newCustomAgentId(), ...clean }
    this.state = { ...this.state, custom: [...this.state.custom, agent] }
    await this.persist()
    await this.scan()
    this.rebuildRoutes()
    return this.snapshot()
  }

  async updateCustomAgent(input: UpdateCustomAgentInput): Promise<LocalAgentSnapshot> {
    const existing = this.state.custom.find(agent => agent.id === input.id)
    if (existing === undefined) throw new Error(`Unknown local agent: ${input.id}`)
    const clean = validateCustomAgent({
      name: input.name ?? existing.name,
      command: input.command ?? existing.command,
      args: input.args ?? existing.args,
    })
    this.state = {
      ...this.state,
      custom: this.state.custom.map(agent => (agent.id === input.id ? { id: existing.id, ...clean } : agent)),
    }
    await this.persist()
    await this.scan()
    this.rebuildRoutes()
    return this.snapshot()
  }

  async removeCustomAgent(input: RemoveCustomAgentInput): Promise<LocalAgentSnapshot> {
    if (!this.state.custom.some(agent => agent.id === input.id)) {
      throw new Error(`Unknown local agent: ${input.id}`)
    }
    this.state = { ...this.state, custom: this.state.custom.filter(agent => agent.id !== input.id) }
    await this.persist()
    await this.scan()
    this.rebuildRoutes()
    return this.snapshot()
  }

  /**
   * Build the route→driver table for everything discovery found, then register or refresh the
   * adapter's routes.
   *
   * IDEMPOTENCE IS LOAD-BEARING. This runs twice at boot (LLM injection, then the deferred
   * scan) and on every settings refresh. Rebuilding the drivers unconditionally replaced the
   * live Codex process mid-turn: the continuation stream then saw a driver with no session,
   * started a SECOND thread/MCP server, and the parked tool call was never resolved
   * (measured 2026-11-10). Drivers are therefore reused unless the executable moved.
   */
  private rebuildRoutes(): void {
    if (!this.cfg.enabled || !this.supported()) return
    const wanted = new Map<string, { executable: string; name: string; args: readonly string[] }>()
    for (const entry of this.detected) {
      if (!entry.available || entry.path === undefined) continue
      const spec = engineOf(entry.route, this.state.custom)
      if (spec === undefined) continue
      // A2 drives Codex natively; ACP drivers land in A2b, Claude in A6. Registering a route
      // without a driver would put an unusable model in the Bot picker.
      if (spec.kind === 'codex') {
        wanted.set(entry.route, { executable: entry.path, name: spec.name, args: spec.args })
      }
    }

    const unchanged = wanted.size === this.drivers.size
      && [...wanted].every(([route, spec]) => this.driverPaths.get(route) === spec.executable)
    if (unchanged) {
      // Boot called us once before the async scan finished (routes empty then); if the scan
      // now found routes, the first registration never happened.
      this.ensureRegistration([...this.drivers.keys()])
      return
    }

    const next = new Map<string, LocalAgentDriver>()
    for (const [route, spec] of wanted) {
      const existing = this.drivers.get(route)
      if (existing !== undefined && this.driverPaths.get(route) === spec.executable) {
        next.set(route, existing)
        continue
      }
      if (existing !== undefined) void existing.dispose()
      next.set(route, new CodexDriver({ route, name: spec.name, executable: spec.executable, args: spec.args }))
    }
    for (const [route, driver] of this.drivers) {
      if (!next.has(route)) void driver.dispose()
    }
    this.drivers = next
    this.driverPaths = new Map([...wanted].map(([route, spec]) => [route, spec.executable]))
    this.ensureRegistration([...next.keys()])
    this.ctx.logger?.info?.(`[local-agent] routes registered: ${[...next.keys()].join(', ') || '(none)'}`)
  }

  /** Register the adapter once; afterwards only replace its route list. */
  private ensureRegistration(routes: string[]): void {
    const llm = this.llm()
    if (llm === undefined) {
      this.ctx.logger?.warn?.('[local-agent] this host cannot register model routes; discovery only')
      return
    }
    if (this.registration === undefined) {
      if (routes.length === 0) return
      this.adapter = new LocalAgentAdapter(this.adapterDeps())
      this.registration = llm.registerAdapter(routes, this.adapter)
      return
    }
    this.registration.replace(routes)
  }

  private adapterDeps(): ConstructorParameters<typeof LocalAgentAdapter>[0] {
    return {
      driverFor: route => this.drivers.get(route),
      specFor: route => engineOf(route, this.state.custom),
      recordFor: sessionId => this.state.sessions[sessionId],
      saveRecord: (sessionId, record: LocalAgentSessionRecord) => {
        this.state = {
          ...this.state,
          sessions: { ...this.state.sessions, [sessionId]: record },
        }
        void this.persist()
      },
      // A6 resolves the Bot/session workspace; A2/A3 run from the host's working directory.
      cwdFor: () => process.cwd(),
      toolsBridge: this.cfg.toolsBridge,
    }
  }

  async dispose(): Promise<void> {
    this.toolsDisposer?.()
    this.toolsDisposer = undefined
    this.registration?.()
    this.registration = undefined
    await this.adapter?.dispose()
    this.adapter = undefined
    for (const driver of this.drivers.values()) await driver.dispose()
    this.drivers = new Map()
  }
}

for (const method of REMOTE_METHODS) {
  markRemote(LocalAgentService.prototype, method)
}

/** The loader instantiates the default export itself (same shape as in-box services). */
export default LocalAgentService

/**
 * Register one Remote method marker without decorator syntax.
 *
 * tsdown/rolldown passes TC39 decorators through unchanged and Node cannot parse decorator
 * syntax at runtime, so `@Remote` is unusable here. This is the same workaround the
 * agent-community service documents; the fabricated context only has to satisfy the
 * decorator contract.
 */
function markRemote(prototype: object, method: string): void {
  const fn = (prototype as Record<string, unknown>)[method]
  if (typeof fn !== 'function') throw new TypeError(`local-agent: no method ${method}`)
  const context = {
    kind: 'method' as const,
    name: method,
    static: false,
    private: false,
    addInitializer(init: (this: unknown) => void): void {
      init.call(Object.create(prototype))
    },
  }
  ;(Remote as unknown as (m: unknown, c: unknown) => void)(fn, context)
}
