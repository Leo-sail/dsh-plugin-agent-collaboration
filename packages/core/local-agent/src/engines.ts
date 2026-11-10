/**
 * Built-in launch profiles and custom-agent validation.
 *
 * A1 only DISCOVERS these; starting them is A2/A6's job. The table is deliberately data —
 * one row per route, no per-agent code — so adding an agent is a table edit.
 *
 * @module
 */
import type { CustomAgent, LocalAgentEngineSpec } from './types.ts'

/** Custom agents always get an `acp-<id>` route. */
export const CUSTOM_ROUTE_PREFIX = 'acp-'

/**
 * Known agent CLIs.
 *
 * `args` are the args the DRIVER passes when starting the agent (A2/A6); the discovery layer
 * only needs `command`, `appPaths` and `versionArgs`.
 */
export const ENGINES: Readonly<Record<string, LocalAgentEngineSpec>> = {
  'claude-code': {
    route: 'claude-code',
    name: 'Claude Code',
    kind: 'claude',
    command: 'claude',
    args: [],
    versionArgs: ['--version'],
    signInHint: 'claude',
    contextWindow: 200_000,
  },
  'codex-cli': {
    route: 'codex-cli',
    name: 'Codex CLI',
    kind: 'codex',
    command: 'codex',
    args: ['app-server', '--listen', 'stdio://'],
    // The ChatGPT desktop app ships the CLI here; it is not on PATH.
    appPaths: ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'],
    versionArgs: ['--version'],
    signInHint: 'codex login',
    contextWindow: 200_000,
  },
  'grok-build': {
    route: 'grok-build',
    name: 'Grok Build',
    kind: 'acp',
    command: 'grok',
    args: ['agent', 'stdio'],
    versionArgs: ['--version'],
    signInHint: 'grok',
    contextWindow: 200_000,
  },
  'gemini-cli': {
    route: 'gemini-cli',
    name: 'Gemini CLI',
    kind: 'acp',
    command: 'gemini',
    args: ['--acp'],
    versionArgs: ['--version'],
    signInHint: 'gemini',
    contextWindow: 1_000_000,
  },
  opencode: {
    route: 'opencode',
    name: 'OpenCode',
    kind: 'acp',
    command: 'opencode',
    args: ['acp'],
    versionArgs: ['--version'],
    signInHint: 'opencode auth login',
    contextWindow: 200_000,
  },
  cline: {
    route: 'cline',
    name: 'Cline',
    kind: 'acp',
    command: 'cline',
    args: ['--acp'],
    env: { CLINE_SESSION_BACKEND_MODE: 'local' },
    versionArgs: ['--version'],
    signInHint: 'cline auth',
    contextWindow: 200_000,
  },
  'cursor-cli': {
    route: 'cursor-cli',
    name: 'Cursor CLI',
    kind: 'acp',
    command: 'cursor-agent',
    args: ['acp'],
    versionArgs: ['--version'],
    signInHint: 'cursor-agent login',
    contextWindow: 200_000,
  },
  goose: {
    route: 'goose',
    name: 'Goose',
    kind: 'acp',
    command: 'goose',
    args: ['acp'],
    versionArgs: ['--version'],
    signInHint: 'goose configure',
    contextWindow: 200_000,
  },
  'qwen-code': {
    route: 'qwen-code',
    name: 'Qwen Code',
    kind: 'acp',
    command: 'qwen',
    args: ['--acp'],
    versionArgs: ['--version'],
    signInHint: 'qwen',
    contextWindow: 200_000,
  },
}

/** Every built-in route id, in table order. */
export const ENGINE_ROUTES: readonly string[] = Object.keys(ENGINES)

/** Route id for a custom agent. */
export function customRoute(id: string): string {
  return `${CUSTOM_ROUTE_PREFIX}${id}`
}

/**
 * Resolve one route to its engine spec, built-in or custom.
 *
 * @param route - a built-in route id or `acp-<custom id>`.
 * @param custom - the stored custom agents.
 * @returns the spec, or undefined when the route is not one this plugin owns.
 */
export function engineOf(route: string, custom: readonly CustomAgent[]): LocalAgentEngineSpec | undefined {
  const builtIn = ENGINES[route]
  if (builtIn !== undefined) return builtIn
  if (!route.startsWith(CUSTOM_ROUTE_PREFIX)) return undefined
  const id = route.slice(CUSTOM_ROUTE_PREFIX.length)
  const agent = custom.find(entry => entry.id === id)
  if (agent === undefined) return undefined
  return {
    route,
    name: agent.name,
    kind: 'acp',
    command: agent.command,
    args: agent.args,
    versionArgs: ['--version'],
  }
}

/** Whether the route belongs to this feature. */
export function isLocalAgentRoute(route: string, custom: readonly CustomAgent[]): boolean {
  return engineOf(route, custom) !== undefined
}

/** What `validateCustomAgent` returns: trimmed, safe for `spawn` without a shell. */
export interface NormalizedCustomAgent {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
}

/**
 * Validate a user-supplied ACP agent.
 *
 * This is injection-hardening, NOT a sandbox: the command runs as the user. Rules:
 * - name is trimmed and capped at 40 characters;
 * - command has no whitespace and is a bare name, an absolute path, or `~/…`;
 * - args never carry NUL or line breaks (they could smuggle a second command line).
 *
 * @throws Error with a user-facing reason.
 */
export function validateCustomAgent(input: {
  readonly name?: unknown
  readonly command?: unknown
  readonly args?: unknown
}): NormalizedCustomAgent {
  const name = String(input.name ?? '').trim().slice(0, 40)
  if (name === '') throw new Error('Name is required')
  const command = String(input.command ?? '').trim()
  if (command === '' || /\s/.test(command)) {
    throw new Error('Command must be a program name, an absolute path, or a ~/path')
  }
  const allowed = command.startsWith('/')
    || command.startsWith('~/')
    || /^[A-Za-z]:[\\/]/.test(command)
    || /^[\w.-]+$/.test(command)
  if (!allowed) throw new Error('Command must be a program name, an absolute path, or a ~/path')
  const rawArgs = Array.isArray(input.args)
    ? input.args
    : String(input.args ?? '').split(/\s+/)
  const args = rawArgs.map(arg => String(arg).trim()).filter(arg => arg !== '')
  if (args.some(arg => arg.includes('\0') || /[\r\n]/.test(arg))) {
    throw new Error('Arguments must not contain newlines')
  }
  return { name, command, args }
}
