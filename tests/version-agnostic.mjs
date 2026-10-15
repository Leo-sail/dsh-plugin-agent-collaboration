/**
 * Version-agnostic suite — 「插件不应对 DSH 版本有要求」.
 *
 * Two things are asserted, and both are cheap to break later:
 *
 *   1. WHAT THE BUILD ACTUALLY IMPORTS. A DSH package that is only needed for its TYPES must not
 *      appear as a runtime import — otherwise loading the plugin depends on that package being
 *      installed at a compatible version, which is exactly how a real install went wrong (a
 *      profile copy shadowed the host's own, and the user's sessions stopped working).
 *   2. WHAT THE METADATA REQUIRES. No `peerDependencies` entry may carry a version range; every
 *      non-contract package must be optional, so no installer ever refuses or complains.
 *
 * Plus behaviour tests for the two helpers written to replace DSH packages (atomic writes and the
 * tool-schema builder), because "we removed a dependency" is only good news if the replacement works.
 *
 * Usage: node tests/version-agnostic.mjs   (run after `pnpm run bundle`)
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic, readLockOwner } from '../packages/core/agent-community/src/atomic.ts'
import { localUserMessage } from '../packages/core/agent-community/src/dsh-compat.ts'
import { defineTool } from '../packages/tools/tool-agent-community/src/dsh-compat.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// ── 1. 构建产物不得静态导入"只为类型"的 DSH 包 ──────────────────────────────
const REMOVED = ['dsh-atomic-write', 'dsh-llm', 'dsh-tools', 'dsh-session', 'dsh-agent']
const ENTRIES = {
  'core/agent-community': 'packages/core/agent-community/lib/index.js',
  'tools/tool-agent-community': 'packages/tools/tool-agent-community/lib/index.js',
  'ui/ui-agent-community': 'packages/ui/ui-agent-community/lib/index.js',
}
for (const [name, path] of Object.entries(ENTRIES)) {
  let code
  try {
    code = await readFile(path, 'utf8')
  } catch {
    check(false, `${name} 构建产物存在`, `${path} 不存在 —— 先跑 pnpm run bundle`)
    continue
  }
  const offenders = REMOVED.filter(pkg => code.includes(`from "@deepseek-ai/${pkg}"`))
  check(offenders.length === 0, `${name} 不静态导入只为类型的 DSH 包`,
    offenders.length === 0 ? '' : offenders.join(','))
}

// 契约包（插件之所以是插件）允许出现，但只有这三个
const coreCode = await readFile(ENTRIES['core/agent-community'], 'utf8')
const runtimeImports = [...new Set([...coreCode.matchAll(/from "(@deepseek-ai\/[a-z-]+)"/gu)].map(m => m[1]))]
check(runtimeImports.every(pkg => ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/schemastery'].includes(pkg)),
  'core 的运行时 DSH 依赖只剩契约包', runtimeImports.join(','))
const uiCode = await readFile(ENTRIES['ui/ui-agent-community'], 'utf8')
check(!/@deepseek-ai\/[a-z-]+"/u.test(uiCode.replace(/from "node:[^"]+"/gu, '')),
  'ui 包零 DSH 运行时依赖')

// ── 2. 元数据不锁版本 ────────────────────────────────────────────────────────
const MANIFESTS = [
  'packages/core/agent-community/package.json',
  'packages/tools/tool-agent-community/package.json',
  'packages/ui/ui-agent-community/package.json',
  'packages/bundle/agent-collaboration/package.json',
]
const VERSIONED = /[0-9]/u
for (const path of MANIFESTS) {
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  const peers = Object.entries(manifest.peerDependencies ?? {})
  const pinned = peers.filter(([, range]) => VERSIONED.test(String(range)))
  check(pinned.length === 0, `${manifest.name} 的 peer 不带版本范围`,
    pinned.map(([k, v]) => `${k}@${v}`).join(','))
  // 非契约包必须标 optional：宿主没装也不该让安装/加载失败
  const meta = manifest.peerDependenciesMeta ?? {}
  // Required (not optional) only for the plugin contract itself and this plugin's OWN components:
  // those are always installed together, and their range is `*` anyway.
  const required = [
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/schemastery',
  ]
  const notOptional = peers
    .map(([name]) => name)
    .filter(name => !required.includes(name) && !name.startsWith('@dsh-plugin-agent-community/')
      && meta[name]?.optional !== true)
  check(notOptional.length === 0, `${manifest.name} 的非契约 peer 全部可选`,
    notOptional.join(','))
}

// ── 3. 替代实现真的能用：原子写 + 文件锁 ─────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), 'ac-atomic-'))
const target = join(dir, 'state.json')
await writeFileAtomic(target, '{"v":1}', { mode: 0o600 })
check((await readFile(target, 'utf8')) === '{"v":1}', '原子写落盘内容正确')
const mode = (await stat(target)).mode & 0o777
check(mode === 0o600, '原子写尊重 mode（state.json 不该被他人读到）', mode.toString(8))
check((await readFile(target, 'utf8')).includes('v') && !(await readdirHas(dir, 'tmp')), '不留临时文件',
  (await readdirHas(dir, 'tmp')) ? '有 .tmp-* 残留' : '')
async function readdirHas(d, needle) {
  const { readdir } = await import('node:fs/promises')
  return (await readdir(d)).some(f => f.includes(needle))
}

const order = []
await withFileLock(target, async () => { order.push('a:start'); await new Promise(r => setTimeout(r, 30)); order.push('a:end') })
await withFileLock(target, async () => { order.push('b:start'); order.push('b:end') })
check(order.join(',') === 'a:start,a:end,b:start,b:end', '锁是串行的', order.join(','))
check(!(await readdirHas(dir, '.lock')), '锁用完被清掉')

// 别人持锁 → 有界失败，并且报出持有者
await withFileLock(target, async () => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(`${target}.lock`, '999999')
  let message = ''
  try {
    await withFileLock(target, async () => undefined, { waitMs: 60 })
  } catch (error) {
    message = String(error.message)
  }
  check(message.includes('could not lock') && message.includes('999999'),
    '锁被占 → 有界失败并指名持有者', message.slice(0, 80))
  check((await readLockOwner(`${target}.lock`)) === 999999, '能读出锁的持有者 PID')
  await rm(`${target}.lock`, { force: true })
})
await rm(dir, { recursive: true, force: true })

// ── 4. 替代实现：消息与工具 schema ───────────────────────────────────────────
const message = localUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })
check(message.role === 'user' && message.content[0].text === '你好', '本地消息构造正确')
check(typeof message.id === 'string' && message.id.length > 0, '本地消息带 id（下游都按它索引）')

const tool = defineTool({
  name: 'demo',
  description: 'demo tool',
  parameters: {
    required_one: { type: 'string', required: true, description: 'r' },
    optional_one: { type: 'number', description: 'o' },
    choice: { type: 'string', enum: ['a', 'b'] },
  },
  execute: () => ({ ok: true }),
})
check(tool.name === 'demo' && typeof tool.execute === 'function', 'defineTool 保留名字与执行体')
check(tool.parameters.type === 'object' && tool.parameters.additionalProperties === false,
  'defineTool 产出 object schema')
check(tool.parameters.properties.required_one.type === 'string', '参数类型保留')
check(JSON.stringify(tool.parameters.required) === '["required_one"]', '只有 required:true 的进 required 列表',
  JSON.stringify(tool.parameters.required))
check(JSON.stringify(tool.parameters.properties.choice.enum) === '["a","b"]', 'enum 保留')

console.log(`\n[version-agnostic] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
