/**
 * OP-20: cross-runtime identity + memory bundle.
 *
 * The tests pin the safety properties that make a bundle shippable:
 *   · WHITELIST — only named fields leave the runtime; bot/room/session ids, provider/credential
 *     bindings, avatars and workspace paths are never in the output;
 *   · REDACTION — secrets and absolute host paths in prompts/memory/evidence are replaced;
 *   · NO PROMPT BODY — a task memory line exports only its outcome half, and a line that cannot
 *     be split is dropped (never exported verbatim);
 *   · VALIDATE/IMPORT — a hand-edited or future-version bundle is rejected with issues, import
 *     returns a draft with no ids, and `mergeMemory` dedupes by id and caps.
 *
 * Run with: node --test tests/identity-bundle.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  containsAbsolutePath,
  containsSecret,
  exportIdentityBundle,
  IDENTITY_BUNDLE_VERSION,
  importIdentityBundle,
  MAX_BUNDLE_MEMORY_ENTRIES,
  mergeMemory,
  REDACTED_PATH,
  REDACTED_SECRET,
  validateIdentityBundle,
  type IdentityBundle,
  type IdentityBundleMemoryEntry,
} from '../packages/core/agent-community/src/identity-bundle.ts'

const NOW = '2026-10-22T00:00:00.000Z'

/** A realistic bot object: it contains every field that must NOT be exported. */
function botSource() {
  return {
    id: 'bot-123',
    name: '小董',
    description: 'Bot 提示词工程师',
    systemPrompt: '你是一位严谨的工程师。',
    provider: 'deepseek',
    model: 'chat',
    workspace: '/Users/changhao/secret-workspace',
    avatar: { seed: 'x', locked: true, assetPath: '/Users/changhao/avatar.png' },
    profile: { profileId: 'p1', memoryNamespace: 'ns', credentialNamespace: 'cred' },
    builtIn: false,
    createdAt: NOW,
    updatedAt: NOW,
    subscriptions: ['dsh-bot-authoring', 'agent-prompt-design', 'dsh-bot-authoring'],
    secretExtra: 'should-not-leak',
  }
}

function memoryEntry(over: Partial<IdentityBundleMemoryEntry> & { id: string }): IdentityBundleMemoryEntry {
  return {
    id: over.id,
    kind: 'note',
    text: `记忆 ${over.id}`,
    at: NOW,
    ...over,
  }
}

function exportedBundle(): IdentityBundle {
  return exportIdentityBundle({
    bot: botSource(),
    memory: [
      memoryEntry({
        id: 'm-task',
        kind: 'task',
        text: '任务：把 /Users/changhao/project/config.json 改一下 → 结果：已改成 30s，路径 /Users/changhao/project/config.json',
        source: 'run',
        status: 'active',
        outcome: 'positive',
        confidence: 0.7,
      }),
      memoryEntry({
        id: 'm-note',
        kind: 'note',
        text: '用户的 token=abcd1234abcd 放在 /home/user/.env',
      }),
      // Cannot be split into an outcome → must be dropped rather than exporting the run prompt.
      memoryEntry({ id: 'm-prompt', kind: 'task', text: '任务：原始运行提示词正文' }),
    ],
    skillProfiles: [{ names: ['dsh-bot-authoring', 'agent-prompt-design'], signature: 'sig', analyzedAt: NOW }],
    patternCards: [{
      id: 'card-1',
      task: '把配置超时改成30秒',
      approach: '先读配置再改',
      pitfalls: ['不要直接覆盖 /Users/changhao/project/config.json'],
      evidence: ['/Users/changhao/project/config.json', 'msg-42'],
      createdAt: NOW,
    }],
  }, { now: NOW })
}

/** Every key anywhere in the value (for whitelist assertions). */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(item => keysDeep(item))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [key, ...keysDeep(child)])
}

// ── whitelist ────────────────────────────────────────────────────────────────

test('export copies only whitelist fields: no ids, bindings, avatars, workspaces or extras', () => {
  const bundle = exportedBundle()
  assert.equal(bundle.version, IDENTITY_BUNDLE_VERSION)
  assert.equal(bundle.exportedAt, NOW)
  assert.deepEqual(Object.keys(bundle.bot).sort(), ['description', 'name', 'subscriptions', 'systemPrompt'])
  assert.equal(bundle.bot.name, '小董')
  assert.equal(bundle.bot.description, 'Bot 提示词工程师')
  assert.equal(bundle.bot.systemPrompt, '你是一位严谨的工程师。')
  assert.deepEqual([...bundle.bot.subscriptions!], ['dsh-bot-authoring', 'agent-prompt-design'])

  const keys = keysDeep(bundle)
  for (const forbidden of ['botId', 'roomId', 'sessionId', 'provider', 'workspace', 'avatar', 'profile', 'apiKey', 'secretExtra', 'credentialNamespace']) {
    assert.equal(keys.includes(forbidden), false, `bundle must not carry ${forbidden}`)
  }
  // And a valid export validates cleanly.
  assert.deepEqual(validateIdentityBundle(bundle), { ok: true, issues: [] })
})

