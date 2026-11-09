/**
 * The plugin entry's unread badge, drawn onto DSH's own sidebar button.
 *
 * WHY DOM DECORATION: the entry is a `sidebar.panellist` row, whose registration accepts only
 * `{ id, order, label }` and whose icon cell receives just `{ size, active }` — the sidebar owns
 * the button and there is no badge prop, no child slot and no decoration API to hang a count on
 * (verified with the Client Slot inspection: `sidebar.panellist` registration = id/order/label).
 *
 * ── THE OBSERVER, AND THE INVARIANT THAT MAKES IT SAFE ──────────────────────────────────────────
 * The first version watched `document.body` with `{ childList: true, subtree: true }` and repainted on
 * every mutation, and `paint` wrote unconditionally (`badge.textContent = text` even when the text
 * already matched). Painting is itself a mutation, so it re-triggered itself: an endless
 * paint → mutation → paint loop that saturated the main thread — measured live, clicking the plugin
 * froze the whole app.
 *
 * The runaway was the unconditional write, not the observer. Now:
 *   · every write is conditional — a pass with nothing to change performs READS ONLY;
 *   · therefore our own mutation triggers at most one extra callback, which finds nothing to do and
 *     stops: the loop terminates by construction, not by luck;
 *   · the observer watches the sidebar row's PARENT (narrow), never the whole document;
 *   · a slow timer re-asserts as a backstop for anything the observer cannot see (the parent itself
 *     being replaced, or the sidebar remounting).
 * A timer-only version was tried in between: it worked, but the badge blinked whenever React replaced
 * the button inside a 2s window — reported as "画面出现闪烁".
 */

const BADGE_CLASS = 'dsh-plugin-community-nav-badge'
/** Backstop period. One querySelector plus two comparisons; writes nothing when nothing changed. */
const REASSERT_MS = 1000
/** How often the sidebar entry refreshes its number while the plugin panel is not in front. */
const REFRESH_MS = 3000

/**
 * Whether the plugin panel is the foreground panel.
 *
 * While it is, the panel's own snapshot poll already publishes the total (and clears the room the
 * user is looking at), so the background refresh stands down rather than calling twice for the same
 * number. When another DSH panel is in front the panel is unmounted and this refresh is the ONLY
 * thing keeping the badge honest.
 */
let panelVisible = false
export function setPanelVisible(next: boolean): void {
  panelVisible = next
}
export function isPanelVisible(): boolean {
  return panelVisible
}

let count = 0
const listeners = new Set<(n: number) => void>()

/** Publish the total unread count; every installed badge repaints. */
export function setNavBadgeCount(next: number): void {
  const clean = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0
  if (clean === count) return
  count = clean
  for (const listener of listeners) listener(count)
}

/** Current total (exported for tests and for the panel's initial paint). */
export function navBadgeCount(): number {
  return count
}

/**
 * Find the sidebar button that hosts this plugin's entry.
 *
 * ANCHORED ON THE ICON, NOT ON THE NAME. The first version matched the button's accessible
 * name against the panel id — which only worked because the entry had no label, so the
 * sidebar fell back to the id. Giving the entry a real name ("Bots团队") broke that match and
 * the unread badge disappeared with it. The icon WE render carries a stable marker, and the
 * button is its closest ancestor; a marker cannot be renamed out from under the badge.
 *
 * The aria-label lookup stays as a fallback for a host that does not mount our icon, and
 * accepts either the id or the localised name.
 */
function findButton(panelId: string): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined
  const byIcon = document.querySelector<HTMLElement>(`[data-community-panel="${panelId}"]`)
  const owner = byIcon?.closest('button')
  if (owner !== undefined && owner !== null) return owner
  const byAttr = document.querySelector<HTMLElement>(`[data-panel="${panelId}"]`)
  if (byAttr !== null) return byAttr
  return Array.from(document.querySelectorAll<HTMLElement>('button[aria-label]'))
    .find(b => {
      const label = b.getAttribute('aria-label')
      return label === panelId || (label !== null && label.includes(PANEL_LABEL_HINT))
    })
}

/** The entry's visible name, used only by the legacy aria-label fallback above. */
const PANEL_LABEL_HINT = 'Bots团队'

/** Text a badge should show, or '' when there is nothing to show. */
function badgeText(): string {
  if (count === 0) return ''
  return count > 99 ? '99+' : String(count)
}

/**
 * Bring one button's badge in line with the current count.
 *
 * Every branch is conditional: when nothing changed this performs reads only, which is what keeps a
 * periodic re-assert harmless.
 */
function paint(button: HTMLElement): void {
  const wanted = badgeText()
  const existing = button.querySelector<HTMLElement>(`:scope > .${BADGE_CLASS}`)
  if (wanted === '') {
    if (existing !== null) existing.remove()
    return
  }
  let badge = existing
  if (badge === null) {
    badge = document.createElement('span')
    badge.className = BADGE_CLASS
    badge.setAttribute('aria-hidden', 'true')
    button.appendChild(badge)
  }
  // The button is a flex/grid row; the badge is absolutely positioned inside its top-right corner, so
  // the button needs to be a positioned ancestor. Written once — an unconditional style write would
  // be another mutation on every pass.
  if (button.style.position !== 'relative' && getComputedStyle(button).position === 'static') {
    button.style.position = 'relative'
  }
  if (badge.textContent !== wanted) badge.textContent = wanted
}

/**
 * Keep a badge on the plugin's sidebar entry.
 *
 * @param panelId - panel id whose sidebar button should carry the badge.
 * @param readTotal - background reader for the unread total; called only while another panel is in
 *   front. Returning undefined (a failed call) leaves the last known number in place.
 * @returns disposer that removes the badge and stops the timers.
 */
export function installNavBadge(
  panelId: string,
  readTotal?: (() => Promise<number | undefined>) | undefined,
): () => void {
  if (typeof document === 'undefined') return () => undefined
  const apply = (): void => {
    const button = findButton(panelId)
    if (button !== undefined) paint(button)
  }
  apply()
  const listener = (): void => {
    apply()
  }
  listeners.add(listener)
  // Narrow observer: the row's parent, so a re-rendered button is noticed immediately and the badge
  // does not blink while the backstop timer waits. Safe because paint() writes only on a difference.
  const anchor = findButton(panelId)?.parentElement ?? null
  const observer = typeof MutationObserver === 'undefined' || anchor === null
    ? undefined
    : new MutationObserver(() => { apply() })
  observer?.observe(anchor as Node, { childList: true, subtree: false })
  const timer = setInterval(apply, REASSERT_MS)
  // The number itself, refreshed while the plugin panel is NOT the foreground panel.
  let inFlight = false
  const refresh = setInterval(() => {
    if (panelVisible || readTotal === undefined || inFlight) return
    inFlight = true
    void readTotal()
      .then(total => { if (typeof total === 'number') setNavBadgeCount(total) })
      .catch(() => undefined)
      .finally(() => { inFlight = false })
  }, REFRESH_MS)
  const dispose = (): void => {
    listeners.delete(listener)
    observer?.disconnect()
    clearInterval(timer)
    clearInterval(refresh)
    const badge = document.querySelector(`.${BADGE_CLASS}`)
    if (badge !== null) badge.remove()
  }
  return dispose
}
