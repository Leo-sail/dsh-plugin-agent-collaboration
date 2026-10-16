#!/usr/bin/env bash
#
# Publish the release: three component packages, then the bundle.
#
# WHY TWO STAGES. The bundle's own dependencies are `file:../../core/agent-community` and friends —
# paths inside this checkout, correct for development but meaningless in a registry. pack-release.sh
# stages a copy whose manifest names the published versions instead, and npm publishes that staging.
# The components therefore have to be on the registry FIRST, or every install of the bundle fails
# with ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND (measured on pnpm 11.7.0 with the nodeLinker settings DSH
# writes).
#
# Usage:  npm login          (once, with the account that owns @dsh-plugin-agent-community)
#         scripts/publish-release.sh [--dry-run]
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# ── THE OFFICIAL REGISTRY, ALWAYS ─────────────────────────────────────────────
#
# A machine can point npm at a mirror (this one defaults to registry.npmmirror.com). Mirrors serve
# reads fine, which is why a `npm view` looks healthy, but they refuse logins and publishes —
# `npm login` against one fails with "Public registration is not allowed", which reads like an npm
# account problem and is really a registry one. Publishing to the mirror would also put the package
# somewhere the marketplace does not read.
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPONENTS=(
  packages/core/agent-community
  packages/tools/tool-agent-community
  packages/ui/ui-agent-community
)

if [ -n "$(git status --porcelain)" ]; then
  echo "publish-release: the working tree is dirty. Commit first — check-build refuses a build that" >&2
  echo "                cannot be reproduced from git, and a published package must match a commit." >&2
  exit 1
fi

if [ "$DRY_RUN" = "0" ]; then
  if ! whoami_out=$(npm whoami --registry="$REGISTRY" 2>/dev/null); then
    echo "publish-release: not logged in to $REGISTRY for the account that owns the" >&2
    echo "                @dsh-plugin-agent-community scope. Authenticate against THAT registry —" >&2
    echo "                a mirror refuses logins with 'Public registration is not allowed':" >&2
    echo "                  npm login --registry=$REGISTRY --auth-type=web" >&2
    exit 1
  fi
  echo "npm user: $whoami_out  (registry: $REGISTRY)"
fi

# The build gate runs first: it refuses to build when sources are uncommitted, so reaching the
# publish step means the artifacts are reproducible from the commit being released.
echo "── build ────────────────────────────────────────────────────────────────────"
pnpm run bundle

echo "── versions ─────────────────────────────────────────────────────────────────"
for dir in "${COMPONENTS[@]}" packages/bundle/agent-collaboration; do
  node -e "const p=require('./$dir/package.json');console.log('  '+p.name+'@'+p.version)"
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "── staging the bundle tarball (file: dependencies become versions) ───────────"
bash scripts/pack-release.sh "$STAGE"

if [ "$DRY_RUN" = "1" ]; then
  echo "── dry run: nothing published ───────────────────────────────────────────────"
  ls -l "$STAGE" | tail -n +2
  exit 0
fi

echo "── publishing components ────────────────────────────────────────────────────"
for dir in "${COMPONENTS[@]}"; do
  name=$(node -e "console.log(require('./$dir/package.json').name)")
  echo "  → $name"
  (cd "$dir" && npm publish --access public --registry="$REGISTRY")
done

echo "── publishing the bundle ────────────────────────────────────────────────────"
TGZ="$(ls "$STAGE"/*.tgz | head -1)"
npm publish "$TGZ" --access public --registry="$REGISTRY"

echo
echo "done. Users install with:"
echo "  dsh plugin --profile <profile> add dsh-plugin-agent-collaboration"
echo
echo "Then attach the same tarball to the GitHub release so the marketplace can list a tarball URL:"
echo "  $TGZ"
