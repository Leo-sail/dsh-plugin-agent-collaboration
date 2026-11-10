/**
 * Finding agent CLIs and the environment they run in.
 *
 * Two problems this solves, both measured on the real host:
 * 1. A desktop app launched from the dock inherits a sparse PATH, so an npm-installed CLI is
 *    invisible. The user's login shell knows where it actually is, so its PATH is read once
 *    (cached, never blocking the host).
 * 2. Some agents ship INSIDE a desktop app (Codex in ChatGPT.app) and are not on PATH at all;
 *    the engine table carries candidate absolute paths for those.
 *
 * The child environment is sanitized: the CLI signs in by itself, and a provider API key (or
 * another agent's backend variable) in our environment would shadow that or leak to it.
 *
 * @module
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Variables that never reach a child agent (its own sign-in must win). */
const DROP_EXACT = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'ELECTRON_RUN_AS_NODE',
])

/** Prefixes dropped wholesale: our own harness/plugin knobs are not the agent's business. */
const DROP_PREFIX = ['DSH_', 'DS_BOT_', 'DS_PLUGIN_AGENT_']

/**
 * A sanitized copy of the current environment plus `extra`.
 *
 * @param extra - variables an engine row explicitly needs (A2/A6).
 */
export function cleanEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (DROP_EXACT.has(key)) continue
    if (DROP_PREFIX.some(prefix => key.startsWith(prefix))) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

/** How long the login-shell lookup is reused. */
const SEARCH_CACHE_MS = 60_000
interface SearchCache {
  readonly at: number
  readonly dirs: readonly string[]
  readonly extra: readonly string[]
}
let searchCache: SearchCache = { at: 0, dirs: [], extra: [] }
let looking: Promise<void> | undefined

function outputOf(file: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      execFile(file, [...args], { encoding: 'utf8', timeout: 5_000, env: cleanEnv() }, (error, stdout) => {
        resolve(error === null ? stdout : undefined)
      })
    } catch {
      resolve(undefined)
    }
  })
}

/**
 * Refresh the login-shell PATH + npm global bin directories, at most once a minute.
 *
 * Async and cached on purpose: this runs inside the DSH host, and a blocking child process
 * there freezes every Session while it waits.
 *
 * @param extra - directories the deployment configured (e.g. a custom install root).
 */
export function refreshSearchDirs(extra: readonly string[] = []): Promise<void> {
  const sameExtra = extra.length === searchCache.extra.length && extra.every((dir, at) => dir === searchCache.extra[at])
  if (Date.now() - searchCache.at < SEARCH_CACHE_MS && sameExtra) return Promise.resolve()
  looking ??= Promise.all([
    process.platform === 'win32'
      ? Promise.resolve(undefined)
      : outputOf(process.env.SHELL ?? '/bin/sh', ['-l', '-c', 'printf %s "$PATH"']),
    process.platform === 'win32'
      ? Promise.resolve(undefined)
      : outputOf('npm', ['prefix', '-g']),
  ]).then(([loginPath, prefix]) => {
    const dirs: string[] = []
    for (const dir of (loginPath ?? '').split(delimiter)) {
      if (dir !== '') dirs.push(dir)
    }
    const npmBin = process.platform === 'win32'
      ? (process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm'))
      : (prefix === undefined || prefix.trim() === '' ? undefined : join(prefix.trim(), 'bin'))
    if (npmBin !== undefined) dirs.push(npmBin)
    dirs.push(...extra)
    searchCache = { at: Date.now(), dirs, extra: [...extra] }
  }).finally(() => { looking = undefined })
  return looking
}

/** The usual macOS install locations, after PATH and the login shell. */
function standardDirs(): readonly string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
}

function searchDirs(): readonly string[] {
  const dirs = new Set<string>()
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir !== '') dirs.add(dir)
  }
  for (const dir of searchCache.dirs) {
    if (dir !== '') dirs.add(dir)
  }
  for (const dir of standardDirs()) {
    if (existsSync(dir)) dirs.add(dir)
  }
  return [...dirs]
}

function isPathLike(name: string): boolean {
  return name.includes('/') || name.includes('\\') || name.startsWith('~/')
}

function expandTilde(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function candidates(name: string): readonly string[] {
  return process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name]
}

/**
 * Resolve a program to an absolute path, or undefined.
 *
 * @param name - bare program name, absolute path, or `~/path`.
 * @param appPaths - absolute paths to check after PATH (e.g. a CLI bundled in a desktop app).
 */
export function findExecutable(name: string, appPaths: readonly string[] = []): string | undefined {
  const trimmed = name.trim()
  if (trimmed === '') return undefined
  if (isPathLike(trimmed)) {
    const path = expandTilde(trimmed)
    return existsSync(path) ? path : undefined
  }
  for (const dir of searchDirs()) {
    for (const file of candidates(trimmed)) {
      const path = join(dir, file)
      if (existsSync(path)) return path
    }
  }
  for (const path of appPaths) {
    if (existsSync(path)) return path
  }
  return undefined
}

/**
 * First line of `--version`, for display only. Never throws.
 *
 * @param executable - absolute path.
 * @param args - version arguments.
 * @param timeoutMs - bound; the settings page waits at most this long per agent.
 */
export function probeVersion(executable: string, args: readonly string[], timeoutMs = 10_000): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      execFile(executable, [...args], { encoding: 'utf8', timeout: timeoutMs, env: cleanEnv() }, (error, stdout, stderr) => {
        const text = `${stdout ?? ''}${stderr ?? ''}`
          .split('\n')
          .map(line => line.trim())
          .find(line => line !== '')
        resolve(text === '' || text === undefined ? undefined : text)
      })
    } catch {
      resolve(undefined)
    }
  })
}
