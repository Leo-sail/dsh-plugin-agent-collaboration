/**
 * Style class-name constants for CommunityPage.
 * Using plain string constants instead of CSS Modules to avoid @tsdown/css
 * dependency — DSH client bundle format does not support CSS Modules natively.
 * These class names are injected as a <style> tag at module load time.
 */

const STYLE_ID = 'dsh-plugin-ui-agent-community'

const CSS = `
.dsh-plugin-community-page{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:0;height:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.dsh-plugin-community-sidebar{display:grid;align-content:start;gap:24px;min-width:0;padding:48px 12px 24px;border-right:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);overflow:auto}
.dsh-plugin-community-section{display:grid;gap:10px}
.dsh-plugin-community-section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:0 2px 0 10px}
.dsh-plugin-community-section-title{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:0.03em;text-transform:uppercase}
.dsh-plugin-community-add-button{display:grid;flex:none;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-plugin-community-add-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-plugin-community-tabs{display:flex;padding:4px 12px 0;gap:2px}
.dsh-plugin-community-tab{height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;cursor:pointer;flex:none;position:relative;overflow:visible}
.dsh-plugin-community-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-plugin-community-tab[data-active=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}
.dsh-plugin-community-item-list{display:grid;gap:2px}
.dsh-plugin-community-list-empty{margin:4px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dsh-plugin-community-row-with-action{position:relative;display:flex;min-width:0;align-items:center}
.dsh-plugin-community-bot-row,.dsh-plugin-community-room-row{display:grid;flex:1 1 auto;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px;width:100%;min-width:0;min-height:36px;padding:6px 64px 6px 10px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer}
.dsh-plugin-community-bot-row:hover,.dsh-plugin-community-room-row:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-plugin-community-bot-row[data-active=true],.dsh-plugin-community-room-row[data-active=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:550}
.dsh-plugin-community-bot-row:disabled{cursor:wait;opacity:.55}
.dsh-plugin-community-avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);font-size:15px;font-weight:600;flex:none}
.dsh-plugin-community-row-text{min-width:0}
.dsh-plugin-community-row-name,.dsh-plugin-community-row-meta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-plugin-community-row-name{font-size:14px;line-height:20px}
.dsh-plugin-community-row-meta{margin-top:1px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
.dsh-plugin-community-row-delete-button{position:absolute;right:6px;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0}
.dsh-plugin-community-row-action-button{position:absolute;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0;font-size:13px}
.dsh-plugin-community-row-with-action:hover .dsh-plugin-community-row-delete-button,.dsh-plugin-community-row-with-action:focus-within .dsh-plugin-community-row-delete-button{opacity:1}
.dsh-plugin-community-row-with-action:hover .dsh-plugin-community-row-action-button,.dsh-plugin-community-row-with-action:focus-within .dsh-plugin-community-row-action-button{opacity:1}
.dsh-plugin-community-row-delete-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}
.dsh-plugin-community-row-action-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-plugin-community-row-delete-button:disabled{cursor:not-allowed;opacity:.35}
.dsh-plugin-community-content{--dsh-chat-content-width:728px;--dsh-composer-card-max-width:760px;--dsh-composer-side-clearance:48px;--dsh-composer-text-max-height:336px;display:grid;grid-template-rows:auto minmax(0,1fr) auto;min-width:0;min-height:0;background:var(--dsw-alias-bg-base)}
.dsh-plugin-community-heading h2,.dsh-plugin-community-heading p{margin:0}
.dsh-plugin-community-heading h2{overflow:hidden;font-size:18px;font-weight:600;letter-spacing:-0.01em;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dsh-plugin-community-heading p{margin-top:4px;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-overflow:ellipsis;white-space:nowrap}
.dsh-plugin-community-run-status[data-status=failed],.dsh-plugin-community-run-status[data-status=interrupted],.dsh-plugin-community-empty-state{display:grid;align-content:center;justify-items:center;gap:6px;padding:48px 32px;text-align:center;background:var(--dsw-alias-bg-base)}
.dsh-plugin-community-empty-title{margin:0;color:var(--dsw-alias-label-secondary);font-size:15px;line-height:1.6}
.dsh-plugin-community-empty-hint{margin:0;max-width:420px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6}
.dsh-plugin-community-form-legacy{display:grid;gap:16px;min-width:0;padding-bottom:4px}
.dsh-plugin-community-form-legacy>label:not(.dsh-plugin-community-check){display:grid;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsh-plugin-community-form-legacy select,.dsh-plugin-community-form-legacy textarea,.dsh-plugin-community-form-legacy input[type=text]{box-sizing:border-box;width:100%;max-width:100%;min-height:32px;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
.dsh-plugin-community-form-legacy select:focus,.dsh-plugin-community-form-legacy textarea:focus,.dsh-plugin-community-form-legacy input[type=text]:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
.dsh-plugin-community-form-legacy select:disabled{color:var(--dsw-alias-label-tertiary);cursor:not-allowed}
.dsh-plugin-community-form-legacy textarea{min-height:96px;resize:vertical}
.dsh-plugin-community-form-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dsh-plugin-community-check{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;cursor:pointer}
.dsh-plugin-community-check input[type=checkbox]{flex:none;width:16px;height:16px;margin:3px 0 0;cursor:pointer}
.dsh-plugin-community-avatar-choice:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-plugin-community-error{margin:12px 28px 0;padding:10px 14px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:1.5}
.dsh-plugin-community-members{display:grid;gap:4px;margin:0;padding:10px 12px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md)}
.dsh-plugin-community-members legend{padding:0 4px;color:var(--dsw-alias-label-secondary);font-size:13px}
@media(max-width:760px){.dsh-plugin-community-page{grid-template-columns:1fr}.dsh-plugin-community-sidebar{max-height:220px;padding-top:16px;border-right:0;border-bottom:.5px solid var(--dsw-alias-border-l2)}.dsh-plugin-community-content{--dsh-composer-side-clearance:16px}}
@media(max-width:520px){}
/* ── segmented tab strip ──────────────────────────────────────────────────────
   Byte-for-byte copy of dsh-client-ui-primitives SegmentedTabs.module.css with a plugin
   prefix; the component that drives it is transcribed in conversation/NativeDialog.tsx. */
@media (prefers-reduced-motion:reduce){.dsh-plugin-community-seg-indicator,}
/* ── form fields ──────────────────────────────────────────────────────────────
   Stacked fields, the way DSH's own dialogs lay out a form: a label line, an optional
   hint line, then the full-width control. The previous version used the *settings row*
   layout (label left, 280px control right) — that is what the settings page does for
   toggles, not what a dialog does for a form, and it produced a ragged right edge, hints
   wrapping at 260px and a tall empty band under the last field. */
.dsh-plugin-community-form{display:flex;flex-direction:column;gap:13px;min-width:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-plugin-community-field{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0;padding:0}
.dsh-plugin-community-field-label{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsh-plugin-community-field-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-plugin-community-field .dsh-plugin-community-checkbox{margin-top:2px}
.dsh-plugin-community-row-pair{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%}
.dsh-plugin-community-row-pair .dsh-plugin-community-text-input{width:100%}
/* ── segmented control ────────────────────────────────────────────────────────
   Byte-for-byte copy of dsh-client-ui-primitives SegmentedControl.module.css with a
   plugin prefix (the same reason as the tab strip: it is not in the typed surface).
   The indicator derives its width and offset from the two custom properties. */
.dsh-plugin-community-segctl{box-sizing:border-box;position:relative;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;width:100%;max-width:100%;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-plugin-community-segctl-indicator{position:absolute;top:4px;left:4px;width:calc((100% - 8px - 2px * (var(--dsh-segment-count) - 1)) / var(--dsh-segment-count));height:calc(100% - 8px);border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);transform:translateX(calc(var(--dsh-segment-index) * (100% + 2px)));transition:transform 160ms ease;pointer-events:none}
.dsh-plugin-community-segctl-tab{box-sizing:border-box;position:relative;z-index:1;height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer;transition:color 120ms ease}
.dsh-plugin-community-segctl-tab:hover:not(:disabled),.dsh-plugin-community-segctl-tab[aria-selected='true']{color:var(--dsw-alias-label-primary)}
.dsh-plugin-community-segctl-tab:disabled{cursor:default;opacity:.4}
.dsh-plugin-community-segctl-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
/* Copy of dsh-client-ui-primitives Checkbox.module.css */
.dsh-plugin-community-checkbox{display:inline-flex;align-items:center;gap:6px;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-plugin-community-checkbox input{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}
.dsh-plugin-community-checkbox input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-plugin-community-checkbox:has(input:disabled){cursor:default;opacity:.5}
@media (prefers-reduced-motion:reduce){.dsh-plugin-community-segctl-indicator,.dsh-plugin-community-segctl-tab{transition:none}}
/* ── question in the composer slot ───────────────────────────────────────────
   While a bot waits, the answer surface replaces the input box (native DSH does the same with
   its QuestionComposer). It reuses the composer's own shell, so the swap is visually seamless. */
.dsh-plugin-community-question-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0;padding:0 12px}
.dsh-plugin-community-question-from{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dsh-plugin-community-question-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-plugin-community-question-text{margin:0;padding:0 12px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsh-plugin-community-question-options{display:flex;flex-direction:column;gap:8px;padding:0 12px}
.dsh-plugin-community-question-composer-row{display:flex;align-items:center;gap:8px;padding:0 12px 2px;min-width:0}
.dsh-plugin-community-question-input{display:flex;flex:1 1 auto;min-width:0}
/* Question options: full-width rows so answering is one click on a large target. */
.dsh-plugin-community-question-option{display:block;width:100%;text-align:left;padding:10px 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;overflow-wrap:anywhere}
.dsh-plugin-community-question-option:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-plugin-community-question-option:disabled{cursor:default;opacity:.5}
/* ── dialog chrome ────────────────────────────────────────────────────────────
   Geometry transcribed from the native tabbed dialog (PresetGuideDialog in
   dsh-client-ui-agent-preset, classes ZwjoKq_*): 640x600, no padding of its own, a
   flex:none tab strip, one scrolling panel. The mask, blur, elevation, Escape handling
   and focus trap belong to the primitive Modal, not to these rules. (Backticks are not
   allowed anywhere here: this whole stylesheet is one template literal.) */
.dsh-plugin-community-dialog-mask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dsh-plugin-community-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dsh-plugin-community-dialog-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsh-plugin-community-dialog-close{flex:none;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:1}
.dsh-plugin-community-dialog-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-plugin-community-dialog-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-plugin-community-dialog-body{display:flex;flex-direction:column;min-width:0;margin-top:20px;padding:0 24px}
.dsh-plugin-community-dialog-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.dsh-plugin-community-dialog{width:min(560px,100%);height:auto;max-height:min(744px,100%);padding:0 0 20px}
.dsh-plugin-community-dialog-content{display:flex;flex-direction:column;gap:0;height:100%;min-height:0}
/* The primitive's body div is the only element between .content and our form, and it has
   no selector hook. Modal.module.css gives it neither flex:1 nor min-height:0, while .dialog
   is overflow:hidden — so anything taller than the dialog was simply CLIPPED and could not be
   scrolled (the avatar picker at the bottom of the form was unreachable because of it).
   div:not(:first-child) is exact here: content's children are header, optional description
   paragraph, body — only the body is a div after the first. */
.dsh-plugin-community-dialog-content > div:not(:first-child){display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 24px}
.dsh-plugin-community-dialog-tabs{flex:none;align-self:flex-start;width:auto;margin:0 0 18px;padding:0}
/* ONE scroll container per dialog: the primitive's body (see the rule above). Nested scrollers
   made the panel taller than the space it was given, so the bottom of the form — including the
   avatar picker — sat below the card's clipped edge and could not be reached. */
.dsh-plugin-community-dialog-panel{min-width:0;overflow-wrap:anywhere}
.dsh-plugin-community-dialog-panel:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dsh-plugin-community-dialog-panel[hidden]{display:none}
/* ── unread badges ────────────────────────────────────────────────────────────
   Three surfaces, one meaning: red = something arrived that the user has not looked at.
   · .unread-badge  — sits directly AFTER a room avatar in the sidebar list, a fixed circle so a
                      count of 1 and a count of 99 keep the same footprint and never reflow the row.
   · .tab-dot       — a small dot on the Bots / 群聊 tab, top-right, no number.
   · .nav-badge     — the total, drawn onto the plugin's own sidebar entry (navBadge.ts).
   Red comes from the theme's error alias rather than a hard-coded hex, so it tracks dark mode. */
/* The badge lives inside .avatar-wrap, NOT as a third grid child: the rows are sized
   32px + minmax(0,1fr), so an extra child claims the name column and the room name wraps onto its
   own line (seen in the visual preview). The wrapper keeps the columns untouched. */
/* The first grid column is auto, not a fixed 32px: the wrapper holds avatar + badge, and a fixed
   column pushed the badge over the room name (both failure modes were caught in the visual preview). */
/* position:relative is the badge's origin; the badge overlaps the avatar's top-left corner, so the
   wrapper must NOT reserve space for it — an in-flow badge shifted the avatar and re-laid-out the row
   on every repaint, which is what the flicker looked like. */
.dsh-plugin-community-avatar-wrap{position:relative;display:flex;flex:none;align-items:center;min-width:0}
/* justify-self/align-self are load-bearing: the room rows are GRID containers, so a badge without
   them stretches to the whole column and renders as a long red pill (caught in the visual preview
   after every source assertion had passed). */
.dsh-plugin-community-unread-badge{position:absolute;top:-5px;left:-5px;z-index:1;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:16px;height:16px;padding:0 4px;border:1.5px solid var(--dsw-alias-bg-base);border-radius:8px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:10px;font-weight:600;line-height:1;letter-spacing:0;pointer-events:none}
.dsh-plugin-community-tab-dot{position:absolute;top:2px;right:6px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}
/* Vertically centred on the sidebar row (measured live: the icon and the label both sit at the
   row's centre, so a fixed top offset left the badge 6px high). */
.dsh-plugin-community-nav-badge{position:absolute;top:50%;transform:translateY(-50%);right:8px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:10px;font-weight:600;line-height:1;pointer-events:none}

/* ── form control widths ──────────────────────────────────────────────────────
   ONE rule per control, every one of them width:100% with box-sizing:border-box, so
   each control occupies exactly the same column as 系统提示词 — the box the user measures
   against. This block is the single source of truth for these selectors: earlier revisions
   accumulated DUPLICATE rules for the same selector and the stale one won the cascade, so
   width edits appeared to do nothing at all. Anything added here must stay unique. */
.dsh-plugin-community-textarea{box-sizing:border-box;width:100%;max-width:100%;align-self:stretch;min-height:96px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;resize:none;outline:none}
.dsh-plugin-community-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}
.dsh-plugin-community-textarea:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dsh-plugin-community-text-input{display:flex;box-sizing:border-box;width:100%;min-width:0}
.dsh-plugin-community-row-control{display:flex;width:100%;min-width:0}
.dsh-plugin-community-row-control>.dsh-plugin-community-select{width:100%;box-sizing:border-box}
.dsh-plugin-community-select{box-sizing:border-box;width:100%;height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;cursor:pointer}
.dsh-plugin-community-select:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dsh-plugin-community-avatar-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(40px,1fr));gap:6px;width:100%}
.dsh-plugin-community-avatar-choice{display:grid;place-items:center;box-sizing:border-box;width:100%;aspect-ratio:1;padding:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:18px;cursor:pointer}
.dsh-plugin-community-avatar-choice[data-active=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-plugin-community-pick{flex:none;white-space:nowrap}

`

