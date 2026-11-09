/**
 * Home resolution — which directory holds this plugin's own data.
 *
 * WHY THIS MODULE EXISTS (and why it changed after the 2026-11-08 acceptance run)
 *
 * The plugin used to resolve its home as `config.homeDir ?? join(homedir(), '.dsh')`, ignoring the
 * harness home entirely. DSH keeps ALL user data under `resolveDshHome()` (`$DSH_HOME`, else
 * `~/.dsh`), so a second runtime started with `DSH_HOME=/tmp/x` — the documented way to isolate an
 * instance — still read and wrote the FIRST runtime's board. Two consequences, both observed:
 *
 *   1. A test instance silently polluted the user's real board.
 *   2. Two runtimes sharing one board also share one session store, and each bot's session carries
 *      a kernel write lease (`flock`) held for the agent's whole life — so the second runtime
 *      failed every turn with `SessionAlreadyOwnedError`.
 *
 * Precedence: `config.homeDir` → `$DSH_HOME` → `~/.dsh`.
 *
 * BACK-COMPATIBILITY, AND THE TRAP IT SPRUNG. An installation whose board still lives in `~/.dsh`
 * keeps using it when the harness home has no board yet but the legacy path does (an existing
 * profile booted with a fresh `$DSH_HOME`, for example). That fallback is *right* for upgrades and
 * *wrong* for isolation — and it is silent enough that the 2026-11-08 acceptance run fell into it:
 * a temp `DSH_HOME` with a profile but no board adopted the operator's REAL board, then rewrote
 * `state.json`, compacted the ledger journals and appended a boot line, all while the acceptance
 * script believed it was isolated. Nothing was lost (no new runs/messages/sessions were created),
 * but the isolation guarantee was false.
 *
 * So there are now TWO explicit opt-outs from that fallback:
 *   · `homeDir` — the strongest one; wins before anything else;
 *   · `adoptLegacyBoard: false` — keep `$DSH_HOME` even when the legacy board exists, so a harness
 *     home that is empty by construction really is empty. A warning says which board was picked.
 *
 * @module
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** What the resolver picked, and whether it came from the pre-`$DSH_HOME` location. */
export interface HomeResolution {
  /** Absolute directory that holds `agent-community/state.json`. */
  readonly home: string
  /** True when `~/.dsh` was adopted because the harness home had no board yet. */
  readonly adoptedLegacyBoard: boolean
  /** True when the caller asked for isolation and the fallback was deliberately NOT taken. */
  readonly isolated: boolean
}

/**
 * Resolve which directory holds this plugin's own data (`agent-community/state.json`,
 * `agent-community/workspaces`, `sessions`).
 *
 * @param input.configured - `config.homeDir`, if the deployment set one.
 * @param input.adoptLegacyBoard - when false, never fall back to the legacy `~/.dsh` board
 *   (default true, preserving upgrade behaviour). Set false for throwaway/acceptance instances.
 * @param input.env - environment to read `$DSH_HOME` from (defaults to `process.env`).
 * @param input.legacyStatePath - the pre-existing `<~/.dsh>/agent-community/state.json`.
 * @param input.exists - state-file probe, injected so this stays pure and testable.
 * @param input.warn - optional diagnostic sink.
 */
export function resolveAgentCommunityHome(input: {
  configured?: string | undefined
  adoptLegacyBoard?: boolean | undefined
  env?: Record<string, string | undefined>
  legacyStatePath: string
  exists: (path: string) => boolean
  warn?: ((message: string) => void) | undefined
}): HomeResolution {
  const expand = (path: string): string => resolve(path.replace(/^~(?=[/\\]|$)/u, homedir()))
  if (input.configured !== undefined && input.configured.trim() !== '') {
    return { home: expand(input.configured), adoptedLegacyBoard: false, isolated: true }
  }
  const env = input.env ?? process.env
  const fromEnv = env.DSH_HOME
  const defaultHome = join(homedir(), '.dsh')
  const harnessHome = fromEnv !== undefined && fromEnv.trim() !== '' ? expand(fromEnv) : defaultHome
  const hasBoard = (home: string): boolean => input.exists(join(home, 'agent-community', 'state.json'))
  if (hasBoard(harnessHome)) return { home: harnessHome, adoptedLegacyBoard: false, isolated: false }
  const legacyBoardExists = harnessHome !== defaultHome && hasBoard(defaultHome)
  if (legacyBoardExists && input.adoptLegacyBoard === false) {
    input.warn?.(
      `agent-community: the harness home (${harnessHome}) has no board yet; adopting the legacy `
      + `board was disabled (adoptLegacyBoard=false), so a fresh board will be created here. `
      + `The real board at ${input.legacyStatePath} is left untouched.`,
    )
    return { home: harnessHome, adoptedLegacyBoard: false, isolated: true }
  }
  if (legacyBoardExists) {
    input.warn?.(
      `agent-community: the harness home (${harnessHome}) has no board yet, but `
      + `${input.legacyStatePath} does — using the existing board. Point homeDir at a fresh `
      + `directory, or set adoptLegacyBoard=false, to get an isolated board.`,
    )
    return { home: defaultHome, adoptedLegacyBoard: true, isolated: false }
  }
  return { home: harnessHome, adoptedLegacyBoard: false, isolated: false }
}
