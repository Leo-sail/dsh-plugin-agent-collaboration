/**
 * Identity bundle — export/import ONE bot's identity + memory across runtimes, safely.
 *
 * WHY THIS MODULE EXISTS (OP-20). Moving a bot to another DSH instance/host currently means
 * re-typing its prompt and losing what it remembered. A bundle fixes that, but a bundle is also
 * the easiest place to leak things by accident: a system prompt may embed an API key, a memory
 * line may quote a private absolute path, a run prompt may contain the user's raw text, and the
 * ids (bot/room/session) belong to THIS runtime and must be re-created by the host that imports.
 *
 * So the module is a WHITELIST, not a serialiser:
 *   · export copies only named fields, from `unknown` input (it never trusts a caller's type);
 *   · text is sanitised (secrets redacted, absolute paths redacted) and clipped;
 *   · a task memory line exports only its OUTCOME half (`… → 结果：…`), never the run prompt;
 *   · bot/room/session ids, provider/credential bindings, workspace paths and avatars are simply
 *     not in the output shape;
 *   · import validates, strips nothing more, and returns a DRAFT — it never calls an RPC, never
 *     writes a file, and never invents ids (the host assigns them).
 *
 * CODE MIGRATION IS OUT OF SCOPE: a bundle carries identity text + skill/profile METADATA only
 * (skill names, a profile signature, pattern-card prose). Skill bodies, tool configs, files and
 * workspaces stay on the source runtime; the target resolves names against its own skills. The
 * same rule keeps `bot.id`/room/session ids out — the importing host creates fresh ones.
 *
 * Version 1 is intentionally narrow. All functions are pure (`exportIdentityBundle` takes an
 * injected `now` for deterministic tests; it only reads the clock when none is given).
 *
 * @module
 */

/** The only bundle format this module reads or writes. */
export const IDENTITY_BUNDLE_VERSION = 1

/** Aggregated memory cap: a bundle is a portable profile, not a transcript archive. */
export const MAX_BUNDLE_MEMORY_ENTRIES = 50
/** Per-entry text cap after sanitising. */
export const MAX_BUNDLE_TEXT_CHARS = 200
/** Cap for one short item (name/signature/evidence line). */
export const MAX_BUNDLE_ITEM_CHARS = 120
/** Prefix written in front of anything that had to be redacted. */
export const REDACTED_PATH = '[路径已移除]'
/** Prefix written in front of a detected secret. */
export const REDACTED_SECRET = '[凭据已移除]'

/** One memory line as it travels in a bundle. No room/bot/session ids. */
export interface IdentityBundleMemoryEntry {
  readonly id: string
  readonly kind: 'task' | 'note'
  readonly text: string
  readonly at: string
  readonly source?: 'run' | 'note' | 'a2a' | 'routine' | 'unknown' | undefined
  readonly status?: 'active' | 'probation' | 'decayed' | undefined
  readonly outcome?: 'positive' | 'negative' | 'unknown' | undefined
  readonly confidence?: number | undefined
}

/** One portable skill profile (names only — not the skill bodies, which the target resolves). */
export interface IdentityBundleSkillProfile {
  readonly names: readonly string[]
  readonly signature: string
  readonly analyzedAt: string
}

/** One portable collaboration pattern card (paths in `evidence` are redacted). */
export interface IdentityBundlePatternCard {
  readonly id: string
  readonly task: string
  readonly approach: string
  readonly pitfalls?: readonly string[] | undefined
  readonly evidence?: readonly string[] | undefined
  readonly createdAt: string
  readonly source: 'finish'
}

/** The portable part of one bot's identity. Ids and bindings are deliberately absent. */
export interface IdentityBundleBot {
  readonly name: string
  readonly description: string
  readonly systemPrompt?: string | undefined
  /** Skill/capability names this bot relies on; the target runtime maps them to its own skills. */
  readonly subscriptions?: readonly string[] | undefined
}

