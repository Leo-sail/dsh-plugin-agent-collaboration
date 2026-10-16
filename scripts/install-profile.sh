#!/usr/bin/env bash
#
# Install the plugin build outputs into a DSH profile — with integrity checks.
#
# Two failure modes this script exists to prevent, both of which cost a debugging
# session each:
#
#   1. Copy-after-delete. Removing the destination before the copy, when the source
#      is missing or the build failed, deletes the installed plugin and leaves the
#      profile with no entry at all. Here the sources are validated FIRST.
#
#   2. Copying only the browser half. `ui-agent-community` ships TWO files: a
#      `lib/index.js` Node half (a ~200 byte stub the host imports at boot) and a
#      `lib/client.js` browser half wrapped in `window.__ModuleLoader__.load(...)`.
#      Copying the browser bundle over the Node half makes the host's import throw
#      `window is not defined`, and the plugin silently drops out of the client
#      manifest — the sidebar entry simply disappears.
#
# Usage: scripts/install-profile.sh [profile-name]
set -euo pipefail

PROFILE="${1:-desktop}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The scope the bundle's patch rows mount. It moved from `@dsh-plugin` to
# `@dsh-plugin-agent-community` when the components were published under this account's own scope,
# and the copy target has to follow: files left in the old directory are never mounted, because
# nothing names them any more.
# ── WHICH DSH HOME THIS INSTALL TARGETS ──────────────────────────────────────
#
# `DSH_HOME` decides, because a machine can hold several DSH installations side by side — measured
# here: the app's runtime (0.2.0-rc.2, ~/.dsh), a second DSH app (0.2.1-alpha.3, ~/.aeoth) and the
# npx CLI (0.1.2-rc.1). Hard-coding ~/.dsh made an install into any other home impossible, which is
# exactly what a multi-version smoke test needs — and what a user with two DSH apps needs too.
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
DEST="$PROFILE_DIR/node_modules/@dsh-plugin-agent-community"

# The PROFILE is what must exist — that is the typo guard. The scope directory is created here
# rather than required: a profile installed before the rename only has the old one, and pnpm
# materialises the new scope only on a fresh `dsh plugin add`.
[ -d "$PROFILE_DIR" ] || { echo "install-profile: no such profile dir: $PROFILE_DIR" >&2; exit 1; }
mkdir -p "$DEST"

# ── 0. build-shape checks first ───────────────────────────────────────────────
# Every assertion in there maps to a bug this project actually shipped (bare-ESM bundle, stale
# lib/, dangling exports target, duplicate CSS selectors). Installing a broken tree is worse than
# refusing to install.
node "$ROOT/scripts/check-build.mjs" || { echo "install-profile: build shape check failed; nothing was copied." >&2; exit 1; }

# ── 1. validate every source before touching the destination ──────────────────
declare -a PAIRS=(
  "packages/core/agent-community/lib/index.js|agent-community/lib/index.js"
  "packages/core/agent-community/lib/index.d.ts|agent-community/lib/index.d.ts"
  "packages/tools/tool-agent-community/lib/index.js|tool-agent-community/lib/index.js"
  "packages/tools/tool-agent-community/lib/index.d.ts|tool-agent-community/lib/index.d.ts"
  "packages/ui/ui-agent-community/lib/index.js|ui-agent-community/lib/index.js"
  "packages/ui/ui-agent-community/lib/index.d.ts|ui-agent-community/lib/index.d.ts"
  "packages/ui/ui-agent-community/lib/client.js|ui-agent-community/lib/client.js"
)

fail=0
for pair in "${PAIRS[@]}"; do
  src="$ROOT/${pair%%|*}"
  if [ ! -s "$src" ]; then
    echo "install-profile: MISSING build output: ${pair%%|*}" >&2
    fail=1
  fi
done
[ "$fail" = 0 ] || { echo "install-profile: build first; nothing was copied." >&2; exit 1; }

# A stale-but-non-empty lib/ used to install cleanly and ship an old plugin. Compare mtimes.
for pkg in core/agent-community tools/tool-agent-community ui/ui-agent-community; do
  lib="$ROOT/packages/$pkg/lib/index.js"
  [ -e "$lib" ] || continue
  newer=$(find "$ROOT/packages/$pkg/src" -type f \( -name '*.ts' -o -name '*.tsx' \) -newer "$lib" -print -quit)
  if [ -n "$newer" ]; then
    echo "install-profile: packages/$pkg/lib is older than $(basename "$newer") — rebuild (--force not supported)." >&2
    exit 1
  fi
done

