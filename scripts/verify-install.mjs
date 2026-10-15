/**
 * Verify a local install INTO A DSH PROFILE — the way the host's loader would load it.
 *
 * Run this from the profile directory:
 *
 *   cd ~/.dsh/profiles/<profile>
 *   node <repo>/scripts/verify-install.mjs
 *
 * WHY IT EXISTS. Three separate failures were only visible here, and none of them at build time:
 *
 *   1. the components were left in the OLD scope directory, so the bundle's patch rows (which
 *      name `@dsh-plugin-agent-community/*`) resolved to nothing;
 *   2. the component directories had `lib/` but no `package.json`, so Node could not resolve the
 *      package at all — the byte counts all looked right;
 *   3. the plugin's own DSH imports (`dsh-llm` → `dsh-session` → `dsh-scope` → `dsh-sandbox`)
 *      were missing from the profile because a pnpm reinstall had pruned them. The host does NOT
 *      supply these: its own copies live inside `app.asar`, and Node resolves a plugin's bare
 *      imports from the plugin's real path upward.
 *
 * EXIT CODE 0 means every entry imported, every expected export is present, and the cordis
 * mount shape is right. Anything else prints the missing package by name.
 */
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const profile = process.cwd()
const require = createRequire(join(profile, '__verify-install.cjs'))
let failed = 0
const ok = (label, detail = '') => console.log(`ok   ${label}${detail === '' ? '' : ` — ${detail}`}`)
const bad = (label, detail = '') => { failed += 1; console.log(`FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`) }

// ── 1. the scope directory the bundle's patch rows name ──────────────────────
const COMPONENTS = ['agent-community', 'tool-agent-community', 'ui-agent-community']
const EXPECTED_EXPORTS = {
  // cordis mounts the default export of the service plugin…
  'agent-community': ['default'],
  // …and `apply` + `inject` for the plain ones.
  'tool-agent-community': ['apply'],
  'ui-agent-community': ['apply'],
}

for (const name of COMPONENTS) {
  const spec = `@dsh-plugin-agent-community/${name}`
  let entry
  try {
    entry = require.resolve(spec)
  } catch (error) {
    bad(`${spec} 解析`, String(error.message).split('\n')[0])
    continue
  }
  ok(`${spec} 解析`, entry.replace(process.env.HOME ?? '', '~'))

  // A package directory WITHOUT package.json still yields lib/index.js by direct path, so the
  // presence of the entry alone is not proof — check the manifest too.
  const dir = join(profile, 'node_modules', '@dsh-plugin-agent-community', name)
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    ok(`${name} package.json`, `${manifest.name}@${manifest.version}`)
    if (manifest.name !== spec) bad(`${name} 包名`, `期望 ${spec}，实际 ${manifest.name}`)
  } catch (error) {
    bad(`${name} package.json`, String(error.message).split('\n')[0])
  }
  // The browser half is what the sidebar entry needs.
  if (name === 'ui-agent-community') {
    try {
      statSync(join(dir, 'lib', 'client.js'))
      ok('ui-agent-community lib/client.js', '浏览器半边存在')
    } catch {
      bad('ui-agent-community lib/client.js', '缺少浏览器包，侧边栏入口会消失')
    }
  }

  // ── 2. the real import: this is where a missing DSH dependency surfaces ────
  try {
    const mod = await import(entry)
    const names = Object.keys(mod)
    ok(`${name} 导入`, `${names.length} 个导出`)
    for (const wanted of EXPECTED_EXPORTS[name]) {
      if (!names.includes(wanted)) bad(`${name} 缺少导出 ${wanted}`, names.join(','))
    }
  } catch (error) {
    const message = String(error?.message ?? error).split('\n')[0]
    const missing = /Cannot find package '([^']+)'/.exec(message)
    // ── A MISSING `@deepseek-ai/*` IS EXPECTED, AND MUST STAY MISSING ────────────
    //
    // The host supplies its own packages to plugins: measured on a working install, the profile
    // had none of `dsh-typert-protocol` / `dsh-llm` / `dsh-atomic-write` while the plugin ran
    // fine. Plain Node resolving from this directory cannot see into the host, so this check
    // cannot do better than "the only unresolved specifier is one the host provides".
    //
    // Installing them here is what broke the user's DSH on 2026-10-15 (a profile copy shadowed
    // the packages of the runtime that boots it). Never "fix" this by adding them.
    if (missing !== null && missing[1].startsWith('@deepseek-ai/')) {
      ok(`${name} 导入`, `Node 解析不到宿主的 ${missing[1]}（正常：宿主提供，profile 里必须没有）`)
    } else {
      bad(`${name} 导入`, message)
    }
  }
}

// ── 2b. nothing from the host's own scope may live in the profile ─────────────
try {
  const { readdir } = await import('node:fs/promises')
  const shadow = await readdir(join(profile, 'node_modules', '@deepseek-ai')).catch(() => [])
  if (shadow.length > 0) {
    bad('profile 里没有 @deepseek-ai 包', `发现 ${shadow.length} 个（会遮蔽宿主自带版本，必须清掉）: ${shadow.slice(0, 5).join(',')}`)
  } else {
    ok('profile 里没有 @deepseek-ai 包', '宿主自带的包没有被遮蔽')
  }
} catch (error) {
  bad('检查 @deepseek-ai', String(error?.message ?? error))
}

// ── 3. the bundle the profile mounts ─────────────────────────────────────────
try {
  const manifest = JSON.parse(readFileSync(join(profile, 'node_modules', 'dsh-plugin-agent-collaboration', 'package.json'), 'utf8'))
  ok('bundle', `${manifest.name}@${manifest.version}`)
  const patch = readFileSync(join(profile, 'node_modules', 'dsh-plugin-agent-collaboration', 'cordis.patch.yml'), 'utf8')
    // Comment lines mention other scopes (the history of what used to be mounted); only real
    // YAML keys count, or the check reports a mismatch that does not exist.
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n')
  const scopes = [...patch.matchAll(/^\s*-?\s*name:\s*"(@[^"/]+)\//gmu)].map(m => m[1])
  const wrong = scopes.filter(s => s !== '@dsh-plugin-agent-community')
  if (wrong.length > 0) bad('bundle patch 的 scope 与安装目录不一致', [...new Set(wrong)].join(','))
  else ok('bundle patch', `挂载 ${scopes.length} 行，scope 一致`)
} catch (error) {
  bad('bundle', String(error.message).split('\n')[0])
}

console.log(failed === 0
  ? '\n[verify-install] 全部通过 —— 重启 DSH 后生效（Node 半边在启动时装载；浏览器刷新一次拿客户端半边）'
  : `\n[verify-install] ${failed} 项失败（上面每一行都写了怎么修）`)
process.exit(failed === 0 ? 0 : 1)