/** The exported memory block. `dropped` counts entries the whitelist refused to carry. */
export interface IdentityBundleMemory {
  readonly roomEntries: readonly IdentityBundleMemoryEntry[]
  readonly dropped: number
}

/** A complete v1 bundle. */
export interface IdentityBundle {
  readonly version: typeof IDENTITY_BUNDLE_VERSION
  readonly exportedAt: string
  readonly bot: IdentityBundleBot
  readonly memory: IdentityBundleMemory
  readonly skillProfiles?: readonly IdentityBundleSkillProfile[] | undefined
  readonly patternCards?: readonly IdentityBundlePatternCard[] | undefined
}

/** What {@link exportIdentityBundle} accepts. Everything is `unknown` on purpose: whitelist first. */
export interface ExportIdentityInput {
  readonly bot: unknown
  /** An array of memory entries, or an object carrying `roomEntries` (caller-aggregated). */
  readonly memory?: unknown
  readonly skillProfiles?: unknown
  readonly patternCards?: unknown
}

/** Options for `importIdentityBundle`. */
export interface ImportIdentityOptions {
  /** Rename the imported bot (the target may already have a bot with the old name). */
  readonly renameTo?: string | undefined
}

/** A bot draft for the HOST to create; contains no ids by construction. */
export interface IdentityBundleDraft {
  readonly name: string
  readonly description: string
  readonly systemPrompt?: string | undefined
  readonly subscriptions?: readonly string[] | undefined
  readonly skillProfiles?: readonly IdentityBundleSkillProfile[] | undefined
  readonly patternCards?: readonly IdentityBundlePatternCard[] | undefined
}

/** Result of validation / import. `issues` are stable machine-ish strings. */
export interface BundleValidation {
  readonly ok: boolean
  readonly issues: readonly string[]
}

/** Result of an import attempt. */
export interface BundleImportResult extends BundleValidation {
  readonly draft?: IdentityBundleDraft | undefined
}

// The path itself is matched WITHOUT a boundary: a path may be glued directly to Chinese text
// ("见/Users/x 文件"), where a word boundary does not exist (JS \w is ASCII-only) and where a
// unicode-letter lookbehind would wrongly refuse to redact. Over-redacting a relative path that
// happens to contain "/Users/" is the harmless direction for a security filter.
const ABSOLUTE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/(?:Users|home|tmp|var|private|opt|etc|srv|mnt|Volumes)\/[^\s)"'`，。；、）]+/gu,
  /~\/[^\s)"'`，。；、）]+/gu,
  /[A-Za-z]:\\[^\s)"'`，。；、）]+/gu,
]

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/giu,
  /\b(api[_-]?key|access[_-]?token|token|secret|password|authorization)\s*[:=]\s*[^\s,;，；]{4,}/giu,
]