# The Node half must never contain the browser loader. This is the exact check that
# would have caught the regression.
UI_NODE_HALF="$ROOT/packages/ui/ui-agent-community/lib/index.js"
if grep -q '__ModuleLoader__' "$UI_NODE_HALF"; then
  echo "install-profile: lib/index.js contains __ModuleLoader__ — that is the BROWSER" >&2
  echo "                 bundle. The host imports lib/index.js in Node and would crash." >&2
  exit 1
fi

# The browser half must BE wrapped. The inverse check below (Node half carries no loader) has
# existed all along, which is why a bare-ESM client bundle passed every gate twice.
#
# THE WINDOW HAS TO FIT THE PATTERN. This read 80 bytes; the pattern is 83 (it grew by 16 when the
# scope moved from `@dsh-plugin` to `@dsh-plugin-agent-community`), so the check could never match
# and every install stopped here with "not the wrapped browser bundle" — measured on a build whose
# first bytes are exactly the expected line.
UI_CLIENT="$ROOT/packages/ui/ui-agent-community/lib/client.js"
if ! head -c 200 "$UI_CLIENT" | grep -q 'window.__ModuleLoader__.load({ id: "@dsh-plugin-agent-community/ui-agent-community"'; then
  echo "install-profile: lib/client.js is not the wrapped browser bundle — the DSH loader" >&2
  echo "                 evaluates it as a classic script and the plugin will not activate." >&2
  exit 1
fi

# ── 2. copy (never delete first) ──────────────────────────────────────────────
#
# THE WHOLE `lib/`, NOT A HAND-PICKED FILE LIST. The list this used to carry named seven
# files, so everything else in a package's build output was left behind in whatever state
# the profile happened to be in — measured: `types.d.ts` and `client.d.ts` were missing
# every field added since the profile was created (a bot's `reasoningEffort`, the fork
# lineage, `BotRoomNotice`), and a stale `index.js.map` sat in the installed UI package
# with no source left in the repo. `diff -rq <repo>/lib <profile>/lib` reported all three.
#
# Mirroring the directory also means a file DELETED from a package (a module merged away,
# an entry removed from `exports`) cannot survive in the profile as a phantom.
for pkg in core/agent-community tools/tool-agent-community ui/ui-agent-community; do
  src="$ROOT/packages/$pkg/lib"
  name="$(basename "$pkg")"
  dst="$DEST/$name/lib"
  mkdir -p "$dst"
  # ── THE MANIFEST IS PART OF THE INSTALL ─────────────────────────────────────
  #
  # A directory with only `lib/` resolves to NOTHING: Node needs `package.json` to turn the
  # package NAME into `lib/index.js`, and every byte count in this script looked perfect while the
  # host could not load the plugin at all. Copy it, so this script alone produces a loadable
  # package with no pnpm step in between.
  # ── ONLY WRITE WHAT ACTUALLY CHANGED ────────────────────────────────────────
  #
  # The host registers client modules with a CONTENT HASH at startup. Rewriting an identical
  # file changes its mtime, and a page refresh after that can be served the new file under the
  # old hash — the client half then fails to load and the plugin's sidebar entry disappears
  # (measured twice, both times right after an install that changed nothing in the UI package).
  # Skipping identical files keeps the hash stable, so a reinstall cannot break a running host.
  copy_if_changed() {
    local from="$1" to="$2"
    if [ -f "$to" ] && cmp -s "$from" "$to"; then
      return 0
    fi
    cp "$from" "$to"
  }
  copy_if_changed "$ROOT/packages/$pkg/package.json" "$DEST/$name/package.json"
  # Copy first, then prune: a failure mid-copy must not leave the package without its files.
  #
  # ONLY WHEN SOMETHING DIFFERS. BSD `cp -R` exits 1 on an identical tree ("are identical (not
  # copied)"), and under `set -e` that aborted the rest of the install — the bot agent preset at
  # the end of this file never ran because of it. `diff -rq` is the check that also keeps a real
  # copy failure visible.
  if ! diff -rq "$src" "$dst" >/dev/null 2>&1; then
    cp -R "$src/." "$dst/"
  fi
  # Remove anything the build no longer produces.
  while IFS= read -r stale; do
    [ -n "$stale" ] || continue
    echo "  prune ${stale#"$dst"/}  (no longer built)"
    rm -f "$stale"
  done < <(cd "$dst" && find . -type f | while read -r f; do [ -e "$src/$f" ] || printf '%s\n' "$dst/${f#./}"; done)
  # Directories the build no longer produces (an entry removed from tsdown's config).
  find "$dst" -mindepth 1 -type d -empty -delete 2>/dev/null || true
done

