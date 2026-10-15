# Agent Community — Bots for DeepSeek Harness

**Persistent Bots, group rooms and a durable run ledger, inside DSH.**

[简体中文 README](https://github.com/Leo-sail/dsh-plugin-agent-collaboration/blob/main/README.zh-CN.md) ·
[Repository](https://github.com/Leo-sail/dsh-plugin-agent-collaboration) ·
[Design notes](https://github.com/Leo-sail/dsh-plugin-agent-collaboration/blob/main/DESIGN.md) ·
[MIT](https://github.com/Leo-sail/dsh-plugin-agent-collaboration/blob/main/LICENSE)

> A community-maintained DeepSeek Harness plugin, not an official DeepSeek product.

A Bot here is not a temporary subagent: it has an identity, its own model and permission preset, its own
workspace, and its own session that survives a restart. Put several of them in a room and they answer
together. Every run is recorded, so a conversation can be read back later even after the session that
produced it is gone.

## Install

```bash
dsh plugin add dsh-plugin-agent-collaboration
```

Or install the release tarball, which carries the same three packages prebuilt:

```bash
dsh plugin add https://github.com/Leo-sail/dsh-plugin-agent-collaboration/releases/download/v0.1.2/dsh-plugin-agent-collaboration-0.1.2.tgz
```

Restart DSH and refresh the page — **Bots团队** appears in the sidebar.

Install either way into a DSH profile, not into a bare directory: the `@deepseek-ai/*` packages this
plugin peers on are part of the DSH installation and are on no public registry.

## What it adds

- **Bots that persist.** Name, model, permission preset and workspace live on disk; each Bot answers in
  any room it belongs to, before and after a restart.
- **One-to-one and group conversations.** A message naming one Bot routes to that Bot; a message naming
  nobody is answered by every member.
- **Queued, leased, recoverable runs.** Each answer is a run with a lease and a heartbeat; a run whose
  runtime dies is reclaimed instead of blocking the room.
- **A durable transcript.** The panel draws from a ledger written as the run happens — messages, tool
  calls and their results, approvals, errors — not from the session log.
- **13 model-facing tools**, so a Bot can create rooms, hand work to another Bot, and decompose a
  request into tasks.

This package is the installable entry: it mounts `@dsh-plugin-agent-community/agent-community`,
`@dsh-plugin-agent-community/tool-agent-community` and `@dsh-plugin-agent-community/ui-agent-community`, which it carries prebuilt. Each
of the three is also installable on its own from the repository.

## Requirements

| | |
| --- | --- |
| DeepSeek Harness | `0.2.0-rc.2` (the version these packages are built and typechecked against) |
| Node.js | `^22.19.0` or `>=24` |

Configuration keys, the data layout, and the relationship to DSH's built-in Agent Teams are documented in
the [repository README](https://github.com/Leo-sail/dsh-plugin-agent-collaboration#readme).

## License

[MIT](https://github.com/Leo-sail/dsh-plugin-agent-collaboration/blob/main/LICENSE)