/** True when the text contains something that looks like an absolute host path. */
export function containsAbsolutePath(text: string): boolean {
  return ABSOLUTE_PATH_PATTERNS.some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

/** True when the text contains something that looks like a credential. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, REDACTED_SECRET)
  }
  return out
}

function redactPaths(text: string): string {
  let out = text
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, REDACTED_PATH)
  }
  return out
}

/**
 * Sanitise one free-text value for a bundle: redact secrets and absolute paths, collapse
 * whitespace and clip. Exported so the rules are directly assertable.
 */
export function sanitizeBundleText(value: unknown, maxChars = MAX_BUNDLE_TEXT_CHARS): string {
  if (typeof value !== 'string') return ''
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  const safe = redactPaths(redactSecrets(collapsed))
  if (safe.length <= maxChars) return safe
  return `${safe.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

/** A memory task line keeps only its outcome half — never the run prompt it was asked with. */
function sanitizeMemoryText(kind: 'task' | 'note', text: string): string | undefined {
  const raw = text.replace(/\s+/gu, ' ').trim()
  if (kind === 'task') {
    const marker = raw.indexOf('→ 结果：')
    if (marker < 0) return undefined // no separable outcome → would export the run prompt
    return sanitizeBundleText(raw.slice(marker + '→ 结果：'.length)) || undefined
  }
  return sanitizeBundleText(raw) || undefined
}

const MEMORY_SOURCES = new Set(['run', 'note', 'a2a', 'routine', 'unknown'])
const MEMORY_STATUSES = new Set(['active', 'probation', 'decayed'])
const MEMORY_OUTCOMES = new Set(['positive', 'negative', 'unknown'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown, maxItems: number, maxChars = MAX_BUNDLE_ITEM_CHARS): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const text = sanitizeBundleText(item, maxChars)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out.length > 0 ? out : undefined
}

/**
 * Read one memory entry from untrusted input; undefined when it cannot be carried safely.
 *
 * `mode` is the difference between EXPORT and VALIDATION: export re-applies the "task line means
 * keep only the outcome half" rule ({@link sanitizeMemoryText}); validation must NOT re-apply it,
 * because an ALREADY-exported task entry is outcome-only and no longer contains the separator —
 * re-splitting it would reject this module's own output. Validation therefore only sanitises.
 */
function readMemoryEntry(
  value: unknown,
  mode: 'export' | 'validate' = 'export',
): IdentityBundleMemoryEntry | undefined {
  if (!isRecord(value)) return undefined
  const id = typeof value.id === 'string' && value.id !== '' ? sanitizeBundleText(value.id, 80) : ''
  const kind = value.kind === 'task' || value.kind === 'note' ? value.kind : undefined
  const at = typeof value.at === 'string' ? value.at : ''
  const text = typeof value.text === 'string' ? value.text : ''
  if (id === '' || kind === undefined || at === '') return undefined
  const safeText = mode === 'export'
    ? sanitizeMemoryText(kind, text)
    : sanitizeBundleText(text, MAX_BUNDLE_TEXT_CHARS) || undefined
  if (safeText === undefined) return undefined
  const source = typeof value.source === 'string' && MEMORY_SOURCES.has(value.source)
    ? (value.source as IdentityBundleMemoryEntry['source'])
    : undefined
  const status = typeof value.status === 'string' && MEMORY_STATUSES.has(value.status)
    ? (value.status as IdentityBundleMemoryEntry['status'])
    : undefined
  const outcome = typeof value.outcome === 'string' && MEMORY_OUTCOMES.has(value.outcome)
    ? (value.outcome as IdentityBundleMemoryEntry['outcome'])
    : undefined
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.min(1, Math.max(0, value.confidence))
    : undefined
  return {
    id,
    kind,
    text: safeText,
    at,
    ...(source !== undefined ? { source } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  }
}

function readMemoryBlock(value: unknown): IdentityBundleMemory {
  const items: readonly unknown[] = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.roomEntries)
      ? value.roomEntries
      : []
  const out: IdentityBundleMemoryEntry[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (let index = 0; index < items.length; index += 1) {
    const entry = readMemoryEntry(items[index])
    if (entry === undefined || seen.has(entry.id) || out.length >= MAX_BUNDLE_MEMORY_ENTRIES) {
      dropped += 1
      continue
    }
    seen.add(entry.id)
    out.push(entry)
  }
  return { roomEntries: out, dropped }
}

function readBot(value: unknown): IdentityBundleBot | undefined {
  if (!isRecord(value)) return undefined
  const name = sanitizeBundleText(value.name, 80)
  const description = sanitizeBundleText(value.description, 300)
  if (name === '' || description === '') return undefined
  const systemPrompt = sanitizeBundleText(value.systemPrompt, 8_000)
  const subscriptions = asStringArray(value.subscriptions, 20)
  return {
    name,
    description,
    ...(systemPrompt !== '' ? { systemPrompt } : {}),
    ...(subscriptions !== undefined ? { subscriptions } : {}),
  }
}

function readSkillProfiles(value: unknown): IdentityBundleSkillProfile[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: IdentityBundleSkillProfile[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const names = asStringArray(item.names, 30, 80)
    const signature = sanitizeBundleText(item.signature, 200)
    const analyzedAt = typeof item.analyzedAt === 'string' ? sanitizeBundleText(item.analyzedAt, 40) : ''
    if (names === undefined || analyzedAt === '') continue
    out.push({ names, signature, analyzedAt })
    if (out.length >= 10) break
  }
  return out.length > 0 ? out : undefined
}

function readPatternCards(value: unknown): IdentityBundlePatternCard[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: IdentityBundlePatternCard[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const id = sanitizeBundleText(item.id, 80)
    const task = sanitizeBundleText(item.task, MAX_BUNDLE_TEXT_CHARS)
    const approach = sanitizeBundleText(item.approach, MAX_BUNDLE_TEXT_CHARS)
    const createdAt = typeof item.createdAt === 'string' ? sanitizeBundleText(item.createdAt, 40) : ''
    if (id === '' || task === '' || approach === '' || createdAt === '') continue
    const pitfalls = asStringArray(item.pitfalls, 3)
    const evidence = asStringArray(item.evidence, 5)
    out.push({
      id,
      task,
      approach,
      createdAt,
      source: 'finish',
      ...(pitfalls !== undefined ? { pitfalls } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
    })
    if (out.length >= 20) break
  }
  return out.length > 0 ? out : undefined
}

/**
 * Export one portable identity bundle from untrusted in-memory data.
 *
 * @param input - `bot` (required), aggregated `memory`, optional `skillProfiles` / `patternCards`.
 * @param options.now - injectable timestamp for deterministic tests.
 * @returns a v1 bundle containing only whitelist fields, sanitised and bounded.
 */
export function exportIdentityBundle(
  input: ExportIdentityInput,
  options: { readonly now?: string | undefined } = {},
): IdentityBundle {
  const bot = readBot(input.bot) ?? { name: '', description: '' }
  const memory = readMemoryBlock(input.memory)
  const skillProfiles = readSkillProfiles(input.skillProfiles)
  const patternCards = readPatternCards(input.patternCards)
  return {
    version: IDENTITY_BUNDLE_VERSION,
    exportedAt: options.now ?? new Date().toISOString(),
    bot,
    memory,
    ...(skillProfiles !== undefined ? { skillProfiles } : {}),
    ...(patternCards !== undefined ? { patternCards } : {}),
  }
}

/** Keys that must never appear in a bundle: runtime-owned ids/bindings and credentials. */
const FORBIDDEN_BUNDLE_KEYS: ReadonlyArray<string> = [
  'botId', 'roomId', 'sessionId',
  'botIds', 'roomIds', 'sessionIds',
  'provider', 'profile', 'profileId', 'credentialNamespace', 'memoryNamespace',
  'avatar', 'workspace', 'workspacePath', 'apiKey', 'api_key', 'secret', 'token', 'password',
  'authorization',
]

/** Walk a value and report forbidden keys and absolute-path/secret-looking strings. */
function scanForbidden(value: unknown, where: string, issues: string[]): void {
  if (typeof value === 'string') {
    if (containsAbsolutePath(value)) issues.push(`absolute-path:${where}`)
    if (containsSecret(value)) issues.push(`secret:${where}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbidden(item, `${where}[${index}]`, issues))
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_BUNDLE_KEYS.includes(key)) issues.push(`forbidden-key:${where}.${key}`)
    scanForbidden(child, `${where}.${key}`, issues)
  }
}

