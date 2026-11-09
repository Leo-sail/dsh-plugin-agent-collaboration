/**
 * Reasoning-effort selection rules for the Bot settings form.
 *
 * WHY THIS IS A MODULE OF ITS OWN: two call sites need the same rule — the create/edit form's
 * `alignEffort()` (provider/model dropdowns) and the catalog-load effect that validates a Bot's
 * STORED level against the levels its model currently publishes. They used to carry two copies
 * of the logic, which is exactly how a form starts saving levels a route rejects. The rule is
 * pure so it can be pinned by a test without a host or a browser.
 *
 * @module
 */

/** One effort level as the model catalog publishes it. */
export interface PublishedEffort {
  readonly id: string
}

/**
 * The effective effort id for `previous` on a model that publishes `published`.
 *
 * - `''` (provider default) is valid on every model and is kept as-is: opening the form or
 *   switching routes must not silently turn "no explicit level" into a concrete one.
 * - A level the model publishes is kept.
 * - Otherwise the model's own default is used when it is published, else its first level; a
 *   model that publishes nothing resolves to `''` because it rejects every explicit level.
 */
export function alignEffortId(
  published: readonly PublishedEffort[],
  defaultEffort: string,
  previous: string,
): string {
  if (previous === '') return ''
  if (published.some(option => option.id === previous)) return previous
  if (defaultEffort !== '' && published.some(option => option.id === defaultEffort)) {
    return defaultEffort
  }
  return published.length > 0 ? published[0]!.id : ''
}
