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
import { ENGINES, customRoute, engineOf, validateCustomAgent } from './engines.ts'
import { findExecutable, probeVersion, refreshSearchDirs } from './discover.ts'
import { emptyState, loadState, newCustomAgentId, saveState, type PersistedLocalAgentState } from './state.ts'
import type {
  AddCustomAgentInput,
  Config as LocalAgentConfig,
  CustomAgent,
  LocalAgentKind,
  LocalAgentRouteView,
  LocalAgentSnapshot,
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
  }
  private readonly home: string
  private readonly statePath: string
  private state: PersistedLocalAgentState = emptyState()
  private detected: LocalAgentRouteView[] = []
  private scannedAt = ''
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: LocalAgentConfig = {}) {
    super(ctx, 'localAgent')
    this.cfg = {
      enabled: config.enabled ?? true,
      extraSearchDirs: config.extraSearchDirs ?? [],
      versionProbeTimeoutMs: config.versionProbeTimeoutMs ?? 10_000,
    }
    this.home = resolveLocalAgentHome(config.homeDir)
    this.statePath = join(this.home, 'local-agent', 'state.json')
    void this.initialize()
  }

  private async initialize(): Promise<void> {
    this.state = await loadState(this.statePath, message => this.ctx.logger?.warn?.(message))
    if (!this.cfg.enabled) {
      this.ctx.logger?.info?.('[local-agent] disabled by config; no scan performed')
      return
    }
    await this.scan()
    await this.probeVersions()
  }

  /** Whether this host can register model routes (A2); independent of discovery. */
  private supported(): boolean {
    const llm = (this.ctx as unknown as { llm?: { registerAdapter?: unknown } }).llm
    return typeof llm?.registerAdapter === 'function'
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
    }
  }

  /** Re-scan on demand (settings refresh), including version probes. */
  async refresh(): Promise<LocalAgentSnapshot> {
    if (!this.cfg.enabled) return this.snapshot()
    await this.scan()
    await this.probeVersions()
    return this.snapshot()
  }

  async addCustomAgent(input: AddCustomAgentInput): Promise<LocalAgentSnapshot> {
    const clean = validateCustomAgent(input)
    const agent: CustomAgent = { id: newCustomAgentId(), ...clean }
    this.state = { ...this.state, custom: [...this.state.custom, agent] }
    await this.persist()
    await this.scan()
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
    return this.snapshot()
  }

  async removeCustomAgent(input: RemoveCustomAgentInput): Promise<LocalAgentSnapshot> {
    if (!this.state.custom.some(agent => agent.id === input.id)) {
      throw new Error(`Unknown local agent: ${input.id}`)
    }
    this.state = { ...this.state, custom: this.state.custom.filter(agent => agent.id !== input.id) }
    await this.persist()
    await this.scan()
    return this.snapshot()
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
