# dsh-plugin-agent-collaboration — Project Rules

## File Organization

```
packages/
  core/agent-community/src/   # AgentCommunityService and all sub-modules
  tools/tool-agent-community/ # Model-facing community tools
  ui/ui-agent-community/      # Browser UI (sidebar panel + client bundle)
  bundle/agent-collaboration/ # Plugin entry + cordis.patch.yml
```

## Naming

- Packages: `@dsh-plugin/<name>`（例外：bundle 包是未加 scope 的 `dsh-plugin-agent-collaboration`，改名要动 profile 的引用，暂留）
- Source files: kebab-case `.ts`
- No test files committed; no Aeoth-specific references anywhere

## Build

```bash
pnpm install   # install all workspace deps
pnpm bundle     # runs tsdown in each package
```

## State Storage

- Agent Community: `~/.dsh/agent-community/state.json` (JSON, atomic write)
- Agent Team: Session-log projection (no separate file)

## Dependencies Policy

- All DSH peer deps declared as `"*"` (resolved by the host DSH install)
- No `dsh-home-paths` — paths resolved via `node:os` `homedir()` directly
- No Aeoth-specific packages or references

## What NOT to Include

- Test files or test fixtures
- Development/planning documents
- Any reference to "Aeoth" or internal codenames
- Temporary build artifacts in src/
