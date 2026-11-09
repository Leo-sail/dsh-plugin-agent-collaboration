#!/usr/bin/env bash
#
# Build the ONE .tgz that is both attached to the GitHub release and published to npm.
#
# WHY THIS EXISTS
#
# `dsh plugin add <spec>` resolves the spec with a package manager, and this repo cannot be
# installed from source: its peer dependencies are the `@deepseek-ai/*` packages, which are
# published to no public registry, so a source install fails before the plugin is reached. A
# prebuilt tarball is the answer — the marketplace lists a `tarball:` URL for exactly this case
# — and publishing the same staging to npm is how `dsh plugin add dsh-plugin-agent-collaboration`
# resolves.
#
# The bundle's own dependencies are `file:../../core/agent-community` and friends: paths inside
# this checkout, which is what local development and `dsh plugin add "file:<dir>"` use. A tarball
# has no siblings, so the staged manifest rewrites them to the published versions of the three
# component packages.
#
# Those three were VENDORED inside this tarball until 2026-10-15, and that shape did not survive
# contact with pnpm. A `file:` dependency inside a fetched tarball or registry package is resolved
# against the INSTALL ROOT rather than against the package that declares it, so both
# `dsh plugin add <tarball-url>` and `dsh plugin add dsh-plugin-agent-collaboration` died with
# ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND — measured on pnpm 11.7.0 with the profile settings DSH
# writes (nodeLinker: hoisted). Only installing an already-extracted DIRECTORY ever resolved it.
# Registry dependencies resolve from wherever they are declared, and hoisting lands them at the
# profile root, which is where the patch rows and the client module registry look for them.
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

# ── 2. rewrite the bundle's file: dependencies to the published component versions ──
PKG="$STAGE/package"
mkdir -p "$PKG"
cp "$BUNDLE/package.json" "$PKG/package.json"
cp -R "$BUNDLE/lib" "$PKG/lib"
cp "$BUNDLE/cordis.patch.yml" "$PKG/cordis.patch.yml"
# npm renders this on the package page, and the tarball is published to npm as well as attached to
# the release — one README, or the two artifacts describe the plugin differently.
if [ -f "$BUNDLE/README.md" ]; then cp "$BUNDLE/README.md" "$PKG/README.md"; fi

node - "$ROOT" "$PKG" <<'NODE'
const fs = require('fs'), path = require('path')
const [root, pkgDir] = process.argv.slice(2)

const COMPONENTS = {
  '@dsh-plugin-agent-community/agent-community': 'packages/core/agent-community',
  '@dsh-plugin-agent-community/tool-agent-community': 'packages/tools/tool-agent-community',
  '@dsh-plugin-agent-community/ui-agent-community': 'packages/ui/ui-agent-community',
}

const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const staged = []
for (const [name, rel] of Object.entries(COMPONENTS)) {
  if (pkg.dependencies?.[name] === undefined) continue
  // The version comes from the component the tarball was built with, so a release cannot
  // advertise a component version that does not exist.
  const { version } = JSON.parse(fs.readFileSync(path.join(root, rel, 'package.json'), 'utf8'))
  pkg.dependencies[name] = `^${version}`
  staged.push(`${name}@^${version}`)
}
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
console.log('registry deps:', staged.join(', '))
NODE

# ── 3. pack ──────────────────────────────────────────────────────────────────
mkdir -p "$OUT"
# Run npm pack FROM the package directory: with `--pack-destination` alone, npm looks for a
# package.json in the current directory and fails with ENOENT on the staging root.
( cd "$PKG" && npm pack --pack-destination "$OUT" --ignore-scripts >/dev/null )
TGZ="$OUT/dsh-plugin-agent-collaboration-$VERSION.tgz"
[ -s "$TGZ" ] || { echo "pack-release: npm pack produced nothing." >&2; exit 1; }

# ── 4. assert what unpacks, installs ─────────────────────────────────────────
# The failure this replaces was silent until someone installed it: the tarball carried `file:`
# dependencies that resolved inside this checkout and nowhere else. Packing must refuse to
# produce an artifact whose dependencies point back inside itself.
node - "$TGZ" <<'NODE'
const { execFileSync } = require('child_process')
const tgz = process.argv[2]
const list = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean)
const has = (p) => list.some(x => x === p || x.startsWith(p + '/'))
const need = ['package/package.json', 'package/lib/index.js', 'package/cordis.patch.yml', 'package/README.md']
const missing = need.filter(p => !has(p))
if (missing.length) { console.error('pack-release: tarball is missing ' + missing.join(', ')); process.exit(1) }

const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }))
const deps = Object.entries(manifest.dependencies ?? {})
const local = deps.filter(([, spec]) => String(spec).startsWith('file:'))
if (local.length) {
  console.error(
    'pack-release: ' + local.map(([n, s]) => `${n}=${s}`).join(', ') +
    ' resolves against the install root, not against this package — publish the component and depend on its version instead.',
  )
  process.exit(1)
}
const expected = [
  '@dsh-plugin-agent-community/agent-community',
  '@dsh-plugin-agent-community/tool-agent-community',
  '@dsh-plugin-agent-community/ui-agent-community',
]
const absent = expected.filter((name) => manifest.dependencies?.[name] === undefined)
if (absent.length) { console.error('pack-release: manifest is missing ' + absent.join(', ')); process.exit(1) }
console.log(`  ${list.length} entries, ${deps.length} registry dependencies, no file: targets`)
NODE

printf '  %8s bytes  %s\n' "$(wc -c < "$TGZ" | tr -d ' ')" "$(basename "$TGZ")"
