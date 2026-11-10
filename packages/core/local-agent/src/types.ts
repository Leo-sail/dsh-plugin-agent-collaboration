/**
 * Public types for the local-agent feature.
 *
 * A1 (foundation) needs only discovery + custom-agent storage; the adapter-facing types
 * (session records, chunk mapping) land with A2.
 *
 * @module
 */

/** Protocol family a route speaks. The driver for each lands in A2/A6. */
export type LocalAgentKind = 'acp' | 'claude' | 'codex'

/** One built-in route: how its CLI is named, found and version-probed. */
export interface LocalAgentEngineSpec {
  readonly route: string
  readonly name: string
  readonly kind: LocalAgentKind
  /** Program name searched on PATH, or an absolute path. */
  readonly command: string
  /** Arguments used when the driver starts the agent (unused in A1). */
  readonly args: readonly string[]
  /**
   * Absolute paths to check after PATH — e.g. a CLI bundled inside a desktop app.
   * Only existing files are returned.
   */
  readonly appPaths?: readonly string[]
  /** Arguments for the version probe (default `--version`). */
  readonly versionArgs?: readonly string[]
  /** Extra environment variables for the child process (unused in A1). */
  readonly env?: Readonly<Record<string, string>>
  /** Text shown in the settings list so the user can sign in themselves. */
  readonly signInHint?: string
  /** Context window the agent reports; absent means "unknown". */
  readonly contextWindow?: number
}

/** A user-added ACP agent (custom route `acp-<id>`). */
export interface CustomAgent {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
}

/** One row the settings page renders for a detected route. */
export interface LocalAgentRouteView {
  readonly route: string
  readonly name: string
  readonly kind: LocalAgentKind
  readonly custom: boolean
  readonly available: boolean
  /** Absolute executable path when found. */
  readonly path?: string
  /** First line of `--version`, when the probe succeeded. */
  readonly version?: string
  readonly signInHint?: string
}

/** One DSH Session's mapping to a CLI-side conversation. */
export interface LocalAgentSessionRecord {
  readonly route: string
  /** CLI session/thread id to resume; absent until the first turn established one. */
  readonly resumeId?: string | undefined
  readonly cwd?: string | undefined
  /** Last DSH message id handed to the CLI (the delta cursor). */
  readonly handedId?: string | undefined
  /** Model asked for; `default` means the CLI's configured model. */
  readonly model?: string | undefined
  /** Session-level model switch from the natural-language tool (overrides `model`). */
  readonly modelOverride?: string | undefined
  /** The Bot's DSH permission presets, mapped onto the CLI's own sandbox/permission flags. */
  readonly permission?: 'read-only' | 'workspace-write' | 'full-access' | undefined
  readonly updatedAt: string
}

/** What the settings page reads. Detached JSON. */
export interface LocalAgentSnapshot {
  readonly enabled: boolean
  /** Whether this host exposes `ctx.llm.registerAdapter` (route registration, A2). */
  readonly supported: boolean
  /** Resolved DSH home the state file lives under. */
  readonly home: string
  /** ISO timestamp of the last scan; empty before the first scan. */
  readonly scannedAt: string
  readonly detected: readonly LocalAgentRouteView[]
  readonly custom: readonly CustomAgent[]
  /** Routes this host actually registered as model providers (driver-backed). */
  readonly registeredRoutes: readonly string[]
}

export interface AddCustomAgentInput {
  readonly name: string
  readonly command: string
  readonly args?: readonly string[] | string
}

export interface UpdateCustomAgentInput extends AddCustomAgentInput {
  readonly id: string
}

export interface RemoveCustomAgentInput {
  readonly id: string
}

/** Plugin config (schemastery schema in index.ts). */
export interface Config {
  /** When false the service loads but performs no scan (default true). */
  readonly enabled?: boolean
  /** Explicit home; defaults to `$DSH_HOME`, else `~/.dsh`. */
  readonly homeDir?: string
  /** Extra directories searched after PATH (e.g. a CLI installed somewhere unusual). */
  readonly extraSearchDirs?: readonly string[]
  /** Timeout for one `--version` probe (default 10s). */
  readonly versionProbeTimeoutMs?: number
  /** Expose the collaboration tools to local agents over loopback MCP (default true). */
  readonly toolsBridge?: boolean
}