/**
 * Validate an untrusted value as an identity bundle.
 *
 * Checks the version, the whitelisted shapes, and (defence in depth) that no forbidden key or
 * absolute path/secret slipped in. `ok` means "importIdentityBundle will accept this".
 */
export function validateIdentityBundle(input: unknown): BundleValidation {
  const issues: string[] = []
  if (!isRecord(input)) {
    return { ok: false, issues: ['bundle-not-an-object'] }
  }
  if (input.version !== IDENTITY_BUNDLE_VERSION) {
    issues.push(`unsupported-version:${String(input.version)}`)
  }
  if (typeof input.exportedAt !== 'string' || input.exportedAt === '') {
    issues.push('missing-exportedAt')
  }
  const bot = readBot(input.bot)
  if (bot === undefined) issues.push('invalid-bot')
  const memory = isRecord(input.memory) ? input.memory : undefined
  if (memory === undefined) {
    issues.push('missing-memory')
  } else if (!Array.isArray(memory.roomEntries)) {
    issues.push('missing-memory-roomEntries')
  } else {
    memory.roomEntries.forEach((entry, index) => {
      if (readMemoryEntry(entry, 'validate') === undefined) issues.push(`invalid-memory-entry:${index}`)
    })
  }
  if (input.skillProfiles !== undefined && readSkillProfiles(input.skillProfiles) === undefined) {
    issues.push('invalid-skillProfiles')
  }
  if (input.patternCards !== undefined && readPatternCards(input.patternCards) === undefined) {
    issues.push('invalid-patternCards')
  }
  scanForbidden(input, 'bundle', issues)
  return { ok: issues.length === 0, issues }
}

