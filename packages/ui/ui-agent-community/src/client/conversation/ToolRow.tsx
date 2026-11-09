/**
 * Native **tool-call row** + every expanded card it can mount — a complete,
 * value-for-value replica of the shipped `@deepseek-ai/dsh-client-ui-tool`
 * `ToolRow`, re-driven by this plugin's own ledger.
 *
 * Every fact below was read out of the native bundles, never guessed:
 *   • state machine   `tool/lib/client.js:276-283`   (5 states, not 3)
 *   • summary model   `tool/lib/client.js:193-300`
 *   • row DOM         `tool/lib/client.js:1716-1739`, `primitives/lib/index.js:3156-3205`
 *   • card priority   `tool/lib/client.js:1517` (details / diff / read / search / web)
 *   • CSS values      generated from `ToolRow.module.css` (tool:1434),
 *                     `ToolDetails.module.css` (tool:1260), `AskQuestionCard.module.css`
 *                     (tool:1197) and the primitives stylesheets into `styles.ts`
 *                     from the shipped native bundle — never retyped (the generator script was
 *                     removed with the verification suites on )
 *   • icon paths      generated from the primitives bundle into `NativeIcons.tsx`
 *
 * Facts that are easy to get wrong and are therefore explicit here:
 *   1. **Five** `data-state` values: `preparing | running | ok | error | stopped`.
 *      `ok` renders **no** visually-hidden status span (`M.stateStatus()` → null).
 *   2. The failed state has **no red-cross icon** — the ui-tool icon set contains
 *      none. Failure is carried by the red summary plus `row.failed` for AT.
 *   3. `preparing` is **not expandable**: no `aria-expanded`, no `role`, no tab stop.
 *   4. A tool row has **no `aria-controls`** (only the group header has one) and
 *      **no tooltip**.
 *   5. The diff stat is **colourless at rest**; green/red appear only on row hover
 *      or while the row is expanded (`[aria-expanded=true]`).
 *   6. Titles come from a two-level lookup (`M.TOOL_TITLE_KEYS` → variant key),
 *      never `tool.<name>`; `grep`/`glob`/`web_search`/`web_fetch` hard-code theirs.
 */
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { LedgerEntry } from './types.ts'
import * as M from './tool/toolModel.tsx'
import * as P from './tool/primitives.tsx'
import * as C from './tool/cards.tsx'
import * as model from './tool/toolModel.tsx'
import { Markdown, highlightCode, tokenizeCode } from './Markdown.tsx'
import {
  IconAgentPresetOutlineRegular,
  IconApiOutlineRegular,
  IconBranchOutlineRegular,
  IconBrowseOutlineRegular,
  IconCheckOutlineRegular,
  IconChecklistOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconClockOutlineRegular,
  IconCodeOutlineRegular,
  IconCopyOutlineRegular,
  IconCordisPluginOutlineRegular,
  IconEditOutlineRegular,
  IconGlobeOutlineRegular,
  IconGoalOutlineRegular,
  IconInspectOutlineRegular,
  IconPlayOutlineRegular,
  IconQuestionOutlineRegular,
  IconSearchOutlineRegular,
  IconSparkleRegular,
  IconUsersOutlineRegular,
} from './NativeIcons.tsx'

// ── P.TextShimmer (primitives contract) ────────────────────────────────────────

/**
 * `P.DecorativeCopy` context, `primitives/index.js:3099`.
 *
 * `undefined` = outermost instance (real text plus, when active, one decorative
 * sweep); `false`/`true` = nested instance, where `true` emits the string
 * through `::after { content: attr(data-shimmer-text) }` so the two layers stay
 * glyph-aligned.
 */
