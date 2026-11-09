/**
 * Disclosure state — is a reasoning block or a process section expanded?
 *
 * Split out of MessageRows.tsx: these six helpers are the whole rule set for "the user collapsed this,
 * keep it collapsed" versus "this is streaming, open it". The two hooks add only the latch that stops
 * a block from re-opening when a stream settles.
 *
 * @module
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export function resolveDisclosure(toggled: boolean | undefined, isStreaming: boolean): boolean {
  // Collapsed until the user opens it — the THINKING section only.
  //
  // Native keeps two sections on different rules (`chat`):
  //   · thinking          → closed until the reader expands it
  //   · work steps        → `alwaysOpen` while the turn is live, then user-controlled
  // So this helper is deliberately the "user opens it" rule, and the work section
  // does NOT call it with the live flag (see `useProcessDisclosure`). It used to be
  // `toggled ?? isStreaming` for both, which force-expanded the thinking section for
  // the whole run.
  void isStreaming
  return toggled ?? false
}

/**
 * Collapse state for the WORK section: force-open while the turn is live, exactly
 * like native `alwaysOpen = liveProcess || …`, then honour the user's choice.
 */

export function resolveProcessDisclosure(toggled: boolean | undefined, live: boolean): boolean {
  return live || (toggled ?? false)
}

/** Flip the visible state, promoting the derived value into an explicit choice. */

export function flipDisclosure(toggled: boolean | undefined, isStreaming: boolean): boolean {
  return !resolveDisclosure(toggled, isStreaming)
}

/**
 * Collapse state that tracks the run until the user takes over.
 *
 * Because the value is re-derived from `isStreaming` on every render, the
 * streaming→done transition folds the section automatically — it is not decided
 * by the `useState` initial value at mount time. After a click the user's choice
 * wins: an explicit collapse is not re-opened by the next token, and an explicit
 * expand is not re-collapsed when the turn finishes.
 */
/**
 * Streaming flag that only ever goes true → false, never back.
 *
 * The ledger can briefly re-deliver `streaming: true` (a poll answering from a
 * stale cursor, or a late patch ordering), and because the disclosure state is
 * `toggled ?? isStreaming`, each flicker re-opened the thinking section and the
 * next poll folded it again — the visible "expand then flash and collapse".
 * A turn that has once settled cannot start streaming again, so latch it.
 */

export function useLatchedStreaming(isStreaming: boolean): boolean {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!isStreaming && !settled) setSettled(true)
  }, [isStreaming, settled])
  return isStreaming && !settled
}

export function useStreamingDisclosure(isStreaming: boolean): [boolean, () => void] {
  const [toggled, setToggled] = useState<boolean | undefined>(undefined)
  const toggle = useCallback(() => {
    setToggled(prev => flipDisclosure(prev, isStreaming))
  }, [isStreaming])
  return [resolveDisclosure(toggled, isStreaming), toggle]
}

/** Work-section disclosure: open while live, then whatever the user chose. */

export function useProcessDisclosure(live: boolean): [boolean, () => void] {
  const [toggled, setToggled] = useState<boolean | undefined>(undefined)
  const toggle = useCallback(() => {
    setToggled(prev => !(live || (prev ?? false)))
  }, [live])
  return [resolveProcessDisclosure(toggled, live), toggle]
}
