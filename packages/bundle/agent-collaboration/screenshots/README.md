# Screenshots

[`screenshots.json`](../screenshots.json) — one level up, beside the bundle's `package.json` — is read by
plugin storefronts (the marketplace site and `dsh-market`), which render these as the plugin's page. It
lists **1–8** paths, relative to that file, in display order.

It sits next to the bundle rather than at the repo root because this plugin is listed as a monorepo
subpackage: storefronts read `screenshots.json` from beside the `package.json` of the directory the entry
points at, and a root-level file would never be read. Relative paths are deliberate: rename one of these
files and the break is right here to see, where an absolute URL to the same image would rot silently.

| File | Shows |
| --- | --- |
| `02-group-conversation.png` | A group room where three Bots answered one message, each answer attributed to its own Bot. The headline shot: it is the one thing this plugin does that nothing in the box does. |
| `01-bot-roster.png` | The Bot roster and the room list, with the sidebar entry carrying an unread count. |
| `04-composer-menu.png` | The composer's `＋` menu open: 文件 / 压缩 / 权限 / 模型, then the skills group. |

## How these were taken

An isolated DSH instance (`DSH_HOME` and `HOME` both pointed away from the real ones) with three
throwaway Bots — Atlas / Nova / Orion — and one group room. `HOME` matters: the skills group is scanned
from `~/.agents/skills`, so without redirecting it the menu shot would have exposed the developer's own
installed skills. Everything visible in them is disposable sample data.

Captured at 1440×900 with a 2× device scale factor, so each file is 2880×1800 — enough resolution for a
storefront to scale down — and the whole DSH window is kept so the sidebar entry is visible in context.

## Adding more

Drop the file in this directory, add its path (`screenshots/<file>`) to `screenshots.json`, and it appears
after the next storefront build. Update this table too — a screenshot nobody can identify is a screenshot nobody trusts.

Worth capturing next: the 排队 (queued) → 进行中 (running) → 完成 states side by side, an attachment as it
appears in a transcript, and the 压缩 (compact) summary row.
