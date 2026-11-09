/**
 * Shared CSS-in-JS helpers for conversation components.
 * All styles use --dsw-* design tokens; no hard-coded colors.
 *
 * The stylesheet below is the **native replica** of the message-area chrome.
 * Every value is transcribed from the shipped DSH bundle:
 *   • `MessageIconActions.module.css`      → chat:1093 (§5.2 of the inventory)
 *   • `MessageItem.module.css` (user row)  → chat:214  (§2.11)
 *   • `TurnTailNodeView.module.css`        → chat:6543 (§2.2)
 *   • `TurnUsagePanel.module.css`          → chat:6402 (§2.3)
 *   • `stat-dialog.module.css`             → chat:6418 (§2.3)
 *   • `TurnNavigator.module.css`           → chat:3566 (§2.15)
 * Class names are `ac-`-prefixed copies of the native hashed module classes so
 * the original selectors (including the `@media (hover:hover)` reveal rules and
 * the `:has(~ …)` consecutive-user rule) survive verbatim.
 */

import type { CSSProperties } from 'react'

export const flexColumn: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
}

export const flexRow: CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
}

/** Avatar tile — 28×28 rounded square with emoji. */
export const avatarStyle: CSSProperties = {
  flexShrink: 0,
  width: 28,
  height: 28,
  borderRadius: 'var(--dsw-radius-md, 8px)',
  border: '0.5px solid var(--dsw-alias-border-l3)',
  background: 'var(--dsw-alias-bg-base)',
  display: 'grid',
  placeItems: 'center',
  fontSize: 14,
  userSelect: 'none',
}

/** Timestamp / meta label — 11px tertiary. */
export const metaLabel: CSSProperties = {
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
  lineHeight: '16px',
}

/** Bot name label — 13px medium primary. */
export const nameLabel: CSSProperties = {
  fontWeight: 500,
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
  lineHeight: '18px',
}

/** Message body text — 14px / 22px line-height. */
export const bodyText: CSSProperties = {
  fontSize: 14,
  lineHeight: '22px',
  color: 'var(--dsw-alias-label-primary)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

/** Subtle muted text. */
export const mutedText: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
  lineHeight: '18px',
}

/** Card surface — canvas background + L2 border. */
export const cardSurface: CSSProperties = {
  borderRadius: 'var(--dsw-radius-md, 8px)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-base)',
}

/**
 * Token usage in the turn tail.
 *
 * Native keeps the trigger to one line (`用量 {total} tok`) and ellipsises it
 * rather than wrapping, so the copy/fork buttons are never pushed away.
 */
export const usageMeta: CSSProperties = {
  ...metaLabel,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** Error accent. */
export const errorAccent: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
}

/** Success accent. */
export const successAccent: CSSProperties = {
  color: 'var(--dsw-alias-state-success-primary)',
}

/** Shimmer animation for streaming text. */
export const shimmerKeyframes = `
@keyframes ac-shimmer {
  0% { background-position: -200% center; }
  100% { background-position: 200% center; }
}
`

/** Spinner keyframes. */
export const spinKeyframes = `
@keyframes ac-spin {
  to { transform: rotate(360deg); }
}
`

/** Pulse animation for live "thinking" / "working" indicators. */
export const pulseKeyframes = `
@keyframes ac-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1); }
}
`

// ── flow gap (native `--dsh-chat-flow-gap`, chat:1623) ────────────────────────

/** Default gap between two flow items. */
export const FLOW_GAP_DEFAULT = 6
/** Gap after a `[data-chat-group-part=response]` item. */
export const FLOW_GAP_AFTER_RESPONSE = 12
/** Gap after a `[data-chat-flow-kind=turn-process]` item / before its answer. */
export const FLOW_GAP_AROUND_PROCESS = 16

/** Which kind of flow item a turn is built from (drives the gap that follows it). */
export type FlowKind = 'reasoning' | 'process' | 'response' | 'deliverable' | 'tail' | 'running'

/**
 * The `margin-top` the *next* flow item gets, i.e. the gap that follows `prev`.
 *
 * Native sets `--dsh-chat-flow-gap` **on** the item and the following sibling
 * consumes it (`.column > * ~ * { margin-top: var(--dsh-chat-flow-gap, 6px) }`),
 * so the value travels forward: 12px after the response, 16px after the
 * turn-process block, 6px everywhere else.
 */
export function flowGapAfter(prev: FlowKind): number {
  if (prev === 'response') return FLOW_GAP_AFTER_RESPONSE
  if (prev === 'process') return FLOW_GAP_AROUND_PROCESS
  return FLOW_GAP_DEFAULT
}

// ── turn rail constants (native TurnNavigator.module.css, chat:3566) ─────────

/** Vertical distance between two turn marks (`TURN_SPACING_PX`). */
export const TURN_SPACING_PX = 10
/** Rail width. */
export const TURN_RAIL_WIDTH = 28
/** Tick size — `20px × 2px`, `border-radius 2px`, origin right. */
export const TURN_MARK_WIDTH = 20
export const TURN_MARK_HEIGHT = 2

// ── native chrome stylesheet ─────────────────────────────────────────────────

const CHROME_STYLE_ID = 'dsh-plugin-ui-agent-community-conversation-chrome'