/**
 * Turn a validated bundle into a NEW bot draft for the host to create.
 *
 * No RPC, no file, no id: bot/room/session ids are the importing host's to assign. `renameTo`
 * overrides the name (the target may already have a bot with that name); an empty rename is an
 * issue rather than a silent fallback.
 */
export function importIdentityBundle(
  input: unknown,
  options: ImportIdentityOptions = {},
): BundleImportResult {
  const validation = validateIdentityBundle(input)
  if (!validation.ok || !isRecord(input)) return { ...validation }
  const bot = readBot(input.bot)
  if (bot === undefined) return { ok: false, issues: [...validation.issues, 'invalid-bot'] }
  let name = bot.name
  if (options.renameTo !== undefined) {
    const renamed = sanitizeBundleText(options.renameTo, 80)
    if (renamed === '') return { ok: false, issues: [...validation.issues, 'rename-to-empty'] }
    name = renamed
  }
  const skillProfiles = readSkillProfiles(input.skillProfiles)
  const patternCards = readPatternCards(input.patternCards)
  const draft: IdentityBundleDraft = {
    name,
    description: bot.description,
    ...(bot.systemPrompt !== undefined ? { systemPrompt: bot.systemPrompt } : {}),
    ...(bot.subscriptions !== undefined ? { subscriptions: bot.subscriptions } : {}),
    ...(skillProfiles !== undefined ? { skillProfiles } : {}),
    ...(patternCards !== undefined ? { patternCards } : {}),
  }
  // Memory is NOT part of the draft: `mergeMemory` gives the host the entries to place into a
  // freshly created room, so no room/bot id has to be invented here.
  return { ok: true, issues: [], draft }
}

/** The result of {@link mergeMemory}. */
export interface MemoryMergeResult {
  readonly entries: readonly IdentityBundleMemoryEntry[]
  /** Entries in `imported` that were dropped by the id-dedupe or the cap. */
  readonly dropped: number
}

/**
 * Merge an imported memory list into an existing one: existing first, dedupe by id, cap.
 *
 * Existing entries win a conflict (the local room's history is the one the user has seen here);
 * imported entries fill the remaining slots in their bundled order.
 */
export function mergeMemory(
  existing: readonly IdentityBundleMemoryEntry[],
  imported: readonly IdentityBundleMemoryEntry[],
  options: { readonly maxEntries?: number | undefined } = {},
): MemoryMergeResult {
  const max = options.maxEntries === undefined || !Number.isFinite(options.maxEntries)
    ? 12
    : Math.max(1, Math.floor(options.maxEntries))
  const out: IdentityBundleMemoryEntry[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of [...existing, ...imported]) {
    if (seen.has(entry.id)) {
      dropped += 1
      continue
    }
    if (out.length >= max) {
      dropped += 1
      continue
    }
    seen.add(entry.id)
    out.push(entry)
  }
  return { entries: out, dropped }
}
