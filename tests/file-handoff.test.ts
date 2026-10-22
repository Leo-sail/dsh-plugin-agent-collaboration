/**
 * Tests for the file-first handoff (OP-22).
 *
 * Two layers:
 *   · `planFileHandoff` — the safety boundary, driven through an injected filesystem: canonical
 *     containment inside the sender's workspace (including symlink escapes), regular/非空/≤32MB
 *     file checks, and the destination shape `<target>/handoffs/<stamp>-<safe name>`;
 *   · `copyHandoffFile` — the copy step, against both a fake fs and real temp directories, so the
 *     "the source is never moved" property is verified with actual bytes.
 *
 * Run with: node --test tests/file-handoff.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  HANDOFF_DIR,
  MAX_HANDOFF_BYTES,
  MAX_HANDOFF_NAME_LENGTH,
  copyHandoffFile,
  handoffTimestamp,
  planFileHandoff,
  sanitizeHandoffName,
} from '../packages/core/agent-community/src/file-handoff.ts'
import type { HandoffCopyFs, HandoffPlanFs, HandoffStatLike } from '../packages/core/agent-community/src/file-handoff.ts'
import { registerCollaborationTools } from '../packages/core/agent-community/src/collaboration-tools.ts'

const NOW = new Date('2026-10-22T04:39:16.123Z')
const STAMP = '20261022T043916123Z'

const SENDER = '/work/sender'
const TARGET = '/work/target'

interface FakeHandoffFs extends HandoffPlanFs {
  readonly realpathCalls: string[]
  readonly statCalls: string[]
}

/** A fake fs: every path is mapped to a canonical path via `paths`; unknown paths throw ENOENT. */
function makePlanFs(options: {
  readonly real?: Readonly<Record<string, string>>
  readonly files?: Readonly<Record<string, { readonly size: number; readonly dir?: boolean }>>
} = {}): FakeHandoffFs {
  const real = {
    [SENDER]: '/real/sender',
    [TARGET]: '/real/target',
    ...options.real,
  }
  const files = options.files ?? {}
  const realpathCalls: string[] = []
  const statCalls: string[] = []
  return {
    realpathCalls,
    statCalls,
    realpath: async (path) => {
      realpathCalls.push(path)
      const mapped = real[path]
      if (mapped === undefined) throw new Error(`ENOENT: ${path}`)
      return mapped
    },
    stat: async (path): Promise<HandoffStatLike> => {
      statCalls.push(path)
      const entry = files[path]
      if (entry === undefined) throw new Error(`ENOENT: ${path}`)
      return { isFile: () => entry.dir !== true, size: entry.size }
    },
  }
}

const fixedNow = () => NOW

// ── name sanitizing ─────────────────────────────────────────────────────────

test('a normal file name is kept as-is', () => {
  assert.equal(sanitizeHandoffName('report.docx'), 'report.docx')
  assert.equal(sanitizeHandoffName('封面 v2.png'), '封面 v2.png')
})

test('path separators and control characters cannot survive sanitizing', () => {
  for (const raw of ['../../etc/passwd', '..\\..\\windows\\system32', 'a/b/c.txt', 'a\u0000b\n.txt']) {
    const safe = sanitizeHandoffName(raw)
    assert.doesNotMatch(safe, /[\\/\u0000-\u001f]/u, `unsafe input ${JSON.stringify(raw)}`)
  }
})

test('dot-only and empty names fall back to a usable name', () => {
  assert.equal(sanitizeHandoffName(''), 'handoff-file')
  assert.equal(sanitizeHandoffName('   '), 'handoff-file')
  assert.equal(sanitizeHandoffName('...'), 'handoff-file')
  assert.equal(sanitizeHandoffName('name.'), 'name', 'trailing dots are stripped')
})

test('reserved device names are prefixed, extension preserved', () => {
  assert.equal(sanitizeHandoffName('CON'), '_CON')
  assert.equal(sanitizeHandoffName('nul.txt'), '_nul.txt')
  assert.equal(sanitizeHandoffName('com1.csv'), '_com1.csv')
})