const CHROME_CSS = `
/* MessageIconActions — native chat:1093 (verbatim selectors/values) */
.ac-actions{height:calc(28px + var(--dsh-content-font-delta,0px));align-items:center;gap:8px;display:flex}
.ac-time-start{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px}
.ac-time-end{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit;white-space:nowrap}
.ac-end-info{min-width:0;color:var(--dsw-alias-label-tertiary);align-items:center;gap:8px;margin-left:8px;display:inline-flex}
@media (hover:hover){
  [data-actions-reveal=hover] .ac-actions,
  :is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])) .ac-actions{opacity:0;transition:opacity 80ms}
  [data-actions-reveal=hover]:hover .ac-actions,
  [data-actions-reveal=hover]:focus-within .ac-actions,
  :is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):hover .ac-actions,
  :is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):focus-within .ac-actions{opacity:1}
}
.ac-action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}
.ac-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
.ac-actions[data-clock=end] .ac-action svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}
.ac-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.ac-action[data-unavailable]{cursor:default;opacity:.4}
.ac-action[data-unavailable]:hover{color:var(--dsw-alias-label-tertiary);background:0 0}
/* Keyboard focus ring — plugin addition (native relies on the app focus ring). */
.ac-action:focus-visible,.ac-usage-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
/* TurnTailNodeView — native chat:6543: the assistant action row is pulled left
   by its button padding and sits 4px under the tail slot. */
.ac-actions-tail{margin-top:4px;margin-left:-6px}

/* TurnUsagePanel trigger — native chat:6402 */
.ac-usage-root{min-width:0;display:inline-flex}
.ac-usage-pop-wrap{position:relative;display:inline-flex;align-items:center;min-width:0}
.ac-usage-trigger{min-width:0;height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;align-items:center;gap:4px;padding:6px 8px;display:inline-flex}
.ac-usage-trigger-label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.ac-usage-trigger svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));flex:none}
.ac-usage-trigger:hover,.ac-usage-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
@media (width<=480px){
  .ac-usage-trigger{width:calc(28px + var(--dsh-content-font-delta,0px));justify-content:center;padding:6px}
  .ac-usage-trigger .ac-usage-trigger-label{display:none}
  .ac-usage-root+.ac-usage-root{margin-left:0}
}
/* Usage dialog — native stat-dialog values (chat:6418), anchored above the
   trigger like native's side:"top" placement (PANEL_GAP = 8px). */
.ac-usage-pop{position:absolute;left:0;bottom:calc(100% + 8px);z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px}
.ac-usage-head{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}
.ac-usage-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex}
.ac-usage-title-label svg{flex:none;width:14px;height:14px}
.ac-usage-title-value{font-variant-numeric:tabular-nums}
.ac-usage-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
.ac-usage-rows{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}
.ac-usage-row{display:contents}
.ac-usage-label{min-width:0;margin:0;color:var(--dsw-alias-label-tertiary)}
.ac-usage-value{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;min-width:0;margin:0}

/* User bubble — native MessageItem.module.css (chat:214) */
.ac-user-row{flex-direction:column;align-items:flex-end;gap:6px;display:flex}
.ac-user-stack{min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);flex-direction:column;align-items:flex-end;gap:8px;display:flex}
.ac-user-bubble{background:var(--dsw-specific-bubble);border-radius:var(--dsw-radius-xl,16px);max-width:100%;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;padding:10px 16px}

/* DisclosureRow — native primitives DisclosureRow.module.css (§5.5); the native
   reasoning row swaps its leading think icon for the chevron on hover. */
.ac-disclosure-row{position:relative;overflow:hidden;display:flex;align-items:center;height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;width:100%;color:var(--dsw-alias-label-tertiary);transition:color 100ms ease;padding:0;border:none;background:none;font:inherit;text-align:left}
.ac-disclosure-row[data-expandable]{cursor:pointer}
.ac-disclosure-row:hover{color:var(--dsw-alias-label-secondary)}
.ac-disclosure-leading{position:relative;flex:none;width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));display:inline-flex;align-items:center;justify-content:center;margin-right:6px;padding:0;border:none;background:none;color:inherit}
.ac-disclosure-leading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}
.ac-icon-idle{display:inline-flex;opacity:1;transition:opacity 100ms ease}
.ac-chevron-hover{position:absolute;inset:0;margin:auto;opacity:0;transition:opacity 100ms ease}
.ac-disclosure-row:hover .ac-icon-idle{opacity:0}
.ac-disclosure-row:hover .ac-chevron-hover{opacity:1}
.ac-disclosure-title{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit}
/* ── ReasoningRow collapsed preview (native ReasoningRow.module.css) ──────────
   The collapsed thinking row is NOT label-only in native: it carries a separator
   dot plus a one-line summary of the newest completed reasoning paragraph,
   shimmering while the block streams. Without it a running bot showed only the
   word 思考过程, so the thinking looked absent until the turn ended. */
.ac-think-separator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
.ac-think-summary{min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;flex:auto;overflow:hidden;color:inherit}
.ac-think-summary>span{display:block;width:auto;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.ac-think-summary[data-streaming]{mask-image:linear-gradient(90deg,#000 calc(100% - 48px),#0000)}
.ac-think-summary[data-streaming]>span{text-overflow:clip;overflow:visible}
/* Disclosure chevron — native artwork, never shrunk by the flex row. */
.ac-chevron{flex:none;color:inherit}

/* Deep-diving row — native chat:1623 (the indicator itself lives in DeepDiving.tsx) */
.ac-running-row{--dsh-chat-flow-gap:12px}

.ac-process{box-sizing:border-box;width:100%;min-width:0;height:calc(33px + var(--dsh-content-font-delta,0px));border:none;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--dsh-content-font-size,14px);cursor:pointer;text-align:left;background:0 0;align-items:center;padding:0 0 8px;transition:color .1s;display:flex}
.ac-process:disabled{cursor:default}
.ac-process:hover:not(:disabled){color:var(--dsw-alias-label-secondary)}
.ac-process-chevron{width:14px;height:14px;color:inherit;flex:none;margin-left:4px;transition:transform .1s}
.ac-process[data-open] .ac-process-chevron{transform:rotate(180deg)}
.ac-process-label{min-width:0;font-size:inherit;line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
@media (prefers-reduced-motion:reduce){.ac-process,.ac-process-chevron{transition:none}}

/* ── ReasoningRow.module.css — expanded thinking body (chat:5744) ───────────
   Native .HiSsxa_thinkBody: the 22px lead-in lines the body up with the
   thinking row's label, so the markdown sits in the same text column. The
   content itself is compact markdown (MarkdownText variant="compact" → the
   dense variant of our Markdown component). */
.ac-think-body{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));min-width:0}

/* ── ChatGroupSeat.module.css — process group header (chat:2160) ────────────
   Native TXqvFW_*, values verbatim: the activity icon and the chevron share one
   16px slot and swap on hover/focus/expanded; the title is 14px tertiary. */
.ac-pgroup-root{min-width:0}
.ac-pgroup-title{max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--dsh-content-font-size,14px);text-align:left;cursor:pointer;background:0 0;border:0;align-items:center;gap:6px;padding:0;transition:color .1s;display:flex}
.ac-pgroup-title:hover{color:var(--dsw-alias-label-secondary)}
.ac-pgroup-leading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:inherit;flex:none;justify-content:center;align-items:center;display:inline-flex;position:relative}
.ac-pgroup-leading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}
.ac-pgroup-leading svg[width="16"]{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px))}
.ac-pgroup-activity,.ac-pgroup-chevron{justify-content:center;align-items:center;transition:opacity .1s;display:inline-flex;position:absolute;inset:0}
.ac-pgroup-activity{opacity:1}
.ac-pgroup-chevron,.ac-pgroup-title:is(:hover,:focus-visible) .ac-pgroup-activity{opacity:0}
.ac-pgroup-title:is(:hover,:focus-visible) .ac-pgroup-chevron{opacity:1}
.ac-pgroup-title[aria-expanded=true] .ac-pgroup-activity{opacity:0}
.ac-pgroup-title[aria-expanded=true] .ac-pgroup-chevron{opacity:1}
.ac-pgroup-title[aria-expanded=true]{padding-bottom:8px}
.ac-pgroup-body{--dsh-chat-flow-gap:6px;overscroll-behavior-y:auto;scrollbar-gutter:stable;max-height:min(400px,50vh);overflow-y:auto}
.ac-pgroup-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.ac-pgroup-fade-top@media (prefers-reduced-motion:reduce){.ac-pgroup-title,.ac-pgroup-activity,.ac-pgroup-chevron{transition:none}}

/* ═══ Native composer (conversation bundle, module yhfFVG) — values verbatim ═══ */
.ac-composer-root{padding:0 var(--dsh-composer-side-clearance) 4px;flex-direction:column;align-items:center;display:flex}
.ac-composer-card{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width);
border-radius:var(--dsw-radius-panel);background:var(--dsw-specific-input-major);
box-shadow:var(--dsw-elevation-soft);font-size:var(--dsh-content-font-size,14px);
line-height:calc(24px + var(--dsh-content-font-delta,0px));border:0;
flex-direction:column;gap:12px;padding-top:8px;display:flex;position:relative}
.ac-composer-input{box-sizing:border-box;min-height:36px;font-family:var(--dsw-font-family);font-size:inherit;
line-height:inherit;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;
color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary);
outline:none;padding:4px 8px 0 14px;border:none;background:transparent;resize:none;display:block;width:100%}
/* Native TurnProcessNodeView: numeric duration segments use the code font with
   tabular figures, so the row does not jitter as the seconds tick. */
/* Completion time under the bot name: tertiary, tabular figures while it ticks. */
.ac-process-count{margin-left:4px}
.ac-process-duration-number{font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums}
.ac-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
clip:rect(0,0,0,0);white-space:nowrap;border:0}
.ac-composer-input-wrap{position:relative;display:block;width:100%}
/* The visible glyphs come from the overlay; the textarea keeps the caret and the
   real text, so only its colour is transparent. Metrics MUST match the overlay. */
.ac-composer-highlight{position:absolute;inset:0;box-sizing:border-box;pointer-events:none;
font-family:var(--dsw-font-family);font-size:inherit;line-height:inherit;
white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;overflow:hidden;
color:var(--dsw-alias-label-primary);padding:4px 8px 0 14px;border:none}
.ac-composer-input-wrap .ac-composer-input{position:relative;color:transparent;background:transparent}
.ac-composer-input-wrap .ac-composer-input::placeholder{color:var(--dsw-alias-label-tertiary)}
/* Reference tokens use the link colour, matching how native marks a skill reference. */
.ac-composer-ref{color:var(--dsw-alias-link)}
.ac-composer-row{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;min-width:0;
padding:2px 8px 6px;display:flex;container-type:inline-size}
.ac-composer-tools{align-items:center;min-width:0;display:flex;gap:12px}
.ac-composer-trailing{flex:none;gap:12px;margin-left:auto;align-items:center;display:flex}
@container (width<=560px){.ac-composer-tools,.ac-composer-trailing{gap:8px}}
/* The "+" control: a 28px round selector chip. */
.ac-composer-add{corner-shape:round;background:var(--dsw-specific-selector);width:28px;height:28px;
color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:999px;flex:none;
place-items:center;display:grid;padding:0;transition:background-color .1s}
.ac-composer-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.ac-composer-add:disabled{opacity:.5;cursor:default}
/* Send: 34px round info button, nudged up 2px as the native does. */
.ac-composer-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}
.ac-composer-primary:disabled{opacity:.4;cursor:default}
/* Retry / secondary text control in the trailing slot. */
/* Accessory attachment chips. */
/* ═══ Native command menu — module tki__G (dsh-client-ui-input-trigger) ═══ */
/* The height cap is viewport-relative, not a fixed 400px. The menu hangs off the
   composer's TOP edge (bottom:calc(100% + 4px)), so a fixed cap pushed its first row
   above the panel as soon as the window was shorter than cap + composer: measured at a
   460px-tall window the menu's top sat at y=-44 and an overflow:hidden panel ancestor
   cut the first row off. display:flex + an overflow-y:auto viewport means a smaller
   cap is paid for with internal scrolling, never with hidden rows. SlashMenu clamps
   max-height in JS on top of this against the nearest clipping ancestor. */
.ac-menu{z-index:100;box-sizing:border-box;max-height:min(60vh,420px);
box-shadow:var(--dsw-elevation-prominent);border:0;
flex-direction:column;padding:4px;display:flex;
position:absolute;bottom:calc(100% + 4px);left:0;right:0;overflow:hidden;
border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-base))}
/* Overflow fade: 16px gradient pinned above the bottom edge. */
.ac-menu[data-overflow-below]:after{content:"";pointer-events:none;height:16px;
position:absolute;bottom:4px;left:4px;right:14px;
background:linear-gradient(to bottom, transparent, var(--dsw-specific-menu))}
/* overscroll-behavior:contain — the menu's own list is the only thing a wheel or a
   keyboard scroll inside it may move; reaching its end must not chain the scroll to
   the transcript behind the menu. */
.ac-menu-viewport{flex-direction:column;min-height:0;display:flex;overflow-y:auto;overscroll-behavior:contain}
/* Row: 34px min-height, 13px text, 6px gap, radius-md. */
.ac-menu-item{border-radius:var(--dsw-radius-md);cursor:pointer;width:100%;min-height:34px;
color:var(--dsw-alias-label-primary);text-align:left;background:0 0;border:none;
align-items:center;gap:6px;padding:6px 8px;font-size:13px;line-height:20px;display:flex}
.ac-menu-item[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.ac-menu-section{min-height:23px;color:var(--dsw-alias-label-tertiary);flex:none;
padding:5px 8px 2px;font-size:11px;font-weight:500;line-height:16px}
.ac-menu-section:not(:first-child){margin-top:3px}
.ac-menu-icon{width:14px;height:14px;color:var(--dsw-alias-menu-icon);flex:none;
justify-content:center;align-items:center;display:inline-flex}
.ac-menu-icon svg{width:14px;height:14px}
.ac-menu-name{text-overflow:ellipsis;white-space:nowrap;flex:none;max-width:40%;overflow:hidden}
.ac-menu-alias{text-overflow:ellipsis;white-space:nowrap;max-width:20%;
color:var(--dsw-alias-label-tertiary);flex:none;font-size:12px;line-height:18px;overflow:hidden}
.ac-menu-desc{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;
color:var(--dsw-alias-label-tertiary);flex:1;font-size:12px;line-height:18px;overflow:hidden}
.ac-menu-trailing{flex:none;align-items:center;gap:3px;margin-left:auto;display:inline-flex}
/* Drill hint + Tab keycap, revealed only on the active row. */
.ac-menu-drill-hint-text{color:var(--dsw-alias-label-caption);white-space:nowrap;font-size:10px;line-height:16px;display:none}
.ac-menu-drill-hint{border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-interactive-bg-hover);
color:var(--dsw-alias-label-caption);padding:0 4px;font-family:inherit;font-size:10px;line-height:16px;display:none}
.ac-menu-item[data-active] .ac-menu-drill-hint-text,.ac-menu-item[data-active] .ac-menu-drill-hint{display:inline-flex}
/* Breadcrumbs for sub-directory navigation. */
.ac-menu-crumbs{border-bottom:.5px solid var(--dsw-alias-border-l1);flex-wrap:wrap;flex:none;
align-items:center;gap:2px;margin-bottom:2px;padding:3px 3px 5px;display:flex}
.ac-menu-crumb{border-radius:var(--dsw-radius-sm);max-width:40%;color:var(--dsw-alias-label-tertiary);
cursor:pointer;text-overflow:ellipsis;white-space:nowrap;background:0 0;border:none;
flex:0 auto;padding:2px 5px;font-family:inherit;font-size:11px;line-height:16px;overflow:hidden}
.ac-menu-crumb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ac-menu-crumb[data-current],.ac-menu-crumb[data-current]:hover{color:var(--dsw-alias-label-primary);cursor:default;background:0 0}
.ac-menu-crumb-sep{color:var(--dsw-alias-menu-icon);flex:none;display:inline-flex}
/* Loading skeleton. */
.ac-menu-skeleton{box-sizing:border-box;align-items:center;min-height:34px;padding:6px 8px;display:flex}
.ac-menu-skeleton-bar{border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton);
height:18px;animation:2s cubic-bezier(.36,0,.64,1) infinite ac-menu-skeleton}
@keyframes ac-menu-skeleton{0%,to{opacity:1}50%{opacity:.45}}
/* Status rows: loading / empty / error + retry. */
.ac-menu-status{color:var(--dsw-alias-label-tertiary);padding:7px 8px;font-size:12px}
/* Sub-menu search field (xRgRca_search). */
.ac-menu-search{border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);
background:0 0;border:.5px solid transparent;outline:none;margin:2px 2px 3px;padding:5px 7px;font-size:12px}
/* Selected check mark (xRgRca_check). */
.ac-menu-check{color:var(--dsw-alias-label-primary);flex:none;margin-left:auto;display:inline-flex}
.ac-menu-check svg{width:14px;height:14px}
/* Badge superscript (xRgRca_badge). */
.ac-menu-badge{color:var(--dsw-alias-label-tertiary);letter-spacing:.2px;flex:none;
align-self:flex-start;margin-top:-1px;font-size:8px;font-weight:600;line-height:10px}
@media (prefers-reduced-motion:reduce){.ac-menu-skeleton-bar{animation:none}}

/* ═══════════════════════════════════════════════════════════════════════════
   Native tool-call row + its expanded cards — value-for-value replica.
   Every declaration below is a renamed copy of a native module stylesheet
   (generated by .verify-toolrow/regen-css.mjs; nothing is hand-transcribed):
     • @deepseek-ai/dsh-client-ui-tool  ToolRow.module.css     → ac-tool-*
     • @deepseek-ai/dsh-client-ui-tool  ToolDetails.module.css → ac-details-*
     • @deepseek-ai/dsh-client-ui-primitives
         DisclosureRow.module.css → ac-dr-*      TextShimmer.module.css → ac-ts-*
         DiffBlock.module.css     → ac-diff-*    ReadBlock.module.css   → ac-read-*
         SearchBlock.module.css   → ac-search-*  WebBlock.module.css    → ac-web-*
         CodeCard.module.css      → ac-card-*
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── ToolRow.module.css (row geometry, states, diff stat) ───────────────────────────────────────────── */
.ac-tool-root{flex-direction:column;display:flex}
.ac-tool-leading{flex-shrink:0}
.ac-tool-root[data-tool^=cordis_] .ac-tool-title{font-weight:500}
.ac-tool-title{font-weight:400}
.ac-tool-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
.ac-tool-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;overflow:hidden}
.ac-tool-summary-suffix{white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:none;margin-left:4px}
.ac-tool-diff-stat{font-family:var(--ds-font-family-code);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);margin-left:10px;transform:translateY(.5px)}
.ac-tool-row:is(:hover,[aria-expanded=true]) .ac-tool-diff-added{color:var(--dsw-alias-state-success-primary)}
.ac-tool-row:is(:hover,[aria-expanded=true]) .ac-tool-diff-removed{color:var(--dsw-alias-state-error-primary)}
.ac-tool-file-link{text-overflow:ellipsis;white-space:nowrap;min-width:0;font:inherit;text-align:left;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit;text-underline-offset:3px;cursor:pointer;background:0 0;border:none;flex:0 auto;margin:0;padding:0;text-decoration:underline 1px dotted;overflow:hidden}
.ac-tool-error-summary{color:var(--dsw-alias-state-error-primary)}
.ac-tool-stopped-summary{color:var(--dsw-alias-state-warn-label)}
.ac-tool-body-wrap{flex-direction:column;display:flex}
.ac-tool-inspect-button{border:.5px solid var(--dsw-alias-border-l3);corner-shape:round;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}
.ac-tool-root:hover .ac-tool-inspect-button,.ac-tool-inspect-button:focus-visible{opacity:1}
.ac-tool-details-body-wrap{position:relative}
.ac-tool-details-body-wrap .ac-tool-inspect-button{margin:0;position:absolute;top:12px;right:12px}
.ac-tool-inspect-button:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.ac-tool-body-scroll{max-height:260px;overflow-y:auto}
.ac-tool-io-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);flex-direction:column;margin:4px 0 4px 4px;display:flex}
.ac-tool-io-section{grid-template-columns:max-content 1fr;align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}
.ac-tool-io-section::-webkit-scrollbar-thumb{border-radius:var(--dsw-radius-sm);background-clip:padding-box;border:2px solid #0000}
.ac-tool-io-section::-webkit-scrollbar-track{margin:6px 0}
.ac-tool-io-label{color:var(--dsw-alias-label-caption);align-self:start;position:sticky;top:0}
.ac-tool-io-divider{background:var(--dsw-alias-border-l2);flex:none;height:.5px}
.ac-tool-io-text{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary)}
.ac-tool-io-text[data-error]{color:var(--dsw-alias-state-error-primary)}
.ac-tool-code-body,.ac-tool-terminal-body,.ac-tool-diff-body,.ac-tool-read-body,.ac-tool-image-body,.ac-tool-search-body,.ac-tool-web-body{margin:4px 0 4px 4px}
.ac-tool-visually-hidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}


/* ── ToolDetails.module.css (details card) ───────────────────────────────────────────── */
.ac-details-root{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);margin:4px 0 4px 4px;overflow:hidden}
.ac-details-list{max-height:320px;margin:0;padding:0;list-style:none;overflow-y:auto}
.ac-details-item,.ac-details-item+.ac-details-item{border-top:.5px solid var(--dsw-alias-border-l2)}
.ac-details-root[data-inspect]:not([data-caption])>.ac-details-list>.ac-details-item,.ac-details-root[data-inspect]:not([data-caption]) .ac-details-empty,.ac-details-root[data-inspect] .ac-details-caption{padding-inline-end:88px}
.ac-details-caption{color:var(--dsw-alias-label-caption);padding:10px 14px 6px;font-size:12px}
.ac-details-heading{flex-wrap:wrap;align-items:baseline;gap:8px;display:flex}
.ac-details-text{white-space:pre-wrap;overflow-wrap:anywhere;flex:1;min-width:0}
.ac-details-status{flex:none;justify-content:center;align-self:flex-start;align-items:center;width:14px;height:18px;font-size:16px;line-height:18px;display:inline-flex}
.ac-details-pending{box-sizing:border-box;border:1px solid var(--dsw-alias-label-tertiary);border-radius:2px;width:10px;height:10px}
.ac-details-heading:has(.ac-details-status-text) .ac-details-text{flex-basis:12em}
.ac-details-status-text{color:var(--dsw-alias-label-caption);white-space:nowrap;margin-inline-start:auto;font-size:12px}
.ac-details-previous,.ac-details-item[data-change=added] .ac-details-status{color:var(--dsw-alias-state-success-primary)}
.ac-details-item[data-change=removed] .ac-details-status{color:var(--dsw-alias-state-error-primary)}
.ac-details-item[data-change=removed] .ac-details-text{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.ac-details-unchanged summary{cursor:pointer;align-items:center;gap:6px;padding:9px 14px;list-style:none;display:flex}
.ac-details-unchanged summary::-webkit-details-marker{display:none}
.ac-details-unchanged[open] summary svg{transform:rotate(90deg)}
.ac-details-fields{margin:0}
.ac-details-heading+.ac-details-fields{margin-top:6px}
.ac-details-field{grid-template-columns:5.5em minmax(0,1fr);gap:12px;display:grid}
.ac-details-field+.ac-details-field{margin-top:4px}
.ac-details-field dt{color:var(--dsw-alias-label-caption)}
.ac-details-field dd{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.ac-details-badge{color:var(--dsw-alias-label-caption);flex:none;align-items:center;gap:5px;font-size:12px;display:inline-flex}
.ac-details-badge:before{content:\"\";corner-shape:round;background:currentColor;border-radius:50%;width:5px;height:5px}
.ac-details-badge[data-tone=info]{color:var(--dsw-alias-state-business-primary)}
.ac-details-badge[data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.ac-details-badge[data-tone=warning]{color:var(--dsw-alias-state-warn-primary)}
.ac-details-badge[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.ac-details-subtitle{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;margin-top:3px;font-size:12px}
.ac-details-description{color:var(--dsw-alias-label-caption);white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
.ac-details-lines li+li{margin-top:4px}
.ac-details-group{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:8px}
.ac-details-group>summary{color:var(--dsw-alias-label-caption);cursor:pointer;overflow-wrap:anywhere;align-items:center;gap:6px;padding:8px 0 0;list-style:none;display:flex}
.ac-details-group>summary::-webkit-details-marker{display:none}
.ac-details-group[open]>summary svg{transform:rotate(90deg)}
.ac-details-group>summary svg{flex:none}
.ac-details-group .ac-details-list{max-height:none;overflow:visible}
.ac-details-group .ac-details-item{padding:9px 0 2px 20px}
.ac-details-prose,.ac-details-root .ac-details-item:has(>.ac-details-code:only-child){padding:0}
.ac-details-root .ac-details-item>.ac-details-code:only-child{margin:0}
.ac-details-root .ac-details-group .ac-details-item:has(>.ac-details-code:only-child){padding:4px 0 0 20px}


/* ── AskQuestionCard.module.css ───────────────────────────────────────────── */
.ac-ask-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);flex-direction:column;gap:16px;max-height:360px;margin:4px 0 4px 4px;padding:16px 20px;display:flex;overflow-y:auto}
.ac-ask-item{flex-direction:column;gap:2px;min-width:0;display:flex}
.ac-ask-question,.ac-ask-answer{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));margin:0}
.ac-ask-question{color:var(--dsw-alias-label-tertiary)}
.ac-ask-answer{color:var(--dsw-alias-label-primary)}
.ac-ask-skipped{color:var(--dsw-alias-label-tertiary)}


/* ── DisclosureRow.module.css ───────────────────────────────────────────── */
.ac-dr-root{display:flex;flex-direction:column;width:100%;min-width:0;}
.ac-dr-row{position:relative;overflow:hidden;display:flex;align-items:center;height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-tertiary);transition:color 100ms ease;}
.ac-dr-row[data-expandable]{cursor:pointer;}
.ac-dr-row:hover{color:var(--dsw-alias-label-secondary);}
.ac-dr-leading{position:relative;flex:none;width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));display:inline-flex;align-items:center;justify-content:center;margin-right:6px;padding:0;border:none;background:none;color:inherit;}
.ac-dr-leading svg:not([data-state]){width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px));}
button.ac-dr-leading{cursor:pointer;}
.ac-dr-icon-idle{display:inline-flex;opacity:1;transition:opacity 100ms ease;}
.ac-dr-chevron-hover{position:absolute;inset:0;margin:auto;opacity:0;transition:opacity 100ms ease;}
.ac-dr-row:hover .ac-dr-icon-idle{opacity:0;}
.ac-dr-row:hover .ac-dr-chevron-hover{opacity:1;}
.ac-dr-title{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit;}
@media (prefers-reduced-motion:reduce){.ac-dr-row{transition:none;}
}


/* ── TextShimmer.module.css (running sweep) ───────────────────────────────────────────── */
.ac-ts-root{position:relative;display:inline-grid;width:max-content;max-width:100%;min-width:0;vertical-align:top;color:inherit;}
.ac-ts-content{display:flex;align-items:center;min-width:0;}
.ac-ts-text{color:inherit;}
.ac-ts-text[data-shimmer-text]::after{content:attr(data-shimmer-text);}
.ac-ts-decoration{position:absolute;inset:0;overflow:clip;pointer-events:none;user-select:none;}
.ac-ts-sweep{position:absolute;inset:0;overflow:hidden;color:var(--dsw-alias-label-shimmer);mask-image:linear-gradient(105deg,transparent 0%,black 40% 60%,transparent 100%);transform:translateX(-100%);animation-name:dsh-row-shimmer-sweep;}
.ac-ts-sweep *{color:inherit !important;}
.ac-ts-sweep [data-shimmer-decoration]{background:currentColor;}
.ac-ts-highlight{width:100%;height:100%;transform:translateX(100%);animation-name:dsh-row-shimmer-highlight;}
.ac-ts-sweep,.ac-ts-highlight{animation-duration:1.5s;animation-delay:0.3s;animation-timing-function:steps(48,end);animation-iteration-count:infinite;}
@keyframes dsh-row-shimmer-sweep{0%{transform:translateX(-100%);}
66.6667%,100%{transform:translateX(100%);}
}
@keyframes dsh-row-shimmer-highlight{0%{transform:translateX(100%);}
66.6667%,100%{transform:translateX(-100%);}
}
@media (prefers-reduced-motion:reduce){.ac-ts-decoration{display:none;}
.ac-ts-sweep,.ac-ts-highlight{animation:none;}
}


/* ── DiffBlock.module.css ───────────────────────────────────────────── */
.ac-diff-block{overflow:hidden;}
.ac-diff-body{display:grid;grid-template-columns:minmax(max-content,1fr);padding:6px 0 20px;font:var(--dsw-font-markdown-code-block);overflow-x:auto;}
.ac-diff-line{box-sizing:border-box;min-height:1lh;padding:0 22px;white-space:pre;}
.ac-diff-block[data-code-wrap='true'] .ac-diff-body{grid-template-columns:minmax(0,1fr);}
.ac-diff-block[data-code-wrap='true'] .ac-diff-line{white-space:pre-wrap;overflow-wrap:anywhere;}
.ac-diff-path{color:var(--dsw-alias-label-secondary);font-weight:500;}
.ac-diff-gap{color:var(--dsw-alias-label-tertiary);}
.ac-diff-del::before{content:'- ';}
.ac-diff-del{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-code-diff-deleted);box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary);}
.ac-diff-add::before{content:'+ ';}
.ac-diff-add{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-code-diff-added);box-shadow:inset 3px 0 0 var(--dsw-alias-state-success-primary);}
.ac-diff-context{color:var(--dsw-alias-label-secondary);}
.ac-diff-context::before{content:'  ';}
.ac-diff-expand{display:block;width:100%;padding:0 22px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;text-align:left;}
.ac-diff-expand:hover{color:var(--dsw-alias-label-secondary);}


/* ── ReadBlock.module.css ───────────────────────────────────────────── */
.ac-read-line{display:flex;min-height:1lh;white-space:pre;}
.ac-read-gutter{flex:none;width:var(--dsl-read-gutter);margin-right:12px;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none;}
.ac-read-content{min-width:0;color:var(--dsw-alias-label-primary);}
.ac-read-block[data-code-wrap='true'] .ac-read-line{white-space:pre-wrap;}
.ac-read-block[data-code-wrap='true'] .ac-read-content{overflow-wrap:anywhere;}
.ac-read-expand{display:block;width:100%;padding:0 0 0 calc(var(--dsl-read-gutter) + 12px);border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;text-align:left;}
.ac-read-expand:hover{color:var(--dsw-alias-label-secondary);}


/* ── SearchBlock.module.css ───────────────────────────────────────────── */
.ac-search-block{--dsl-search-radius:var(--dsw-radius-lg);--dsl-search-line-height:22px;position:relative;margin:16px 0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsl-search-radius);}
.ac-search-header{display:flex;align-items:center;gap:12px;padding:9px 14px;background:var(--dsw-alias-markdown-code-block-banner);border-top-left-radius:var(--dsl-search-radius);border-top-right-radius:var(--dsl-search-radius);}
.ac-search-summary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary);}
.ac-search-copy-button{flex:none;background-color:transparent;border:none;padding:0;margin:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13);}
.ac-search-body{padding:8px 14px 12px 0;font:var(--dsw-font-markdown-code-block);overflow-x:auto;overflow-y:hidden;}
.ac-search-line{min-height:var(--dsl-search-line-height);padding-left:14px;white-space:pre;}
.ac-search-line-number{color:var(--dsw-alias-label-tertiary);}
.ac-search-file-header{display:flex;align-items:baseline;gap:8px;width:100%;min-height:var(--dsl-search-line-height);padding:0 14px;border:none;background-color:transparent;cursor:pointer;font:inherit;text-align:left;}
.ac-search-file-path{min-width:0;font-weight:600;color:var(--dsw-alias-label-primary);white-space:pre;}
.ac-search-file-count{flex:none;color:var(--dsw-alias-label-tertiary);}
.ac-search-expand{display:block;width:100%;padding:0 14px;border:none;background-color:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;text-align:left;}
.ac-search-expand:hover{color:var(--dsw-alias-label-secondary);}
.ac-search-empty{padding:12px 14px;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary);}


/* ── WebBlock.module.css ───────────────────────────────────────────── */
.ac-web-block{--dsl-web-radius:var(--dsw-radius-lg);margin:16px 0;padding:12px 14px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsl-web-radius);}
.ac-web-answer{margin-bottom:8px;}
.ac-web-answer > div >:first-child{margin-top:0;}
.ac-web-answer > div >:last-child{margin-bottom:0;}
.ac-web-sources{margin:0;padding-left:2.5em;display:flex;flex-direction:column;gap:10px;max-height:320px;overflow-y:auto;}
.ac-web-source{min-width:0;}
.ac-web-source-link{color:var(--dsw-alias-link);font-size:14px;font-weight:500;line-height:20px;word-break:break-word;text-decoration:none;}
.ac-web-link-icon{width:1.1em;height:1.1em;vertical-align:-0.25em;margin-right:5px;}
.ac-web-source-link:hover,.ac-web-source-link:focus-visible{text-decoration:underline dotted;text-underline-offset:3px;}
.ac-web-snippet{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:19px;word-break:break-word;}
.ac-web-published{margin-top:2px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);}
.ac-web-truncated{margin-top:8px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);}
.ac-web-empty{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);}
.ac-web-fetch{display:flex;flex-direction:column;gap:6px;}
.ac-web-fetch-url{color:var(--dsw-alias-link);font-family:var(--ds-font-family-code);font-size:13px;font-weight:500;line-height:19px;word-break:break-all;text-decoration:none;}
.ac-web-fetch-url:hover,.ac-web-fetch-url:focus-visible{text-decoration:underline dotted;text-underline-offset:3px;}
.ac-web-fetch-meta{display:flex;align-items:baseline;gap:12px;}
.ac-web-status{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);}
.ac-web-fetch .ac-web-truncated{margin-top:0;}


/* ── markdown/CodeCard.module.css (card chrome + toolbar) ───────────────────────────────────────────── */
.ac-card-card{position:relative;margin:16px 0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-lg);font:var(--dsw-font-markdown-code-block);}
.ac-card-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px 8px 22px;background:var(--dsl-code-block-background,var(--dsw-alias-markdown-code-block));border-top-left-radius:inherit;border-top-right-radius:inherit;color:var(--dsw-alias-label-secondary);font:11px/18px var(--dsw-font-family);}
.ac-card-heading{display:flex;align-items:baseline;gap:12px;min-width:0;}
.ac-card-language{color:var(--dsw-alias-label-tertiary);flex:none;font-family:var(--ds-font-family-code);}
.ac-card-title{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-card-actions{display:flex;align-items:center;gap:4px;flex:none;}
.ac-card-status{margin-right:8px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}
.ac-card-action{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;}
.ac-card-action:hover{background:var(--dsw-alias-interactive-bg-hover);}
.ac-card-action:focus-visible{outline:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;}
.ac-card-body{padding:6px 22px 20px;font:var(--dsw-font-markdown-code-block);overflow-x:auto;}

/* ── syntax highlighting ─────────────────────────────────────────────────────
   Token colours come from the native theme package's shiki sheet
   ("@deepseek-ai/dsh-client-ui-theme", extracted by this script): the values are
   var(--shiki-token-*, <native light value>) with the extracted light value as
   fallback, so the host theme drives light
   and dark exactly as it does for the native CodeBlock, and the extracted light
   value is the fallback when no theme sheet is present. The kind → scope table
   lives in the generator. */
.ac-hl-comment{color:var(--shiki-token-comment,#868e96);font-style:italic}
.ac-hl-meta{color:var(--shiki-token-comment,#868e96);font-style:italic}
.ac-hl-string{color:var(--shiki-token-string,#2f9e44)}
.ac-hl-number{color:var(--shiki-token-constant,#1c7ed6)}
.ac-hl-literal{color:var(--shiki-token-constant,#1c7ed6)}
.ac-hl-keyword{color:var(--shiki-token-keyword,#d6336c)}
.ac-hl-type{color:var(--shiki-token-function,#6741d9)}
.ac-hl-tag{color:var(--shiki-token-string-expression,#2b8a3e)}
.ac-hl-variable{color:var(--shiki-token-constant,#1c7ed6)}
.ac-hl-builtin{color:var(--shiki-token-function,#6741d9)}
.ac-hl-function{color:var(--shiki-token-function,#6741d9)}
.ac-hl-property{color:var(--shiki-token-constant,#1c7ed6)}
.ac-hl-attr{color:var(--shiki-token-function,#6741d9)}
.ac-hl-operator{color:var(--shiki-token-punctuation,#495057)}
.ac-hl-key{color:var(--shiki-token-keyword,#d6336c)}
.ac-hl-symbol{color:var(--shiki-token-keyword,#d6336c)}
.ac-hl-link{color:var(--shiki-token-link,#1971c2)}
.ac-hl-param{color:var(--shiki-token-parameter,#e8590c)}
.ac-hl-bold{font-weight:bold}
.ac-hl-italic{font-style:italic}
`

