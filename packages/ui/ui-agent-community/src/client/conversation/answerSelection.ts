/**
 * What a question card submits, given what the user picked and what they typed.
 *
 * Kept out of the component so the rule is testable without a DOM: the card has two inputs —
 * option rows and a free-text field — and "which one wins" is a decision, not a rendering detail.
 *
 * THE RULE: typed text wins over a picked option. A user who typed something did so on purpose,
 * and a picked option is one click that is easy to leave behind (they may have picked first and
 * then decided to answer in their own words). Nothing at all means nothing to submit — the card
 * refuses rather than sending an empty answer, which the host would treat as a real reply.
 */
export function resolveAnswer(input: {
  /** The option row the user picked, if any. */
  readonly picked: string | undefined
  /** What is in the free-text field. */
  readonly text: string
}): string | undefined {
  const typed = input.text.trim()
  if (typed !== '') return typed
  return input.picked
}

/** Whether the submit control can do anything yet. */
export function canSubmit(input: { readonly picked: string | undefined; readonly text: string }): boolean {
  return resolveAnswer(input) !== undefined
}