interface ToolRowProps {
  readonly state: M.ToolRowState
  readonly variant: M.ToolVariant
  readonly toolName: string
  readonly icon?: ReactNode
  readonly title: string
  readonly summary: string
  /** Caller-supplied suffix; wins over an argument-derived diff stat. */
  readonly summarySuffix?: string | null | undefined
  readonly diffStat?: M.DiffStat | null | undefined
  readonly bodyRaw?: string | null | undefined
  readonly output?: string | null | undefined
  readonly errorSummary?: string | null | undefined
  readonly filePath?: string | null | undefined
  /** Set only when the host can actually open workspace paths. */
  readonly onOpenFile?: ((path: string) => void) | undefined
  /** External URL for the summary (`web_fetch`), when known. */
  readonly href?: string | undefined
  /** Set only when the host can inspect the call; hides the Inspect button otherwise. */
  readonly inspect?: (() => void) | undefined
}

interface ToolRowViewProps extends ToolRowProps {
  readonly expanded: boolean
  readonly onToggle: () => void
}

/**
 * Controlled row — the disclosure state lives in the caller, exactly like the
 * native `useDisclosure()` hook the ToolCallTree hands down.
 */
function ToolRowView({
  state, variant, toolName, icon, title, summary, summarySuffix, diffStat,
  bodyRaw, output, errorSummary, filePath, onOpenFile, href, inspect,
  expanded, onToggle,
}: ToolRowViewProps) {
  const inputRaw = bodyRaw ?? null
  const outputText = output ?? null
  // ── CARD MODELS ARE BUILT ONLY WHEN THE ROW IS OPEN ────────────────────────────────────────────
  // They used to be built unconditionally, before the `open` check: a collapsed row (the default for
  // every row) still ran `JSON.parse` over each tool's arguments, a per-line regex over the whole
  // search output, and another JSON.parse for the web card. With ~50 rows and a ledger tick, that was
  // thousands of parses per second for cards nobody had opened.
  // A row is expandable when it has anything to show. Computed from the payloads, NOT from the card
  // models: building those is the expensive part and now happens only when the row is open.
  const expandable = state !== 'preparing' && (inputRaw !== null || outputText !== null)
  const open = expanded && expandable
  // Native card priority (`tool:1517`): askQuestion → terminal → diff → read →
  // image → search → web → details. This ledger carries no terminal/image card.
  let cardClass: 'ask' | 'diff' | 'read' | 'search' | 'web' | 'details' | null = null
  const card: ReactNode | null = !open
    ? null
    : (() => {
        const ask = M.askCardModel(toolName, inputRaw, outputText)
        if (ask !== null) { cardClass = 'ask'; return <C.AskCard model={ask} /> }
        const diff = M.diffCardModel(toolName, inputRaw)
        if (diff !== null) { cardClass = 'diff'; return <C.DiffCard model={diff} /> }
        const read = M.readCardModel(toolName, inputRaw, outputText)
        if (read !== null) { cardClass = 'read'; return <C.ReadCard model={read} /> }
        const search = M.searchCardModel(toolName, inputRaw, outputText)
        if (search !== null) { cardClass = 'search'; return <C.SearchCard model={search} /> }
        const web = M.webCardModel(toolName, inputRaw, outputText)
        if (web !== null) { cardClass = 'web'; return <C.WebCard model={web} /> }
        const details = M.detailsCardModel(toolName, state, inputRaw, outputText)
        if (details !== null) { cardClass = 'details'; return <C.DetailsCard model={details} hasInspect={inspect !== undefined} /> }
        return null
      })()
  const status = M.stateStatus(state)
  // `running` counts `preparing` as well — that is what drives the sweep.
  const running = state === 'running' || state === 'preparing'
  const normalSummary = summary
  const summaryText = (state === 'error' ? errorSummary ?? normalSummary : null) ?? normalSummary
  // The shimmer renders its text TWICE (content copy + sweep copy) inside
  // `white-space:nowrap`, so an unbounded summary becomes an inline box thousands of
  // pixels wide. A `post_message` summary carries the whole message body: measured in
  // headless Chrome it produced an 8761px span. It is clipped by `.ac-tool-summary`,
  // but that min-content still travels through the panel's flex chain and can widen the
  // transcript — the reported horizontal scrollbar while a bot streams. The row
  // ellipsizes anyway, so a bounded slice renders identically.
  const SUMMARY_RENDER_MAX = 160
  const summaryRender = summaryText.length > SUMMARY_RENDER_MAX
    ? `${summaryText.slice(0, SUMMARY_RENDER_MAX)}…`
    : summaryText
  const settledWithCue = state === 'error' || state === 'stopped'
  const suffix: string | M.DiffStat | null = settledWithCue ? null : (summarySuffix ?? diffStat ?? null)
  const bodyText = open && card === null && inputRaw !== null ? M.formatToolBody(variant, inputRaw) : null
  const cardBody = variant === 'code' ? null : bodyText
  const rowExpands = expandable

  const toggleFromKeyboard = useCallback((event: { key: string; preventDefault: () => void }): void => {
    P.handleDisclosureKeyDown(event, rowExpands, onToggle)
  }, [rowExpands, onToggle])

  // Native: a settled error/stopped row disables the file link and the href.
  const linkHref = settledWithCue ? undefined : href
  const openFile = filePath !== null && filePath !== undefined && onOpenFile !== undefined && !settledWithCue
    ? (event: { stopPropagation: () => void }) => {
        event.stopPropagation()
        onOpenFile(filePath)
      }
    : undefined
  const summaryLinkKeyDown = useCallback((event: { key: string; stopPropagation: () => void }): void => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }, [])

  const collapsedLeading = expandable ? (
    <>
      <span className="ac-dr-icon-idle">{icon}</span>
      <IconChevronDownOutlineRegular className="ac-dr-chevron-hover" />
    </>
  ) : icon
  const leading = open ? <IconChevronUpOutlineRegular /> : collapsedLeading

  const collapsedContent = useMemo(() => (summaryText !== '' ? (
    <>
      <span className="ac-tool-sep" data-shimmer-decoration="true" aria-hidden="true" />
      {openFile !== undefined ? (
        <button type="button" className="ac-tool-file-link" onClick={openFile} onKeyDown={summaryLinkKeyDown}>
          <P.TextShimmer>{summaryRender}</P.TextShimmer>
        </button>
      ) : linkHref !== undefined ? (
        <a
          className="ac-tool-file-link"
          href={linkHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={event => { event.stopPropagation() }}
          onKeyDown={summaryLinkKeyDown}
        >
          <P.TextShimmer>{summaryRender}</P.TextShimmer>
        </a>
      ) : (
        <span className={P.cx(
          'ac-tool-summary',
          state === 'error' && 'ac-tool-error-summary',
          state === 'stopped' && 'ac-tool-stopped-summary',
        )}>
          <P.TextShimmer>{summaryRender}</P.TextShimmer>
        </span>
      )}
      {suffix !== null && (
        <P.TextShimmer className={P.cx('ac-tool-summary-suffix', typeof suffix !== 'string' && 'ac-tool-diff-stat')}>
          {typeof suffix === 'string' ? suffix : (
            <>
              <span className="ac-tool-diff-added">{`+${suffix.added}`}</span>
              {' '}
              <span className="ac-tool-diff-removed">{`-${suffix.removed}`}</span>
            </>
          )}
        </P.TextShimmer>
      )}
    </>
  ) : null), [linkHref, openFile, state, suffix, summaryLinkKeyDown, summaryText])

  const expandedContent = open ? (
    /* The wrap class only needs to know whether this row IS a details card, which the built card
       already records — no need to keep a second model around for the whole render. */
    <div className={P.cx('ac-tool-body-wrap', card !== null && cardClass === 'details' && 'ac-tool-details-body-wrap')}>
      {card ?? (
        <>
          {variant === 'code' && bodyText !== null && (
            /* Native renders `CodeBlock(lang="typescript")` here (`tool:1645-1654`). */
            <div className="ac-tool-body-scroll">
              <div className="ac-card-card ac-tool-code-body">
                <C.CodeToolbar lang="typescript" title={null} status={null} text={bodyText} />
                <div className="ac-card-body">
                  <pre
                    className="shiki css-variables"
                    tabIndex={0}
                    style={{ backgroundColor: 'var(--shiki-background)', color: 'var(--shiki-foreground)' }}
                  >
                    <code>{highlightCode(bodyText, 'typescript')}</code>
                  </pre>
                </div>
              </div>
            </div>
          )}
          {(cardBody !== null || outputText !== null) && (
            <C.IoCard input={cardBody} output={outputText} error={state === 'error'} />
          )}
        </>
      )}
      {inspect !== undefined && (
        <button type="button" className="ac-tool-inspect-button" onClick={inspect}>
          <IconInspectOutlineRegular />
          {M.ROW_INSPECT}
        </button>
      )}
    </div>
  ) : null

  return (
    <div className="ac-tool-root" data-variant={variant} data-tool={toolName} data-state={state}>
      {status !== null && <span className="ac-tool-visually-hidden">{status}</span>}
      <div className="ac-dr-root" data-open={open || undefined}>
        <div
          className="ac-dr-row ac-tool-row"
          data-disclosure-row="true"
          data-expandable={rowExpands || undefined}
          role={rowExpands ? 'button' : undefined}
          tabIndex={rowExpands ? 0 : undefined}
          aria-expanded={rowExpands ? open : undefined}
          onClick={rowExpands ? onToggle : undefined}
          onKeyDown={rowExpands ? toggleFromKeyboard : undefined}
        >
          {expandable && !rowExpands ? (
            /* Only reachable with `expandOnRowClick={false}` (primitives:3184-3190). */
            <button
              type="button"
              className="ac-dr-leading ac-tool-leading"
              aria-label={title}
              aria-expanded={open}
              onClick={event => { event.stopPropagation(); onToggle() }}
            >
              {leading}
            </button>
          ) : (
            <span className="ac-dr-leading ac-tool-leading">{leading}</span>
          )}
          <P.TextShimmer active={running}>
            <P.TextShimmer className="ac-dr-title ac-tool-title">{title}</P.TextShimmer>
            {collapsedContent}
          </P.TextShimmer>
        </div>
        {expandedContent}
      </div>
    </div>
  )
}

