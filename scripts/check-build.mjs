#!/usr/bin/env node
/**
 * Build-shape checks: every assertion here maps to a bug that actually shipped in this repo.
 *
 * Run by `pnpm bundle` (root) and by `scripts/install-profile.sh` before it copies anything.
 * Exit code 1 = do not install.
 *
 *   1. every declared `main`/`types`/`exports` target exists on disk
 *      → `files` omitted `lib/index.d.ts` in two packages, so the installed copy had no types.
 *   2. the browser bundle IS wrapped by __ModuleLoader__ with the right id, and carries no ESM
 *      → the bare-ESM bundle shipped twice and made the whole plugin fail to load in the browser.
 *   3. the wrapped bundle's `require()` ids ⊆ `dsh.client.inject ∪ seed words`
 *      → `inject` listed seven modules the bundle never requires (dead wiring from a removed path).
 *   4. `lib/**` is newer than the newest `src/**`
 *      → committed `lib/` was months stale; a fresh clone installed a 1/20-size plugin.
 *   5. no duplicate selectors inside the two injected stylesheets
 *      → a duplicate `.ac-visually-hidden` silently lost to last-wins.
 *   6. `src` is committed (unless --allow-dirty)
 *      → thirty source files were untracked while their build output was tracked.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const allowDirty = process.argv.includes('--allow-dirty')
const problems = []
const note = (m) => console.log(`check-build: ${m}`)

// ── 1. exports/types targets exist ───────────────────────────────────────────
const PACKAGES = [
  'packages/core/agent-community',
  'packages/tools/tool-agent-community',
  'packages/ui/ui-agent-community',
  'packages/bundle/agent-collaboration',
]
const targets = (value, out = []) => {
  if (typeof value === 'string') out.push(value)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) targets(v, out)
  return out
}
for (const pkg of PACKAGES) {
  const dir = join(ROOT, pkg)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const declared = [...targets(manifest.main ?? []), ...targets(manifest.types ?? []), ...targets(manifest.exports ?? {})]
    .filter((t) => t.startsWith('./') && !t.includes('*'))
  for (const t of declared) {
    if (!existsSync(join(dir, t))) problems.push(`${pkg}: declared path does not exist: ${t}`)
  }
  // The bundle's runtime content is its patch document, not a lib/ tree.
  const expectedFiles = pkg.includes('bundle/') ? 'cordis.patch.yml' : 'lib'
  if (manifest.files && !manifest.files.includes(expectedFiles)) {
    problems.push(`${pkg}: "files" does not include ${expectedFiles}, so the installer's hand-copies are load-bearing`)
  }
}

// ── 2. the browser bundle is wrapped, with the right id ──────────────────────
const ui = 'packages/ui/ui-agent-community'
const clientPath = join(ROOT, ui, 'lib/client.js')
if (existsSync(clientPath)) {
  const code = readFileSync(clientPath, 'utf8')
  const expected = `window.__ModuleLoader__.load({ id: "@dsh-plugin-agent-community/ui-agent-community"`
  if (!code.startsWith(expected)) {
    problems.push(`${ui}/lib/client.js is not the wrapped browser bundle (the DSH loader evaluates it as a classic script)`)
  }
  const esm = code.split('\n').findIndex((l) => /^\s*(?:import\s*[({'*"a-zA-Z]|export\s+(?:default|\{|const|let|var|function|class))/.test(l))
  if (esm >= 0) problems.push(`${ui}/lib/client.js still carries ESM syntax at line ${esm + 1}`)
  // 3. requires ⊆ inject ∪ seed words
  const requires = new Set([...code.matchAll(/require\((["'])([^"']+)\1\)/g)].map((m) => m[2]))
  const manifest = JSON.parse(readFileSync(join(ROOT, ui, 'package.json'), 'utf8'))
  const inject = new Set(manifest.dsh?.client?.inject ?? [])
  const seedWords = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])
  for (const id of requires) {
    const bare = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0]
    if (!inject.has(bare) && !seedWords.has(id) && !inject.has(id)) {
      problems.push(`${ui}: bundle requires ${id}, which is in neither dsh.client.inject nor the loader seed words`)
    }
  }
} else {
  problems.push(`${ui}/lib/client.js is missing — build before checking`)
}

// ── 4. lib newer than src ────────────────────────────────────────────────────
const newest = (dir, filter) => {
  let newestAt = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (filter(entry.name)) newestAt = Math.max(newestAt, statSync(p).mtimeMs)
    }
  }
  if (existsSync(dir)) walk(dir)
  return newestAt
}
for (const pkg of PACKAGES) {
  const lib = newest(join(ROOT, pkg, 'lib'), (n) => n.endsWith('.js'))
  const src = newest(join(ROOT, pkg, 'src'), (n) => n.endsWith('.ts') || n.endsWith('.tsx'))
  if (lib === 0) continue
  if (src > lib) problems.push(`${pkg}: src is newer than lib — rebuild (a stale lib ships an old plugin)`)
}

// ── 5. duplicate selectors in the injected stylesheets ───────────────────────
for (const sheet of ['packages/ui/ui-agent-community/src/client/styles.ts',
                     'packages/ui/ui-agent-community/src/client/conversation/styles.ts']) {
  const text = readFileSync(join(ROOT, sheet), 'utf8')
  const seen = new Map()
  void text
  // Column 0 only: a rule nested in an @media block is an intentional override, not a duplicate.
  for (const m of text.matchAll(/\n(\.ac-[a-z0-9-]+|\.dsh-plugin-community-[a-z0-9-]+)\s*\{/g)) {
    const sel = m[1]
    seen.set(sel, (seen.get(sel) ?? 0) + 1)
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([sel]) => sel)
  if (dupes.length > 0) problems.push(`${sheet}: duplicate selectors (last wins silently): ${dupes.join(', ')}`)
  // Removing a rule by hand is the easiest way to leave a stray brace, which silently kills every
  // rule after it in the injected stylesheet.
  const open = (text.match(/\{/g) ?? []).length
  const close = (text.match(/\}/g) ?? []).length
  if (open !== close) problems.push(`${sheet}: unbalanced braces (${open} { vs ${close} })`)
}

// ── 6. sources are committed ─────────────────────────────────────────────────
if (!allowDirty) {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'packages'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((l) => /\/src\//.test(l))
    if (dirty.length > 0) {
      problems.push(`source files are not committed (${dirty.length}); the installed plugin cannot be reproduced from git`)
    }
  } catch {
    note('git unavailable — skipped the committed-sources check')
  }
}

if (problems.length > 0) {
  console.error('\ncheck-build: FAILED')
  for (const p of problems) console.error(`  · ${p}`)
  process.exit(1)
}
note('OK — build shape verified')