// Inject styles once per page load
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

export const css = {
  page: 'dsh-plugin-community-page',
  sidebar: 'dsh-plugin-community-sidebar',
  tabs: 'dsh-plugin-community-tabs',
  tab: 'dsh-plugin-community-tab',
  section: 'dsh-plugin-community-section',
  sectionHeading: 'dsh-plugin-community-section-heading',
  sectionTitle: 'dsh-plugin-community-section-title',
  addButton: 'dsh-plugin-community-add-button',
  itemList: 'dsh-plugin-community-item-list',
  listEmpty: 'dsh-plugin-community-list-empty',
  rowWithAction: 'dsh-plugin-community-row-with-action',
  botRow: 'dsh-plugin-community-bot-row',
  roomRow: 'dsh-plugin-community-room-row',
  avatar: 'dsh-plugin-community-avatar',
  rowText: 'dsh-plugin-community-row-text',
  rowName: 'dsh-plugin-community-row-name',
  rowMeta: 'dsh-plugin-community-row-meta',
  rowDeleteButton: 'dsh-plugin-community-row-delete-button',
  rowActionButton: 'dsh-plugin-community-row-action-button',
  content: 'dsh-plugin-community-content',
  emptyState: 'dsh-plugin-community-empty-state',
  emptyTitle: 'dsh-plugin-community-empty-title',
  emptyHint: 'dsh-plugin-community-empty-hint',
  dialog: 'dsh-plugin-community-dialog',
  dialogMask: 'dsh-plugin-community-dialog-mask',
  dialogHeader: 'dsh-plugin-community-dialog-header',
  dialogTitle: 'dsh-plugin-community-dialog-title',
  dialogClose: 'dsh-plugin-community-dialog-close',
  dialogDescription: 'dsh-plugin-community-dialog-description',
  dialogBody: 'dsh-plugin-community-dialog-body',
  dialogFooter: 'dsh-plugin-community-dialog-footer',
  dialogContent: 'dsh-plugin-community-dialog-content',
  dialogTabs: 'dsh-plugin-community-dialog-tabs',
  form: 'dsh-plugin-community-form',
  formLegacy: 'dsh-plugin-community-form-legacy',
  field: 'dsh-plugin-community-field',
  fieldLabel: 'dsh-plugin-community-field-label',
  fieldHint: 'dsh-plugin-community-field-hint',
  rowPair: 'dsh-plugin-community-row-pair',
  textInput: 'dsh-plugin-community-text-input',
  rowControl: 'dsh-plugin-community-row-control',
  textarea: 'dsh-plugin-community-textarea',
  select: 'dsh-plugin-community-select',
  segctl: 'dsh-plugin-community-segctl',
  segctlIndicator: 'dsh-plugin-community-segctl-indicator',
  segctlTab: 'dsh-plugin-community-segctl-tab',
  avatarRow: 'dsh-plugin-community-avatar-row',
  pick: 'dsh-plugin-community-pick',
  checkbox: 'dsh-plugin-community-checkbox',
  questionOption: 'dsh-plugin-community-question-option',
  questionHead: 'dsh-plugin-community-question-head',
  questionFrom: 'dsh-plugin-community-question-from',
  questionHint: 'dsh-plugin-community-question-hint',
  questionText: 'dsh-plugin-community-question-text',
  questionOptions: 'dsh-plugin-community-question-options',
  questionComposerRow: 'dsh-plugin-community-question-composer-row',
  questionInput: 'dsh-plugin-community-question-input',
  dialogPanel: 'dsh-plugin-community-dialog-panel',
  formHint: 'dsh-plugin-community-form-hint',
  check: 'dsh-plugin-community-check',
  avatarChoice: 'dsh-plugin-community-avatar-choice',
  error: 'dsh-plugin-community-error',
  members: 'dsh-plugin-community-members',
  avatarWrap: 'dsh-plugin-community-avatar-wrap',
  unreadBadge: 'dsh-plugin-community-unread-badge',
  tabDot: 'dsh-plugin-community-tab-dot',
  navBadge: 'dsh-plugin-community-nav-badge',
} as const
