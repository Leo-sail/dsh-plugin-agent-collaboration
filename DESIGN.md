---
# gstack: design-md-format=spec
name: dsh-plugin-agent-collaboration
description: Utilitarian, information-dense plugin UI that extends DSH without breaking its visual continuity — data at a glance, interactions that get out of the way.
colors:
  # All values reference DSH CSS custom properties. Hard-code fallbacks only for standalone preview.
  primary: "var(--dsw-alias-state-business-primary)"
  on-primary: "var(--dsw-alias-label-primary-foreground)"
  surface: "var(--dsw-alias-bg-base)"
  raised-surface: "var(--dsw-alias-bg-layer-1)"
  elevated-surface: "var(--dsw-alias-bg-layer-2)"
  sidebar-surface: "var(--dsw-alias-bg-module-platform)"
  border-subtle: "var(--dsw-alias-border-l2)"
  border-strong: "var(--dsw-alias-border-l3)"
  text: "var(--dsw-alias-label-primary)"
  text-muted: "var(--dsw-alias-label-secondary)"
  text-faint: "var(--dsw-alias-label-tertiary)"
  interactive-hover: "var(--dsw-alias-interactive-bg-hover)"
  interactive-active: "var(--dsw-alias-interactive-bg-active)"
  accent: "var(--dsw-alias-state-business-primary)"
  success: "var(--dsw-alias-state-success-primary)"
  warning: "var(--dsw-alias-state-warn-primary)"
  error: "var(--dsw-alias-state-error)"
  idle: "var(--dsw-alias-state-idle-primary)"
typography:
  display:
    fontFamily: "var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Helvetica, Arial, sans-serif)"
    fontWeight: "600"
    fontSize: "18px"
    letterSpacing: "-0.01em"
  body:
    fontFamily: "inherit"
    fontSize: "14px"
    lineHeight: "1.57"
  label:
    fontFamily: "inherit"
    fontSize: "12px"
    letterSpacing: "0.03em"
  caption:
    fontFamily: "inherit"
    fontSize: "11px"
    letterSpacing: "0.04em"
rounded:
  sm: "var(--dsw-radius-sm)"
  md: "var(--dsw-radius-md)"
  panel: "var(--dsw-radius-panel)"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
components:
  button-primary:
    backgroundColor: "var(--dsw-alias-button-primary-fill)"
    textColor: "var(--dsw-alias-label-primary-foreground)"
    rounded: "var(--dsw-radius-md)"
  button-ghost:
    backgroundColor: "transparent"
    hover: "var(--dsw-alias-interactive-bg-hover)"
  sidebar-row:
    padding: "8px 36px 8px 10px"
    rounded: "var(--dsw-radius-md)"
    hover: "var(--dsw-alias-interactive-bg-hover)"
  card:
    backgroundColor: "var(--dsw-alias-bg-layer-1)"
    border: "0.5px solid var(--dsw-alias-border-l3)"
    rounded: "var(--dsw-radius-md)"
  status-chip:
    padding: "5px 10px"
    rounded: "var(--dsw-radius-md)"
    border: "0.5px solid var(--dsw-alias-border-l3)"
---

# dsh-plugin-agent-collaboration

## Overview

**Creative North Star:** Dense, purposeful, invisible — the plugin lives inside DSH and should feel like it was always there; no decoration earns its place unless it carries meaning.

**Product context:** A DSH plugin adding Bot Community (persistent bots, rooms, chat) and Agent Teams (roster, task board, peer messaging) to the DSH desktop app. Users are developers running AI agents; the UI is a tool surface, not a landing page.

**Mode per surface:**
- Sidebar lists (Bot list, Room list, Member list): Operate — scan fast, click to navigate
- Chat panels (Community messages, Team messages): Read + Operate — follow async conversation, send messages
- Task board (Team tasks): Operate — claim, update, track
- Configuration modals (Create/edit Bot, Create room): Operate — fill form, submit

**Key characteristics:**
- Visually indistinguishable from native DSH panels — same token stack, same spacing rhythm, same CSS
- Status is always visible: Bot presence, run status, task readiness, member activity shown with `StateDot`-style indicators
- Information density over whitespace — 32px row heights, 2px gaps between list items
- No custom illustration, no decorative color blocks, no rounded-square icon containers

## Colors