if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CHROME_STYLE_ID}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.pluginCss = CHROME_STYLE_ID
  tag.textContent = CHROME_CSS
  document.head.appendChild(tag)
}

/**
 * Plugin-only chrome: the group-proposal dialog (§5.4) and the queue banner (§22.1).
 *
 * This deliberately lives in its OWN sheet, appended after the replica above, rather
 * than inside `CHROME_CSS`. The replica block is byte-checked against the native
 * bundles by `.verify-toolrow/verify-bytes.mjs` ("the tools block contains only
 * native-derived rules"), so plugin-authored rules placed among them would fail that
 * check — and they are not native replicas anyway, so they do not belong there.
 */
const PROPOSAL_STYLE_ID = `${CHROME_STYLE_ID}-proposal`

const PROPOSAL_CSS = `
.ac-proposal-block{display:grid;gap:6px;min-width:0;}
.ac-proposal-field-label{color:var(--dsw-alias-label-secondary);font-size:13px;}
.ac-proposal-reason{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere;}
.ac-proposal-members{display:grid;gap:6px;margin:0;padding:0;max-height:240px;overflow-y:auto;list-style:none;}
.ac-proposal-member{display:grid;grid-template-columns:28px minmax(0,1fr);gap:10px;align-items:start;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);}
.ac-proposal-member-avatar{display:grid;place-items:center;width:28px;height:28px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);font-size:14px;}
.ac-proposal-member-text{display:block;min-width:0;}
.ac-proposal-member-name{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);}
.ac-proposal-leader{flex:none;padding:1px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:16px;}
.ac-proposal-member-desc{display:-webkit-box;margin-top:2px;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:3;}
.ac-proposal-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
.ac-proposal-error{margin:0;padding:8px 10px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere;}
.ac-proposal-timeout{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
.ac-proposal-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.ac-proposal-btn:disabled{cursor:default;opacity:.6;}
.ac-queue-banner{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);font-size:12px;line-height:18px;}
.ac-queue-pill{flex:none;display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:500;}
.ac-queue-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);}
.ac-queue-detail{min-width:0;color:var(--dsw-alias-label-secondary);}
.ac-queue-note{min-width:0;color:var(--dsw-alias-label-tertiary);}
`