test('nothing in the bundle looks like a secret or an absolute host path', () => {
  const bundle = exportedBundle()
  const serialised = JSON.stringify(bundle)
  assert.equal(serialised.includes('/Users/changhao'), false, 'no Unix host path survives')
  assert.equal(serialised.includes('/home/user'), false, 'no Unix host path survives')
  assert.equal(serialised.includes('abcd1234abcd'), false, 'no secret survives')
  assert.equal(serialised.includes('sk-'), false)
  assert.equal(containsAbsolutePath(serialised), false)
  assert.equal(containsSecret(serialised), false)
  assert.ok(serialised.includes(REDACTED_PATH))
  assert.ok(serialised.includes(REDACTED_SECRET))
})

// ── memory ──────────────────────────────────────────────────────────────────

test('a task memory line exports its outcome half only, never the run prompt', () => {
  const bundle = exportedBundle()
  const task = bundle.memory.roomEntries.find(entry => entry.id === 'm-task')!
  assert.ok(task !== undefined)
  assert.equal(task.text.includes('任务：'), false, 'the run prompt half is not exported')
  assert.ok(task.text.includes('已改成 30s'))
  assert.equal(task.text.includes('/Users/'), false)
  // A task line with no separable outcome is DROPPED, not exported verbatim.
  assert.equal(bundle.memory.roomEntries.some(entry => entry.id === 'm-prompt'), false)
  assert.ok(bundle.memory.dropped >= 1)
  // Lifecycle metadata travels with the entry.
  assert.deepEqual(
    { source: task.source, status: task.status, outcome: task.outcome, confidence: task.confidence },
    { source: 'run', status: 'active', outcome: 'positive', confidence: 0.7 },
  )
})

test('notes are kept, sanitised, and the aggregate is bounded', () => {
  const bundle = exportedBundle()
  const note = bundle.memory.roomEntries.find(entry => entry.id === 'm-note')!
  assert.ok(note.text.length > 0)
  assert.equal(note.text.includes('token=abcd1234abcd'), false)
  assert.equal(note.text.includes('/home/user'), false)

  const many = Array.from({ length: MAX_BUNDLE_MEMORY_ENTRIES + 10 }, (_, i) =>
    memoryEntry({ id: `n${i}`, text: `记忆 ${i}` }))
  const capped = exportIdentityBundle({ bot: botSource(), memory: many }, { now: NOW })
  assert.equal(capped.memory.roomEntries.length, MAX_BUNDLE_MEMORY_ENTRIES)
  assert.equal(capped.memory.dropped, 10)
})

test('export accepts an aggregated {roomEntries} wrapper and keeps entry order', () => {
  const bundle = exportIdentityBundle({
    bot: botSource(),
    memory: { roomEntries: [memoryEntry({ id: 'a' }), memoryEntry({ id: 'b' })] },
  }, { now: NOW })
  assert.deepEqual(bundle.memory.roomEntries.map(entry => entry.id), ['a', 'b'])
})

test('paths glued to Chinese text are still redacted', () => {
  // A word boundary does not exist between a Chinese character and "/", so the redactor must use a
  // unicode-aware boundary; otherwise "见/Users/x" would export the host path verbatim.
  const bundle = exportIdentityBundle({
    bot: { name: '小董', description: '工程师', systemPrompt: '参见/Users/changhao/notes.md 和 C:\\temp\\a.txt' },
  }, { now: NOW })
  const serialised = JSON.stringify(bundle)
  assert.equal(serialised.includes('/Users/'), false)
  assert.equal(serialised.includes('C:\\temp'), false)
  assert.equal(containsAbsolutePath('/Users/x/notes.md'), true)
  assert.equal(containsAbsolutePath('见/Users/x/notes.md'), true)
  assert.equal(containsAbsolutePath('没有路径的普通句子'), false)
})

test('export is deterministic given the same input and an injected now', () => {
  assert.deepEqual(exportedBundle(), exportedBundle())
})

// ── validation ──────────────────────────────────────────────────────────────

test('a minimal v1 bundle is valid (legacy/forward-compatible fields are ignored)', () => {
  const minimal = {
    version: 1,
    exportedAt: NOW,
    bot: { name: '小董', description: '工程师' },
    memory: { roomEntries: [] },
    someFutureField: { ignored: true },
  }
  assert.deepEqual(validateIdentityBundle(minimal), { ok: true, issues: [] })
  assert.deepEqual(validateIdentityBundle(exportedBundle()), { ok: true, issues: [] })
})

