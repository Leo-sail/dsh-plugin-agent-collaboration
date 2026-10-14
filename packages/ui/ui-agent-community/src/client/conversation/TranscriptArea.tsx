/**
 * TranscriptArea — scrolling message list with stick-to-bottom, load-earlier,
 * back-to-bottom button.
 */
import { useRef, useState, useEffect, useCallback } from 'react'
import { useStickToBottom } from '../useStickToBottom.ts'
import { UserMessage, BotTurn } from './MessageRows.tsx'
import { DispatchRow, ErrorRow } from './SimpleRows.tsx'
import type { LedgerEntry } from './types.ts'
import { groupIntoTurns } from './turns.ts'
import type { TurnGroup } from './turns.ts'

interface Props {
  entries: LedgerEntry[]
  onLoadEarlier?: () => void
  loadingEarlier?: boolean
  hasEarlier?: boolean
  /** Room members, so each bot turn renders its own avatar seed. */
  bots?: ReadonlyArray<{ id: string; name: string; avatarSeed?: string | undefined }> | undefined
  /**
   * Fork from a message: receives that message's id. Omitted → no button is
   * rendered anywhere. Callers must pass undefined for group rooms, where
   * forking is not offered.
   */
  onFork?: ((messageId: string) => void) | undefined
  /** Skill names whose `/name` token is painted in the link colour. */
  skillNames?: ReadonlySet<string> | undefined
  /**
   * Run ids the host reports as running/queued.
   *
   * A turn is LIVE whenever its run is active — not merely while text streams.
   * A run that is still calling tools has no `bot-text` entry at all, so keying
   * the deep-diving row off the streaming flag hid the whale for the whole tool
   * phase, which is most of a skill turn.
   */
  liveRunIds?: ReadonlySet<string> | undefined
  /** Duration per run id, from the host's run record. */
  runDurations?: ReadonlyMap<string, number> | undefined
  /**
   * Start time (epoch ms) per run id, from the host's run record.
   *
   * The deep-diving timer needs an origin even when the turn has produced no ledger
   * row yet — the thinking phase is exactly when the user stares at the whale.
   */
  runStarts?: ReadonlyMap<string, number> | undefined
  /** Runs the user interrupted — labelled 已停止 rather than 已完成. */
  stoppedRunIds?: ReadonlySet<string> | undefined
}