if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${PROPOSAL_STYLE_ID}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.pluginCss = PROPOSAL_STYLE_ID
  tag.textContent = PROPOSAL_CSS
  document.head.appendChild(tag)
}

/**
 * GFM table chrome (Markdown.tsx). Its own sheet for the same reason as above: the
 * `CHROME_CSS` block is byte-checked as a native replica and must keep containing
 * native-derived rules only.
 *
 * This IS a native replica after all: the shipped markdown stylesheet lives inside
 * the app bundle (not under `_native-reference/bundles/css`, which is why the first
 * pass wrongly improvised from the surrounding block chrome). Every value below is
 * transcribed from it, with `ac-` class names:
 *
 *   .tableScroll            max-width:100%; overflow-x:auto; overscroll-behavior-x:contain
 *   .tableScroll.md-table-wide
 *                           bar revealed on hover/focus; resting padding-bottom
 *                           var(--dsh-scrollbar-width,5px) so the reserved bar does not
 *                           shift the layout
 *   .tableScroll:focus-visible
 *                           2px ring in --dsw-focus-ring-color
 *   .tableScroll table      border-collapse:collapse; width/max-width:max-content
 *   .tableFill table        width:100%; max-width:none  (tables under four columns)
 *   th                      padding:10px 16px; border-bottom:.5px solid border-l3;
 *                           border-top:none; font:var(--dsw-font-markdown-table-head);
 *                           max-width:min(30vw,320px); min-width:100px
 *   td                      padding:10px 16px; border-bottom:.5px solid border-l2;
 *                           font:var(--dsw-font-markdown-table); same width bounds
 *   first/last cell         padding-left:0 / padding-right:0 — the row rules sit flush
 *                           with the text column instead of being boxed in
 *
 * The look that follows from this is the point: ROW RULES ONLY. Native draws no
 * vertical borders and gives the header no fill — the header is told apart by weight
 * 500 plus the stronger `border-l3` rule — which is why the boxed grid with a tinted
 * header read as "不美观不协调".
 */
