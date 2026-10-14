#!/usr/bin/env bash
#
# Build ONE self-contained .tgz that installs without npm and without a registry.
#
# WHY THIS EXISTS
#
# `dsh plugin add <spec>` resolves the spec with a package manager. This repo cannot be
# installed from source: its peer dependencies are the `@deepseek-ai/*` packages, which are
# not published to any public registry, so a source install fails before the plugin is
# reached. Publishing to npm is one answer; a prebuilt tarball is the other, and it needs no
# account — the marketplace lists a `tarball:` URL for exactly this case.
#
# The bundle's own dependencies are `file:../../core/agent-community` and friends — paths
# inside this checkout, which do not exist inside a tarball. So the tarball VENDORS all
# three built packages under `vendor/` and rewrites those dependencies to point there.
# The result unpacks to a tree whose `file:` targets resolve, and whose `@deepseek-ai/*`
# peers come from the DSH installation the plugin is being added to.
#
# Usage: scripts/pack-release.sh [output-dir]   → dsh-plugin-agent-collaboration-<version>.tgz
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
BUNDLE="$ROOT/packages/bundle/agent-collaboration"
VERSION="$(node -p "require('$BUNDLE/package.json').version")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# ── 1. refuse to package a tree that is not built ─────────────────────────────
for p in core/agent-community tools/tool-agent-community ui/ui-agent-community bundle/agent-collaboration; do
  lib="$ROOT/packages/$p/lib/index.js"
  [ -s "$lib" ] || { echo "pack-release: MISSING build output: packages/$p/lib/index.js — run 'pnpm bundle' first." >&2; exit 1; }
done
node "$ROOT/scripts/check-build.mjs" >/dev/null || { echo "pack-release: build shape check failed." >&2; exit 1; }

# ── 2. vendor the three packages and rewrite the bundle's file: dependencies ──
PKG="$STAGE/package"
mkdir -p "$PKG"
cp "$BUNDLE/package.json" "$PKG/package.json"
cp -R "$BUNDLE/lib" "$PKG/lib"
cp "$BUNDLE/cordis.patch.yml" "$PKG/cordis.patch.yml"

node - "$ROOT" "$PKG" <<'NODE'
const fs = require('fs'), path = require('path')
const [root, pkgDir] = process.argv.slice(2)

const VENDOR = {
  '@dsh-plugin/agent-community': 'packages/core/agent-community',
  '@dsh-plugin/tool-agent-community': 'packages/tools/tool-agent-community',
  '@dsh-plugin/ui-agent-community': 'packages/ui/ui-agent-community',
}

const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
for (const [name, rel] of Object.entries(VENDOR)) {
  if (pkg.dependencies?.[name] === undefined) continue
  const target = path.join('vendor', path.basename(rel))
  // Copy the built package: manifest, lib, and the per-package patch when present.
  const src = path.join(root, rel)
  const dst = path.join(pkgDir, target)
  fs.mkdirSync(dst, { recursive: true })
  fs.copyFileSync(path.join(src, 'package.json'), path.join(dst, 'package.json'))
  fs.cpSync(path.join(src, 'lib'), path.join(dst, 'lib'), { recursive: true })
  if (fs.existsSync(path.join(src, 'cordis.patch.yml'))) {
    fs.copyFileSync(path.join(src, 'cordis.patch.yml'), path.join(dst, 'cordis.patch.yml'))
  }
  pkg.dependencies[name] = `file:${target}`
}
// `files` decides what npm pack includes. The repo's own value is ["lib","cordis.patch.yml"]
// because nothing vendored exists in a normal checkout; the release tarball is the one place
// `vendor/` has to travel, so it is added here rather than in the committed manifest.
if (!pkg.files.includes('vendor')) pkg.files.push('vendor')
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
console.log('vendored:', Object.values(VENDOR).map(p => path.basename(p)).join(', '))
NODE

# ── 3. pack ──────────────────────────────────────────────────────────────────
mkdir -p "$OUT"
# Run npm pack FROM the package directory: with `--pack-destination` alone, npm looks for a
# package.json in the current directory and fails with ENOENT on the staging root.
( cd "$PKG" && npm pack --pack-destination "$OUT" --ignore-scripts >/dev/null )
TGZ="$OUT/dsh-plugin-agent-collaboration-$VERSION.tgz"
[ -s "$TGZ" ] || { echo "pack-release: npm pack produced nothing." >&2; exit 1; }

# ── 4. assert the tarball can actually resolve: file: targets must be inside it ─
node - "$TGZ" <<'NODE'
const { execFileSync } = require('child_process')
const tgz = process.argv[2]
const list = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean)
const has = (p) => list.some(x => x === p || x.startsWith(p + '/'))
const need = [
  'package/package.json', 'package/lib/index.js', 'package/cordis.patch.yml',
  'package/vendor/agent-community/lib/index.js',
  'package/vendor/tool-agent-community/lib/index.js',
  'package/vendor/ui-agent-community/lib/index.js',
  'package/vendor/ui-agent-community/lib/client.js',
]
const missing = need.filter(p => !has(p))
if (missing.length) { console.error('pack-release: tarball is missing ' + missing.join(', ')); process.exit(1) }
console.log(`  ${list.length} entries, every file: target resolves inside the tarball`)
NODE

printf '  %8s bytes  %s\n' "$(wc -c < "$TGZ" | tr -d ' ')" "$(basename "$TGZ")"
