/**
 * Per-bot agent presets (S2-1) — the role a bot runs under.
 *
 * WHY THIS EXISTS. Every room bot used to run under one deployment-wide preset (`botAgentPreset`),
 * so the leader of a group had exactly the same tool surface as its workers. The Article's Router /
 * Worker split gives the coordinator a deliberately small world — it routes, briefs, collects and
 * reports; it does not execute — and the prototype expresses that as two presets, not as a prompt
 * rule. A prompt rule cannot hide `bash`/`write`; a preset can.
 *
 * WHAT IS STORED. A BotIdentity may carry `agentPreset: 'bot' | 'coordinator'` (additive, optional).
 * Absent means "the deployment default" (`botAgentPreset`), which is exactly the old behaviour, so
 * existing bots and older state files need no migration.
 *
 * WHAT THIS MODULE IS. The deterministic half only: validate the stored role, and resolve the
 * preset id the session runner should mount. It never reads host services, never inspects the
 * roster (the runner already degrades gracefully when a preset is missing), and never decides
 * whether a change requires a new session — the service/runner own that operational detail.
 *
 * @module
 */

/** The two roles a room bot can be created with. */
export type AgentPresetRole = 'bot' | 'coordinator'

/** The preset ids the deployment mounts for each role. */
export interface PresetNames {
  readonly botPreset: string
  readonly coordinatorPreset: string
}

/**
 * Validate a stored role.
 *
 * `''` (and absent) means "no explicit role" → the deployment default; anything that is not one
 * of the two roles is a mistake and must be rejected at the RPC boundary rather than silently
 * becoming a member or a coordinator.
 */
export function normalizeAgentPreset(value: unknown): AgentPresetRole | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Bot 角色无效：必须是 bot 或 coordinator')
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed === 'bot' || trimmed === 'coordinator') return trimmed
  throw new Error(`Bot 角色无效：「${trimmed}」不是 bot 或 coordinator`)
}

/** True when this bot is configured as the coordinator role (not merely the room leader). */
export function isCoordinatorRole(role: string | undefined): boolean {
  return role === 'coordinator'
}

/**
 * The preset id a bot session should mount for this bot's role.
 *
 * Explicit coordinator wins; an explicit member role and a missing role both resolve to the
 * deployment's member preset — a bot created before this feature keeps the old behaviour.
 */
export function resolveAgentPreset(input: {
  readonly role?: string | undefined
  readonly names: PresetNames
}): string {
  const role = input.role?.trim() ?? ''
  if (role === 'coordinator') return input.names.coordinatorPreset
  if (role === 'bot' || role === '') return input.names.botPreset
  // Unknown but somehow persisted (an older/custom state or a future role): keep it as a preset
  // id rather than silently swapping the bot's world; the runner falls back when the roster lacks it.
  return role
}

/**
 * Whether changing the stored role needs a NEW session to take effect.
 *
 * A session records its preset in its header at creation; mounting a different preset into an
 * existing agent cannot remove the tools the old preset registered. S2-1 v1 therefore treats a
 * role change as effective on the next session recreation (clear the room / restart), and this
 * helper lets the service surface that instead of pretending it applied immediately.
 */
export function presetChangeNeedsNewSession(previous: string | undefined, next: string | undefined): boolean {
  return (previous?.trim() ?? '') !== (next?.trim() ?? '')
}

/** Human label for logs and the panel (`bot` → 成员, `coordinator` → 协调者). */
export function agentPresetLabel(role: string | undefined): string {
  if (role === 'coordinator') return '协调者'
  return '成员'
}