const TABLE_STYLE_ID = `${CHROME_STYLE_ID}-table`

/**
 * The `font` shorthands carry native's own token definitions as the fallback, so a
 * DSH build that ships the theme without these tokens still gets the native metrics
 * instead of silently falling back to the surrounding 14px body text.
 */
const TABLE_FONT = 'var(--dsh-content-font-size-secondary,13px)/calc(22px + var(--dsh-content-font-delta-secondary,0px)) var(--dsw-font-family)'

/**
 * Exported so the acceptance harness can assert the RESOLVED sheet. The `font`
 * declarations interpolate {@link TABLE_FONT}, so the shipped string does not exist
 * verbatim in the source or the bundle — reading it back from the module is the only
 * way to test what the browser actually receives.
 */
export const TABLE_CSS = `
.ac-table-scroll{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;}
.ac-table-scroll.md-table-wide{overflow-x:hidden;padding-bottom:var(--dsh-scrollbar-width,5px);}
.ac-table-scroll.md-table-wide:hover,.ac-table-scroll.md-table-wide:focus-visible{overflow-x:scroll;padding-bottom:0;}
.ac-table-scroll:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));}
.ac-table-scroll table{border-collapse:collapse;width:max-content;max-width:max-content;}
.ac-table-fill table{width:100%;max-width:none;}
.ac-table-scroll th{text-align:start;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3);border-top:none;font:var(--dsw-font-markdown-table-head,500 ${TABLE_FONT});max-width:320px;max-width:min(30vw,320px);min-width:100px;}
.ac-table-scroll td{padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);font:var(--dsw-font-markdown-table,400 ${TABLE_FONT});max-width:320px;max-width:min(30vw,320px);min-width:100px;}
.ac-table-scroll th:first-child,.ac-table-scroll td:first-child{padding-left:0;}
.ac-table-scroll td:last-child{padding-right:0;}
.ac-table-scroll table code{font-size:11px;}
`

if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${TABLE_STYLE_ID}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.pluginCss = TABLE_STYLE_ID
  tag.textContent = TABLE_CSS
  document.head.appendChild(tag)
}

/** Generate avatar emoji from a string seed (deterministic). */
const AVATAR_SEEDS = ['🤖', '🧠', '🦊', '🐙', '🐼', '🐸', '🚀', '🌟', '🎯', '🛠️', '🧭', '🔥', '🌈', '🪐', '🦉', '🐳'] as const

export function botEmoji(seed: string): string {
  let h = 5381
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i)
  return AVATAR_SEEDS[Math.abs(h) % AVATAR_SEEDS.length]!
}