**Strategy:** Restrained — the DSH token system owns all color decisions. The plugin uses `--dsw-alias-*` tokens exclusively. The only plugin-specific color choices are semantic assignments: `business-primary` for active/lead states, `state-success/warn/error` for run outcomes, `idle` for offline bots.

**Light or dark:** Inherited from DSH theme. Never hard-code a hex value in a component — always reference a token. Both modes handled automatically.

Accent (`business-primary`) is used for: selected items, active team lead chip border, focused input border. Avoid using it for decoration.

## Typography

All text uses the DSH font stack via `inherit` or the `--dsw-font-family` custom property. No additional fonts.

Scale in use:
- `18px / 600 / -0.01em` — panel headings (h2)
- `14px / 400 / normal` — body, row names, message text
- `13px / 400 / normal` — secondary body, form labels, hints
- `12px / 600 / 0.03em / uppercase` — section headings (BOTS, ROOMS, MEMBERS)
- `12px / 400 / normal` — row meta, secondary labels
- `11px / 500 / 0.06em / uppercase` — eyebrow labels, team kind indicators

## Layout

Two-column grid: `240px sidebar | minmax(0, 1fr) content`. On narrow viewports (<760px), columns stack. Sidebar background uses `bg-module-platform`; content area uses `bg-base` (canvas).

Spacing rhythm: 4px grid. Gaps between list items: 2px. Gaps between sections: 24px. Padding inside content panels: 20-28px horizontal, 20-24px vertical.

## Elevation & Depth

Follow DSH conventions exactly:
- Panel borders: `0.5px solid border-l3`
- Section dividers: `1px solid border-l2`
- Modals: `box-shadow: var(--dsw-elevation-prominent)`, `bg-layer-2`
- Floating menus: `--dsw-elevation-prominent`

No custom shadows or glow effects.

## Shapes

- `--dsw-radius-sm`: small controls, compact buttons, delete buttons (28px)
- `--dsw-radius-md`: standard rows, cards, form inputs, chips
- `--dsw-radius-panel`: modals
- `999px`: pill badges, presence indicators, member chips in team dock

Inner radii on nested elements follow DSH convention (smaller than outer).

## Components

**SidebarRow** — 32px avatar + name/meta text + optional action button. Hover: `interactive-bg-hover`. Active: same hover + `font-weight: 550`. Delete button appears on row hover, right-aligned.

**StatusChip** — Team member chip with presence state. Lead chip gets `border-color: business-primary`. Running state: meta text in `business-primary`. Failed: meta text in `error`.

**TaskRow** — Task item in task board list. Status badge (pending/in_progress/completed) using DSH state colors. Ready indicator via `StateDot`.

**RunStatus** — Inline run status tag. Maps `queued/running/completed/interrupted/failed/cancelled` to DSH state tokens.

**CreateModal** — Reuses DSH `Modal` layout: `min(560px, 100%)` width, scrollable body, form grid with `16px` gaps, label above field.

## Do's and Don'ts

- Do: use `data-active`, `data-presence`, `data-state` attributes for CSS state hooks (matches DSH pattern)
- Do: match DSH row geometry exactly — 10px left padding, 36px right padding for action-button clearance
- Do: use `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on all name/meta text
- Don't: introduce any color not from `--dsw-alias-*` or `--dsw-specific-*` token namespace
- Don't: add box shadows to list rows or sidebar items (flat surfaces only)
- Don't: use emoji as decoration or status indicators — use `StateDot` / CSS state dots
- Don't: wrap everything in cards — only modals, chips, and form fieldsets get a card surface

## Motion

- **Approach:** minimal-functional — only transitions that aid comprehension
- **Easing:** DSH tokens `var(--ds-ease-in-out)`, `var(--ds-transition-duration)`
- **Duration:** DSH `var(--ds-transition-duration)` (~150ms) for hover/active; `var(--ds-transition-duration-slow)` for panel layout changes
- Modal enter: `opacity 0→1` using DSH `modalEnter` pattern
- No animated list reflows, no slide-in panels, no spring physics

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-09 | Use DSH CSS token system exclusively, no hard-coded hex values | Plugin must be visually indistinguishable from native DSH panels across light/dark themes |
| 2026-10-09 | React + injected <style> with plain class-name constants (NOT CSS Modules — see client/styles.ts:1-9; the replica of the native conversation CSS lives in conversation/styles.ts) | Matches project's existing framework; no new build dependencies |
| 2026-10-09 | No custom illustration or decoration | Tool surface, not marketing; decoration without meaning is noise |