/**
 * One tool row, with the native disclosure semantics: closed on first paint,
 * then purely user-driven (native hands each call an independent
 * `useDisclosure`; nothing auto-expands a failed row).
 */
export function ToolRow(props: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const onToggle = useCallback(() => { setExpanded(prev => !prev) }, [])
  return <ToolRowView {...props} expanded={expanded} onToggle={onToggle} />
}

/**
 * Ledger → presentational props. Shared by {@link ToolRowFromLedger} and the
 * acceptance harness / preview, so both drive the row through the same mapping.
 */
function toolRowProps(
  callEntry: LedgerEntry,
  resultEntry?: LedgerEntry | undefined,
  options: { readonly cwd?: string | undefined; readonly home?: string | undefined } = {},
): ToolRowProps {
  const model = M.toolRowModel(callEntry, resultEntry, options)
  return {
    state: model.state,
    variant: model.variant,
    toolName: model.toolName,
    icon: M.toolIcon(model.toolName, model.variant),
    title: model.title,
    summary: model.summary,
    diffStat: model.diffStat,
    bodyRaw: model.bodyRaw,
    output: model.output,
    errorSummary: model.errorSummary,
    filePath: model.filePath,
  }
}

/** Ledger-driven row: a `tool-call` entry plus its optional `tool-result`. */
export function ToolRowFromLedger({ callEntry, resultEntry }: {
  callEntry: LedgerEntry
  resultEntry?: LedgerEntry | undefined
}) {
  return <ToolRow {...toolRowProps(callEntry, resultEntry)} />
}