test('invalid bundles are rejected with specific issues', () => {
  const version2 = { ...exportedBundle(), version: 2 }
  assert.equal(validateIdentityBundle(version2).ok, false)
  assert.ok(validateIdentityBundle(version2).issues.some(issue => issue.startsWith('unsupported-version')))

  const noBot = { ...exportedBundle(), bot: undefined }
  assert.ok(validateIdentityBundle(noBot).issues.includes('invalid-bot'))

  const badMemory = { ...exportedBundle(), memory: { roomEntries: [{ id: 'x' }] } }
  assert.ok(validateIdentityBundle(badMemory).issues.some(issue => issue.startsWith('invalid-memory-entry')))

  // Defence in depth: a hand-edited bundle carrying runtime ids or a path is refused.
  const withId = { ...exportedBundle(), bot: { ...exportedBundle().bot, botId: 'bot-1' } }
  assert.ok(validateIdentityBundle(withId).issues.some(issue => issue.startsWith('forbidden-key')))

  const withPath = { ...exportedBundle(), bot: { ...exportedBundle().bot, systemPrompt: '/Users/x/notes.md' } }
  assert.ok(validateIdentityBundle(withPath).issues.some(issue => issue.startsWith('absolute-path')))

  const withSecret = { ...exportedBundle(), bot: { ...exportedBundle().bot, systemPrompt: 'api_key=abcdefgh' } }
  assert.ok(validateIdentityBundle(withSecret).issues.some(issue => issue.startsWith('secret')))

  assert.deepEqual(validateIdentityBundle(null), { ok: false, issues: ['bundle-not-an-object'] })
})

// ── import ──────────────────────────────────────────────────────────────────

test('import returns a plain bot draft: no ids, no RPC, host assigns everything', () => {
  const result = importIdentityBundle(exportedBundle())
  assert.equal(result.ok, true)
  const draft = result.draft!
  assert.equal(draft.name, '小董')
  assert.equal(draft.description, 'Bot 提示词工程师')
  assert.equal(draft.systemPrompt, '你是一位严谨的工程师。')
  assert.deepEqual([...draft.subscriptions!], ['dsh-bot-authoring', 'agent-prompt-design'])
  assert.equal(draft.skillProfiles?.length, 1)
  assert.equal(draft.patternCards?.length, 1)
  // Runtime-owned ids must not be on the draft itself. Pattern-card ids are portable content ids
  // (they identify a learned pattern, not a bot/room/session), so they are allowed.
  assert.deepEqual(
    Object.keys(draft).filter(key => ['id', 'botId', 'roomId', 'sessionId', 'workspace'].includes(key)),
    [],
  )
})

test('renameTo renames the draft; an empty rename is an issue, not a silent fallback', () => {
  assert.equal(importIdentityBundle(exportedBundle(), { renameTo: '小董（迁移）' }).draft?.name, '小董（迁移）')
  const empty = importIdentityBundle(exportedBundle(), { renameTo: '   ' })
  assert.equal(empty.ok, false)
  assert.ok(empty.issues.includes('rename-to-empty'))
  // A renamed import must not smuggle a path in either.
  const pathy = importIdentityBundle(exportedBundle(), { renameTo: '/Users/x/bot' })
  assert.equal(pathy.draft?.name.includes('/Users/'), false)
})

test('importing an invalid bundle yields no draft', () => {
  const result = importIdentityBundle({ version: 1, exportedAt: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.draft, undefined)
  assert.equal(importIdentityBundle('<xml/>').draft, undefined)
})

// ── memory merge ────────────────────────────────────────────────────────────

test('mergeMemory dedupes by id (local first), keeps bundled order, and caps', () => {
  const existing = [memoryEntry({ id: 'a', text: '本地版本 a' }), memoryEntry({ id: 'b', text: '本地版本 b' })]
  const imported = [
    memoryEntry({ id: 'a', text: '导入版本 a（应被忽略）' }),
    memoryEntry({ id: 'c' }),
    memoryEntry({ id: 'd' }),
  ]
  const merged = mergeMemory(existing, imported, { maxEntries: 3 })
  assert.deepEqual(merged.entries.map(entry => entry.id), ['a', 'b', 'c'])
  assert.equal(merged.entries[0]!.text, '本地版本 a', 'the local entry wins a conflict')
  assert.equal(merged.dropped, 2, 'duplicate a + capped d')

  const defaults = mergeMemory([], Array.from({ length: 20 }, (_, i) => memoryEntry({ id: `x${i}` })))
  assert.equal(defaults.entries.length, 12, 'default cap matches the room memory cap')
  assert.equal(mergeMemory(existing, []).entries.length, 2)
})