# ── 3. verify the installed tree ──────────────────────────────────────────────
echo "install-profile: installed into profile '$PROFILE'"
for pair in "${PAIRS[@]}"; do
  src="$ROOT/${pair%%|*}"
  dst="$DEST/${pair##*|}"
  if [ ! -s "$dst" ]; then
    echo "  MISSING  ${pair##*|}" >&2
    exit 1
  fi
  if ! cmp -s "$src" "$dst"; then
    echo "  MISMATCH ${pair##*|}" >&2
    exit 1
  fi
  printf "  ok  %8s bytes  %s\n" "$(wc -c < "$dst" | tr -d ' ')" "${pair##*|}"
done

# ── 4. the BUNDLE half: its patch layer carries the plugin's Config ───────────
#
# pnpm copies this file for a `file:` dependency, so editing the source alone left the
# profile running the OLD config — the maxConcurrentRuns change is exactly the kind of
# edit that would silently never arrive. Missing bundle dir is not fatal (a profile may
# mount the @dsh-plugin rows directly), but a stale patch is.
BUNDLE_SRC_DIR="$ROOT/packages/bundle/agent-collaboration"
BUNDLE_SRC="$BUNDLE_SRC_DIR/cordis.patch.yml"
BUNDLE_DIR="$DSH_HOME_DIR/profiles/$PROFILE/node_modules/dsh-plugin-agent-collaboration"
if [ ! -d "$BUNDLE_DIR" ]; then
  # Silently skipping this used to leave the profile running the OLD patch — the failure mode the
  # header above admits. Refuse unless the caller explicitly says the bundle is mounted elsewhere.
  if [ "${1:-}" = "--allow-missing-bundle" ]; then
    echo "install-profile: WARNING no bundle dir at $BUNDLE_DIR (allowed by flag); patch NOT updated"
  else
    echo "install-profile: no bundle dir at $BUNDLE_DIR — pass --allow-missing-bundle to skip." >&2
    exit 1
  fi
fi
  # ── A SYMLINKED BUNDLE DIR MUST BECOME A REAL COPY ────────────────────────────
  #
  # When the profile's dependency is `link:<somewhere>`, pnpm materialises the bundle directory as
  # a SYMLINK. Node then resolves the bundle's own module names from the TARGET tree, so the three
  # components are loaded from that checkout instead of the copies installed here — a restart keeps
  # running stale code no matter how many times the profile is reinstalled. Observed: every
  # diagnostic added to the installed components never executed, because the host was reading the
  # other tree.
  #
  # Replacing the symlink with a real directory makes the resolution local and unambiguous.
  if [ -L "$BUNDLE_DIR" ]; then
    echo "  replacing symlinked bundle dir with a real copy"
    rm -f "$BUNDLE_DIR"
    mkdir -p "$BUNDLE_DIR"
    cp -R "$BUNDLE_SRC_DIR/." "$BUNDLE_DIR/" 2>/dev/null || true
  fi

if [ -d "$BUNDLE_DIR" ]; then
  if [ ! -s "$BUNDLE_SRC" ]; then
    echo "install-profile: MISSING $BUNDLE_SRC" >&2; exit 1
  fi
  # BSD `cp` EXITS 1 when source and destination are identical, and this script runs under
  # `set -e`: an unconditional copy aborted everything after it, which is how the preset install
  # at the end of this file silently never ran. Copy only when the bytes differ.
  if ! cmp -s "$BUNDLE_SRC" "$BUNDLE_DIR/cordis.patch.yml" 2>/dev/null; then
    cp "$BUNDLE_SRC" "$BUNDLE_DIR/cordis.patch.yml"
  fi
  if ! cmp -s "$BUNDLE_SRC" "$BUNDLE_DIR/cordis.patch.yml"; then
    echo "  MISMATCH cordis.patch.yml" >&2; exit 1
  fi
  printf "  ok  %8s bytes  %s\n" "$(wc -c < "$BUNDLE_DIR/cordis.patch.yml" | tr -d ' ')" "dsh-plugin-agent-collaboration/cordis.patch.yml"

  # The bundle's own lib/ too. pnpm materialises a `file:` dependency by copying the package
  # as it was when the dependency was added, so output built afterwards never arrives —
  # measured: the repo's `lib/index.d.ts` was missing from the installed bundle while its
  # `package.json` promised `./lib/index.d.ts` under `exports.types`.
  BUNDLE_LIB_SRC="$ROOT/packages/bundle/agent-collaboration/lib"
  if [ -d "$BUNDLE_LIB_SRC" ]; then
    mkdir -p "$BUNDLE_DIR/lib"
    if ! diff -rq "$BUNDLE_LIB_SRC" "$BUNDLE_DIR/lib" >/dev/null 2>&1; then
      cp -R "$BUNDLE_LIB_SRC/." "$BUNDLE_DIR/lib/"
    fi
    while IFS= read -r stale; do
      [ -n "$stale" ] || continue
      echo "  prune ${stale#"$BUNDLE_DIR/lib"/}  (no longer built)"
      rm -f "$stale"
    done < <(cd "$BUNDLE_DIR/lib" && find . -type f | while read -r f; do [ -e "$BUNDLE_LIB_SRC/$f" ] || printf '%s\n' "$BUNDLE_DIR/lib/${f#./}"; done)
    echo "  ok  $(find "$BUNDLE_DIR/lib" -type f | wc -l | tr -d ' ') files  dsh-plugin-agent-collaboration/lib"
  fi

  # The manifest carries `exports`/`files`; a stale one points at files that may not exist.
  if ! cmp -s "$ROOT/packages/bundle/agent-collaboration/package.json" "$BUNDLE_DIR/package.json"; then
    cp "$ROOT/packages/bundle/agent-collaboration/package.json" "$BUNDLE_DIR/package.json"
    echo "  updated dsh-plugin-agent-collaboration/package.json"
  fi