test('long names are clamped but keep their extension', () => {
  const safe = sanitizeHandoffName(`${'x'.repeat(400)}.pdf`)
  assert.ok(safe.length <= MAX_HANDOFF_NAME_LENGTH)
  assert.ok(safe.endsWith('.pdf'))
})

test('the destination stamp is UTC, sortable and filesystem-safe', () => {
  assert.equal(handoffTimestamp(NOW), STAMP)
  assert.match(handoffTimestamp(new Date()), /^\d{8}T\d{9}Z$/u)
})

// ── planning ────────────────────────────────────────────────────────────────

test('a valid source is planned into the target workspace handoffs directory', async () => {
  const fs = makePlanFs({
    real: { [`${SENDER}/draft.md`]: '/real/sender/draft.md' },
    files: { '/real/sender/draft.md': { size: 1024 } },
  })
  const plan = await planFileHandoff({
    senderWorkspace: SENDER,
    targetWorkspace: TARGET,
    sourcePath: 'draft.md',
    now: NOW,
    fs,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.sourcePath, '/real/sender/draft.md')
  assert.equal(plan.size, 1024)
  // The TARGET workspace is the path the service owns; it is not canonicalized (the handoffs
  // directory is created by the copy step), so the destination keeps the configured root.
  assert.equal(plan.targetPath, join(TARGET, HANDOFF_DIR, `${STAMP}-draft.md`))
})

test('a relative source is resolved against the sender workspace before canonicalizing', async () => {
  const fs = makePlanFs({
    real: { [`${SENDER}/out/x.txt`]: '/real/sender/out/x.txt' },
    files: { '/real/sender/out/x.txt': { size: 10 } },
  })
  const plan = await planFileHandoff({
    senderWorkspace: SENDER,
    targetWorkspace: TARGET,
    sourcePath: 'out/x.txt',
    now: NOW,
    fs,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(fs.realpathCalls[1], `${SENDER}/out/x.txt`)
})

test('a ../ escape is refused: the canonical source must stay inside the sender workspace', async () => {
  const fs = makePlanFs({
    real: { '/work/secret.md': '/work/secret.md' },
    files: { '/work/secret.md': { size: 12 } },
  })
  const plan = await planFileHandoff({
    senderWorkspace: SENDER,
    targetWorkspace: TARGET,
    sourcePath: '../secret.md',
    now: NOW,
    fs,
  })
  assert.equal(plan.ok, false)
  assert.match(plan.ok === false ? plan.reason : '', /工作区内/u)
})

test('a symlink pointing outside the workspace is refused after realpath', async () => {
  const fs = makePlanFs({
    real: { [`${SENDER}/link`]: '/etc/passwd' },
    files: { '/etc/passwd': { size: 12 } },
  })
  const plan = await planFileHandoff({
    senderWorkspace: SENDER,
    targetWorkspace: TARGET,
    sourcePath: 'link',
    now: NOW,
    fs,
  })
  assert.equal(plan.ok, false)
  assert.match(plan.ok === false ? plan.reason : '', /工作区内/u)
})

test('a missing file is refused', async () => {
  const plan = await planFileHandoff({
    senderWorkspace: SENDER,
    targetWorkspace: TARGET,
    sourcePath: 'missing.md',
    now: NOW,
    fs: makePlanFs(),
  })
  assert.equal(plan.ok, false)
  assert.match(plan.ok === false ? plan.reason : '', /不存在/u)
})

test('a directory is not a handoff candidate', async () => {
  const fs = makePlanFs({
    real: { [`${SENDER}/folder`]: '/real/sender/folder' },
    files: { '/real/sender/folder': { size: 0, dir: true } },
  })
  const plan = await planFileHandoff({
    senderWorkspace: SENDER,
    targetWorkspace: TARGET,
    sourcePath: 'folder',
    now: NOW,
    fs,
  })
  assert.equal(plan.ok, false)
  assert.match(plan.ok === false ? plan.reason : '', /普通文件/u)
})

test('empty files and files over 32MB are refused before any copy', async () => {
  const emptyFs = makePlanFs({
    real: { [`${SENDER}/empty.md`]: '/real/sender/empty.md' },
    files: { '/real/sender/empty.md': { size: 0 } },
  })
  const empty = await planFileHandoff({
    senderWorkspace: SENDER, targetWorkspace: TARGET, sourcePath: 'empty.md', now: NOW, fs: emptyFs,
  })
  assert.equal(empty.ok, false)
  assert.match(empty.ok === false ? empty.reason : '', /为空/u)

  const bigFs = makePlanFs({
    real: { [`${SENDER}/big.bin`]: '/real/sender/big.bin' },
    files: { '/real/sender/big.bin': { size: MAX_HANDOFF_BYTES + 1 } },
  })
  const big = await planFileHandoff({
    senderWorkspace: SENDER, targetWorkspace: TARGET, sourcePath: 'big.bin', now: NOW, fs: bigFs,
  })
  assert.equal(big.ok, false)
  assert.match(big.ok === false ? big.reason : '', /32MB/u)
})

test('a target name is sanitized before it becomes the destination', async () => {
  const fs = makePlanFs({
    real: { [`${SENDER}/draft.md`]: '/real/sender/draft.md' },
    files: { '/real/sender/draft.md': { size: 5 } },
  })
  const plan = await planFileHandoff({
    senderWorkspace: SENDER,
    targetWorkspace: TARGET,
    sourcePath: 'draft.md',
    targetName: '../../evil.docx',
    now: NOW,
    fs,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(basename(plan.targetPath), `${STAMP}-evil.docx`)
})

test('non-absolute workspaces are refused', async () => {
  const plan = await planFileHandoff({
    senderWorkspace: 'relative/path',
    targetWorkspace: TARGET,
    sourcePath: 'x.txt',
    now: NOW,
    fs: makePlanFs(),
  })
  assert.equal(plan.ok, false)
  assert.match(plan.ok === false ? plan.reason : '', /绝对路径/u)
})

// ── copying ────────────────────────────────────────────────────────────────

test('the copy step creates the directory and copies bytes', async () => {
  const calls: string[] = []
  const fs: HandoffCopyFs = {
    mkdir: async (path, options) => { calls.push(`mkdir:${path}:${String(options.recursive)}`) },
    copyFile: async (source, target) => { calls.push(`copy:${source}->${target}`) },
  }
  const result = await copyHandoffFile(
    { sourcePath: '/real/sender/draft.md', targetPath: '/real/target/handoffs/stamp-draft.md' },
    fs,
  )
  assert.deepEqual(result, { ok: true, targetPath: '/real/target/handoffs/stamp-draft.md' })
  assert.deepEqual(calls, [
    'mkdir:/real/target/handoffs:true',
    'copy:/real/sender/draft.md->/real/target/handoffs/stamp-draft.md',
  ])
})

test('a copy failure is reported, not thrown', async () => {
  const fs: HandoffCopyFs = {
    mkdir: async () => undefined,
    copyFile: async () => { throw new Error('EACCES: permission denied') },
  }
  const result = await copyHandoffFile(
    { sourcePath: '/real/sender/draft.md', targetPath: '/real/target/handoffs/stamp-draft.md' },
    fs,
  )
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /复制文件失败/u)
  assert.match(result.ok === false ? result.reason : '', /EACCES/u)
})

test('a real handoff copies the bytes and leaves the source in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-'))
  const senderWorkspace = join(root, 'sender')
  const targetWorkspace = join(root, 'target')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(senderWorkspace, { recursive: true })
  await mkdir(targetWorkspace, { recursive: true })
  const source = join(senderWorkspace, 'draft.md')
  await writeFile(source, 'hello handoff')

  const plan = await planFileHandoff({
    senderWorkspace,
    targetWorkspace,
    sourcePath: 'draft.md',
    now: NOW,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  const copied = await copyHandoffFile(plan)
  assert.equal(copied.ok, true)
  if (!copied.ok) return

  assert.equal(await readFile(copied.targetPath, 'utf8'), 'hello handoff')
  assert.equal(existsSync(source), true, 'the sender keeps its file — a handoff is a copy')
  const inside = await stat(copied.targetPath)
  assert.equal(inside.isFile(), true)
  assert.ok(copied.targetPath.includes(HANDOFF_DIR))
})


// ── interface 3: the tool adapter ───────────────────────────────────────────

interface CapturedTool {
  readonly name: string
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>
}

/**
 * Register the collaboration tools against a fake agent scope and fake deps: only `ownerOf`,
 * `roomKind` and `handoffFile` are real; an unexpected deps call fails the test.
 */
function registerHandoffTool(handoffFile: (input: {
  roomId: string
  botId: string
  toName: string
  path: string
  note?: string
}) => Promise<Record<string, unknown>>, kind: 'direct' | 'group' = 'group'): Map<string, CapturedTool> {
  const captured = new Map<string, CapturedTool>()
  const agentCtx = { tools: { register: (definition: CapturedTool) => { captured.set(definition.name, definition) } } }
  const deps = new Proxy<Record<string, unknown>>({
    ownerOf: () => ({ roomId: 'room-1', botId: 'bot-1' }),
    roomKind: () => kind,
    handoffFile,
  }, {
    get: (target, key) => {
      const value = target[key as string]
      if (value !== undefined) return value
      return () => { throw new Error(`unexpected deps.${String(key)} call`) }
    },
  })
  registerCollaborationTools(agentCtx as never, deps as never)
  return captured
}

test('agent_community_handoff_file is registered and group-only', async () => {
  const tools = registerHandoffTool(async () => ({ ok: true }))
  assert.ok(tools.has('agent_community_handoff_file'))
  const direct = registerHandoffTool(async () => ({ ok: true }), 'direct')
  const directTool = direct.get('agent_community_handoff_file')
  assert.ok(directTool !== undefined)
  const directResult = await directTool.execute({ toName: '小刘', path: 'a.md' }, {})
  assert.equal(directResult['ok'], false)
  assert.match(String(directResult['message']), /group chat/u)
})

test('the tool passes the workspace-relative path and note through to the service', async () => {
  const calls: unknown[] = []
  const tools = registerHandoffTool(async (input) => {
    calls.push(input)
    return { ok: true, targetPath: '/work/target/handoffs/stamp-draft.md', size: 5 }
  })
  const tool = tools.get('agent_community_handoff_file')
  assert.ok(tool !== undefined)
  const result = await tool.execute({ toName: ' 小刘 ', path: ' out/draft.md ', note: ' 请配图 ' }, {})
  assert.equal(result['ok'], true)
  assert.equal(result['targetPath'], '/work/target/handoffs/stamp-draft.md')
  assert.match(String(result['message']), /副本/u)
  assert.deepEqual(calls[0], {
    roomId: 'room-1',
    botId: 'bot-1',
    toName: '小刘',
    path: 'out/draft.md',
    note: '请配图',
  })
})

test('a service refusal is reported with its reason', async () => {
  const tools = registerHandoffTool(async () => ({ ok: false, reason: '本群没有名为「小刘」的成员' }))
  const tool = tools.get('agent_community_handoff_file')
  assert.ok(tool !== undefined)
  const result = await tool.execute({ toName: '小刘', path: 'a.md' }, {})
  assert.equal(result['ok'], false)
  assert.match(String(result['message']), /没有名为/u)
})

test('the tool requires both a member name and a path', async () => {
  const tools = registerHandoffTool(async () => ({ ok: true }))
  const tool = tools.get('agent_community_handoff_file')
  assert.ok(tool !== undefined)
  for (const args of [{}, { toName: '小刘' }, { path: 'a.md' }]) {
    const result = await tool.execute(args, {})
    assert.equal(result['ok'], false)
  }
})