export function TranscriptArea({
  entries, onLoadEarlier, loadingEarlier = false, hasEarlier = false, bots, onFork, skillNames, liveRunIds, runDurations, runStarts, stoppedRunIds,
}: Props) {
  const { containerRef, atBottom, scrollToBottom, captureAnchor, restoreAnchor } = useStickToBottom()
  // Pure function of `atBottom`, which is already state: mirroring it through an effect cost an
  // extra render per scroll event and created a second source of truth.
  const showBackToBottom = !atBottom

  // Capture the scroll anchor only when older history is PREPENDED.
  //
  // The old test was "the list grew", which is equally true for appended rows — so after one
  // load-earlier, every arriving ledger row called restoreAnchor() and yanked the viewport, exactly
  // the behaviour the `following` guard below promises never happens. The first row's identity is
  // what distinguishes the two cases.
  const prevLengthRef = useRef(entries.length)
  const firstEntryIdRef = useRef<string | undefined>(entries[0]?.id)
  useEffect(() => {
    const firstId = entries[0]?.id
    const prepended = firstEntryIdRef.current !== firstId
    firstEntryIdRef.current = firstId
    if (prepended && entries.length > prevLengthRef.current) restoreAnchor()
    prevLengthRef.current = entries.length
  }, [entries.length, entries, restoreAnchor])

  // ── live follow ─────────────────────────────────────────────────────────────
  //
  // The stick-to-bottom hook only reacts to the entry COUNT, so streamed text and
  // reasoning grew the container without ever scrolling: the newest output drifted
  // below the fold.
  //
  // Gating this on "some entry is streaming" was also wrong — during the tool phase
  // there is no streaming text at all, and reasoning/tool rows grow the container
  // just as much. The signal is the RUN being live plus the measured content height.
  //
  // `following` is released when the user scrolls up and re-armed when they return
  // to the bottom, so reading back through history is never fought by the auto-scroll.
  const anyLive = (liveRunIds?.size ?? 0) > 0 || entries.some(e => e.streaming === true)
  const following = useRef(true)
  useEffect(() => { following.current = atBottom }, [atBottom])

  // Measure the content, not a guess about which field grew: a MutationObserver sees
  // text nodes, reasoning bodies and tool cards alike.
  const contentRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = containerRef.current
    const content = contentRef.current
    if (el === null || content === null) return
    const pin = (): void => {
      if (!following.current) return
      // Only while a run is live: a settled turn must not yank the view.
      if (!anyLive) return
      el.scrollTop = el.scrollHeight
    }
    const observer = new MutationObserver(pin)
    observer.observe(content, { childList: true, subtree: true, characterData: true })
    // Height changes can also come from layout alone (a font swap, an image decode).
    const ro = new ResizeObserver(pin)
    ro.observe(content)
    pin()
    return () => { observer.disconnect(); ro.disconnect() }
  }, [containerRef, anyLive])

  const handleLoadEarlier = useCallback(() => {
    captureAnchor()
    onLoadEarlier?.()
  }, [captureAnchor, onLoadEarlier])

  const rows = groupIntoTurns(entries)

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        ref={containerRef as React.RefObject<HTMLDivElement>}
        style={{
          flex: 1, minHeight: 0,
          // ── VERTICAL ONLY. ────────────────────────────────────────────────────
          //
          // `overflowX: 'visible'` next to `overflowY: 'auto'` does not compute to
          // `visible` — CSS pairs the two, so the transcript became a horizontal scroll
          // container. Any content that could not fit (a nowrap shimmer summary, a long
          // unbreakable token) then turned into a horizontal scrollbar across the whole
          // conversation while a bot was streaming. Native's transcript never scrolls
          // sideways. Everything that legitimately scrolls horizontally owns its own
          // scroller (`.ac-table-scroll`, the code block), so those keep working and
          // anything else is clipped at the panel edge instead of dragging the layout.
          overflowY: 'auto', overflowX: 'hidden',
          padding: '16px 24px',
          display: 'flex', flexDirection: 'column', gap: 16,
          background: 'var(--dsw-alias-bg-base)',
        }}
      >
        {/* Observed for content growth; the observer drives auto-follow. */}
        {/* Observed for content growth; the observer drives auto-follow.
            A GRID with a `minmax(0, 1fr)` track, not a flex column: a grid track's
            minimum is explicitly 0, so NOTHING a turn renders — a nowrap thinking
            preview, an 8000px shimmer summary, a long unbreakable token — can widen this
            wrapper and with it every row inside it. In a flex column the wrapper's
            cross-size is content-driven, which is what pushed a right-aligned user
            bubble off the visible edge while a bot streamed and put it back once the
            turn settled. */}
        <div ref={contentRef} style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: 16,
          minWidth: 0,
          maxWidth: '100%',
        }}>
        {/* Load earlier */}
        {hasEarlier && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              onClick={handleLoadEarlier}
              disabled={loadingEarlier}
              style={{
                padding: '4px 12px', fontSize: 12,
                borderRadius: 'var(--dsw-radius-sm, 4px)',
                border: '0.5px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-label-secondary)',
                cursor: loadingEarlier ? 'default' : 'pointer',
                opacity: loadingEarlier ? 0.6 : 1,
              }}
            >
              {loadingEarlier ? '载入历史…' : '加载更早'}
            </button>
          </div>
        )}

        {/* Empty state */}
        {entries.length === 0 && !loadingEarlier && (
          <div style={{
            flex: 1, display: 'grid', placeItems: 'center',
            color: 'var(--dsw-alias-label-tertiary)', fontSize: 13,
          }}>
            发消息开始对话
          </div>
        )}

        {/* Message rows */}
        {rows.map((row, idx) => {
          // Key MUST NOT include the array index: when a group finishes, rows are
          // re-merged and re-sorted, the index shifts, and React would unmount and
          // remount every turn — which is the whole-conversation flicker. Anchor the
          // key to the turn's own identity instead.
          const key = 'entries' in row
            ? `turn-${row.runId ?? row.entries[row.entries.length - 1]?.id ?? row.botId}`
            : `entry-${row.id}`
          void idx
          if ('entries' in row) {
            return (
              // `data-turn-id` is the anchor the turn rail jumps to.
              <div key={key} data-turn-id={(row as TurnGroup).runId ?? ''}>
                <BotTurn
                  group={row as TurnGroup}
                  bots={bots}
                  onFork={onFork}
                  {...(row.runId !== undefined && runDurations?.has(row.runId) === true
                    ? { runDurationMs: runDurations.get(row.runId)! } : {})}
                  /* The timer origin, straight off the run record — available before
                     the turn's first ledger row exists. Without it the whale rendered
                     with no duration for the whole thinking phase. */
                  {...(row.runId !== undefined && runStarts?.has(row.runId) === true
                    ? { runStartedAtMs: runStarts.get(row.runId)! } : {})}
                  /* Liveness has two sources because the run list is polled every
                     1.5s while the ledger updates every 25ms: a short run can finish
                     before any snapshot observes it as `running`, which left
                     `liveRunIds` empty for its whole lifetime (no whale, no
                     force-open work section, no duration). The ledger is the
                     authority on what is streaming; the run list is a backstop. */
                  {...(row.runId !== undefined && stoppedRunIds?.has(row.runId) === true
                    ? { stopped: true } : {})}
                  {...((row.runId !== undefined && liveRunIds?.has(row.runId) === true)
                    || (row as TurnGroup).entries.some(e => e.streaming === true)
                    ? { live: true } : {})}
                />
              </div>
            )
          }
          const e = row as LedgerEntry
          if (e.type === 'user') return <UserMessage key={key} entry={e} onFork={onFork} skillNames={skillNames} />
          if (e.type === 'error') return <ErrorRow key={key} entry={e} />
          if (e.type === 'dispatch') return <DispatchRow key={key} entry={e} />
          return null
        })}
        </div>
      </div>

      {/* Back to bottom — sibling of the scroll container, floating above it. */}
      {showBackToBottom && (
        <div
          style={{
            position: 'absolute', bottom: 12, left: '50%',
            transform: 'translateX(-50%)', zIndex: 10,
          }}
        >
          <button
            onClick={scrollToBottom}
            style={{
              padding: '6px 14px', fontSize: 12,
              borderRadius: 'var(--dsw-radius-lg, 12px)',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-button-floating-fill)',
              boxShadow: '0 2px 8px rgba(0,0,0,.12)',
              color: 'var(--dsw-alias-label-primary)',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <ArrowDown /> 回到底部
          </button>
        </div>
      )}
    </div>
  )
}

function ArrowDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6 2v8M2 7l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