fi

# Independent assertion on the installed copy, not just the source.
if grep -q '__ModuleLoader__' "$DEST/ui-agent-community/lib/index.js"; then
  echo "install-profile: installed Node half contains the browser loader" >&2
  exit 1
fi
echo "install-profile: all checks passed."

# ── THE BOT AGENT PRESET ─────────────────────────────────────────────────────
#
# Bot sessions run the plugin's own preset instead of the deployment's `standard` one, because
# `standard` mounts `workflow`/`subagent`/`create_goal`/... per agent and a global deny cannot
# hide those (measured: 11 of them stayed in the catalog). Presets are discovered from
# <DSH_HOME>/.agent-presets, so the plugin's preset is installed there rather than patched into
# any bundle. A host that cannot find it degrades to the deployment default — the plugin never
# requires this file to exist.
PRESET_SRC="$ROOT/packages/bundle/agent-collaboration/agent-presets/bot"
PRESET_DEST="$DSH_HOME_DIR/.agent-presets/bot"
if [ -d "$PRESET_SRC" ]; then
  mkdir -p "$PRESET_DEST"
  for f in preset.yml agent.cordis.yml; do
    if [ -f "$PRESET_SRC/$f" ]; then
      if [ -f "$PRESET_DEST/$f" ] && cmp -s "$PRESET_SRC/$f" "$PRESET_DEST/$f"; then
        :
      else
        cp "$PRESET_SRC/$f" "$PRESET_DEST/$f"
      fi
    fi
  done
  echo "install-profile: bot agent preset → $PRESET_DEST"
fi

# ── pnpm's `.ignored` COPY IS THE ONE THE HOST ACTUALLY LOADS ─────────────────
#
# Measured 2026-10-16: the plugin's client bundle was installed (and verified) under
# node_modules/@dsh-plugin-agent-community/ui-agent-community, while the running host served
# node_modules/.ignored/@dsh-plugin-agent-community/ui-agent-community — a STALE copy — so a
# working 「导出」 button never appeared in the panel and the UI looked untouched. pnpm parks a
# package under `.ignored/` when it decides not to link it, and the profile's resolver can still
# end up there. An install that writes only one of the two locations silently does nothing.
#
# Explicit pairs rather than a discovery loop: the mapping from package to source tree is fixed,
# and a loop that matches nothing fails silently — which is exactly what the first version of this
# block did.
for pair in \
  "core/agent-community:agent-community" \
  "tools/tool-agent-community:tool-agent-community" \
  "ui/ui-agent-community:ui-agent-community"; do
  src="$ROOT/packages/${pair%%:*}/lib"
  # NOTE: $DEST is the SCOPE directory (…/node_modules/@dsh-plugin-agent-community), so the
  # .ignored copy is a SIBLING of it, not a child — building "$DEST/node_modules/…" silently
  # pointed at a path that does not exist, and the guard below then skipped every pair.
  dst="$PROFILE_DIR/node_modules/.ignored/@dsh-plugin-agent-community/${pair##*:}/lib"
  [ -d "$src" ] && [ -d "$dst" ] || continue
  if ! diff -rq "$src" "$dst" >/dev/null 2>&1; then
    cp -R "$src/." "$dst/"
    echo "  refreshed .ignored copy: ${pair##*:}"
  fi
done
