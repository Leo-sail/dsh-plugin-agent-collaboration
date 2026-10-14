/**
 * Reasoning — the collapsible "thinking" section of a bot turn.
 *
 * Split out of MessageRows.tsx (which is now the transcript's row renderers): this is the one place
 * that renders a model's reasoning, including the paragraph-collapsing rule for long thoughts and the
 * live-title behaviour while the model is still thinking.
 *
 * @module
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Markdown } from './Markdown.tsx'
import { TextShimmer } from './tool/primitives.tsx'
import { resolveDisclosure, useStreamingDisclosure } from './disclosure.ts'
import { groupIntoTurns } from './turns.ts'
import type { TurnGroup } from './turns.ts'
import { REASONING_DONE, THINK } from './nativeStrings.ts'
import { IconThinkOutlineRegular } from './NativeIcons.tsx'
import { Chevron } from './messageActions.tsx'

export function ReasoningBlock({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [open, toggle] = useStreamingDisclosure(isStreaming)

  // Native `latestCompletedParagraphFirstLine` while streaming, `firstLine` once the
  // block has settled: a paragraph that is still arriving must not be previewed, or
  // the line reflows on every token.
  const summaryText = isStreaming ? latestCompletedParagraphFirstLine(text) : firstLine(text)
  const summary = summaryText.replaceAll('**', '')
  // Preview ONLY while the turn is live. Native gates the settled preview behind a
  // display policy (`settledReasoningPreview`: false for `compact`, true for
  // `standard`/`detailed`), and this panel has no transcript-view plumbing. Keeping the
  // settled row a bare label preserves the existing contract that a folded section
  // leaks no reasoning text, while the RUNNING row — the reported gap — always previews.
  const preview = isStreaming && !open && summary !== ''

  return (
    <div {...(open ? { 'data-expanded': 'true' } : {})} {...(preview ? { 'data-preview': 'true' } : {})}>
      <button
        className="ac-disclosure-row"
        data-expandable="true"
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="ac-disclosure-leading" aria-hidden="true">
          <span className="ac-icon-idle"><IconThinkOutlineRegular size={14} /></span>
          <span className="ac-chevron-hover"><Chevron open={open} /></span>
        </span>
        <span className="ac-disclosure-title">{THINK}</span>
        {preview && (
          <>
            <span className="ac-think-separator" aria-hidden="true" />
            <span
              className="ac-think-summary"
              {...(isStreaming ? { 'data-streaming': 'true' } : {})}
              title={summary}
            >
              <TextShimmer active={isStreaming}>{summary}</TextShimmer>
            </span>
          </>
        )}
      </button>
      {open && <ReasoningBody text={text} />}
    </div>
  )
}

/** First line of a settled reasoning block — native `firstLine`. */
export function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/**
 * First line of the newest COMPLETED paragraph — native
 * `latestCompletedParagraphFirstLine`, used for the live preview so a half-arrived
 * paragraph is never shown.
 */
function latestCompletedParagraphFirstLine(text: string): string {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  for (;;) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null
      ? text.length
      : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

/**
 * The expanded thinking body — native `ReasoningRow.module.css`
 * `.HiSsxa_thinkBody` (padding `4px 0 4px calc(22px + font-delta)`) around
 * **compact markdown** (`MarkdownText variant="compact"` → `Markdown dense`).
 * Exported so the body can be rendered without a disclosure click.
 */
export function ReasoningBody({ text }: { text: string }) {
  return (
    <div className="ac-think-body">
      <Markdown text={text} dense />
    </div>
  )
}



// ── ToolCallCard (removed) ────────────────────────────────────────────────────
// The plugin's own tool card lived here. It is gone: the row is now the native
// replica in `ToolRow.tsx` (five `data-state` values, DisclosureRow geometry,
// TextShimmer sweep, diff stat, and the native expanded cards — diff / read /
// search / web / details / ask / io) fed by `ToolRowFromLedger`.
// `ToolRow.tsx` also owns the icons the row needs.

// Re-export grouper for TranscriptArea
export { groupIntoTurns }
export type { TurnGroup }
// Re-export the standalone rows so `TranscriptArea` keeps its single import site.
export { DispatchRow, ErrorRow } from './SimpleRows.tsx'
