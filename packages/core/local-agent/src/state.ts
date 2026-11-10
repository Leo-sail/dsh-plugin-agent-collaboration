/**
 * Persisted local-agent state — currently only the user's custom ACP agents.
 *
 * Session records (DSH Session ↔ CLI session) land with A2 and are additive fields on the
 * same file, so an older build ignores them.
 *
 * @module
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CustomAgent, LocalAgentSessionRecord } from './types.ts'

export const STATE_VERSION = 1 as const

export interface PersistedLocalAgentState {
  readonly version: typeof STATE_VERSION
  readonly custom: readonly CustomAgent[]
  /**
   * DSH Session → CLI conversation map. Additive on the same file: an older build ignores it
   * and the next turn simply replays (worse, never wrong).
   */
  readonly sessions: Readonly<Record<string, LocalAgentSessionRecord>>
}

export function emptyState(): PersistedLocalAgentState {
  return { version: STATE_VERSION, custom: [], sessions: {} }
}

function isSessionRecord(value: unknown): value is LocalAgentSessionRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record['route'] === 'string' && typeof record['updatedAt'] === 'string'
}

function isCustomAgent(value: unknown): value is CustomAgent {
  if (value === null || typeof value !== 'object') return false
  const agent = value as { id?: unknown; name?: unknown; command?: unknown; args?: unknown }
  return typeof agent.id === 'string'
    && typeof agent.name === 'string'
    && typeof agent.command === 'string'
    && Array.isArray(agent.args)
    && agent.args.every(arg => typeof arg === 'string')
}

/** Parse a state file tolerantly; undefined means "unreadable, start empty". */
export function parseState(raw: string): PersistedLocalAgentState | undefined {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; custom?: unknown; sessions?: unknown }
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.custom)) return undefined
    const sessions: Record<string, LocalAgentSessionRecord> = {}
    if (parsed.sessions !== null && typeof parsed.sessions === 'object') {
      for (const [sessionId, value] of Object.entries(parsed.sessions as Record<string, unknown>)) {
        if (isSessionRecord(value)) sessions[sessionId] = value
      }
    }
    return {
      version: STATE_VERSION,
      custom: parsed.custom.filter(isCustomAgent).map(agent => ({
        id: agent.id,
        name: agent.name,
        command: agent.command,
        args: [...agent.args],
      })),
      sessions,
    }
  } catch {
    return undefined
  }
}

/** Read state; a missing file is a normal first run. */
export async function loadState(path: string, warn: (message: string) => void): Promise<PersistedLocalAgentState> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = parseState(raw)
    if (parsed !== undefined) return parsed
    warn(`[local-agent] ignoring unreadable state at ${path}; starting empty`)
    return emptyState()
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      warn(`[local-agent] cannot read state at ${path}: ${String(error)}`)
    }
    return emptyState()
  }
}

/** Atomic write: temp file in the same directory, then rename. */
export async function saveState(path: string, state: PersistedLocalAgentState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${randomUUID()}`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
}

/** Stable-enough id for a user-added agent. */
export function newCustomAgentId(): string {
  return `agent-${randomUUID().replaceAll('-', '').slice(0, 10)}`
}
