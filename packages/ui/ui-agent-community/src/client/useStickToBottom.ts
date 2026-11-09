/**
 * useStickToBottom — scroll-anchor hook for the ledger view.
 *
 * Design (v5 §6):
 *  - Tracks whether the container is "at the bottom" within a 24px threshold.
 *  - When atBottom, new content triggers an instant (behavior:'auto') scroll to end.
 *  - User scrolling up sets atBottom=false; scrolling back to the bottom sets it true.
 *  - Returns a ref to attach to the scroll container, the atBottom flag, and a
 *    scrollToBottom() imperative handle for the "回到底部" button.
 *
 * Anchor compensation for "load earlier":
 *  - Call captureAnchor() before prepending items, then restoreAnchor() after.
 *  - The hook saves scrollHeight and adjusts scrollTop by the delta so the
 *    topmost visible item stays pixel-perfect.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const AT_BOTTOM_THRESHOLD = 24

export interface StickToBottomHandle {
  containerRef: React.RefObject<HTMLDivElement | null>
  atBottom: boolean
  scrollToBottom(): void
  captureAnchor(): void
  restoreAnchor(): void
}

export function useStickToBottom(): StickToBottomHandle {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const anchorScrollHeight = useRef<number>(0)

  const isAtBottom = useCallback((el: HTMLDivElement): boolean => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }, [])

  const captureAnchor = useCallback(() => {
    anchorScrollHeight.current = containerRef.current?.scrollHeight ?? 0
  }, [])

  const restoreAnchor = useCallback(() => {
    const el = containerRef.current
    if (el === null) return
    const delta = el.scrollHeight - anchorScrollHeight.current
    if (delta > 0) el.scrollTop += delta
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (el === null) return
    const onScroll = () => setAtBottom(isAtBottom(el))
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isAtBottom])

  return { containerRef, atBottom, scrollToBottom, captureAnchor, restoreAnchor }
}
