/**
 * Tool-row cards — one renderer per card kind (diff, read, search, web, details, ask, io) plus the
 * code chrome they share.
 *
 * Split out of ToolRow.tsx, which is now the dispatcher that picks one of these. Everything visual
 * about a tool row lives here; everything non-visual lives in toolModel.tsx.
 *
 * @module
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import * as M from './toolModel.tsx'
import { copyToClipboard, cx, TextContent, TextShimmer, useCopy, INERT, handleDisclosureKeyDown } from './primitives.tsx'
import { IconCheckOutlineRegular, IconChevronRightOutlineRegular, IconCopyOutlineRegular, IconGlobeOutlineRegular, IconPlayOutlineRegular } from '../NativeIcons.tsx'
import { Markdown, highlightCode, tokenizeCode } from '../Markdown.tsx'

export function CodeText({ code, lang }: { code: string; lang: string }) {
  if (code === '') return null
  const tokens = tokenizeCode(code, lang)
  if (tokens.length === 0) return code
  return tokens.map((token, index) => (
    token.kind === 'plain'
      ? token.text
      : <span key={index} className={`ac-hl ac-hl-${token.kind}`}>{token.text}</span>
  ))
}

// ── card chrome ───────────────────────────────────────────────────────────────

/**
 * `CodeToolbar`, `primitives/index.js` — the shared card header.
 *
 * The native row passes `onWrap` only when a wrapped view exists; this replica
 * has none (the wrap glyphs are not part of the ui-tool icon set), so the header
 * renders the language/title, the status text and the copy action.
 */

export function CodeToolbar({ lang, title, status, text }: {
  lang: string | null
  title: string | null
  status: string | null
  text: string
}) {
  const [copied, copy] = useCopy(text)
  const clipboardLabel = copied ? M.LABEL_COPIED : M.LABEL_COPY
  return (
    <div className="ac-card-header" data-code-block-banner="true">
      <div className="ac-card-heading">
        <span className="ac-card-language">{lang ?? M.LABEL_CODE_BLOCK}</span>
        {title !== null && title !== '' && <span className="ac-card-title" title={title}>{title}</span>}
      </div>
      <div className="ac-card-actions">
        {status !== null && <span className="ac-card-status">{status}</span>}
        <button type="button" className="ac-card-action" aria-label={clipboardLabel} title={clipboardLabel} onClick={copy}>
          {copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
        </button>
      </div>
    </div>
  )
}

/** `FoldToggle`, `primitives/index.js` — the "… N more lines" control. */

export function FoldToggle({ className, expanded, hidden, collapse, expand, collapseAria, expandAria, onToggle }: {
  className: string
  expanded: boolean
  hidden: number
  collapse: string
  expand: (n: number) => string
  collapseAria: string
  expandAria: (n: number) => string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className={className}
      aria-expanded={expanded}
      aria-label={expanded ? collapseAria : expandAria(hidden)}
      onClick={onToggle}
    >
      {expanded ? collapse : expand(hidden)}
    </button>
  )
}

// ── DiffCard ──────────────────────────────────────────────────────────────────

export const DIFF_ROW_CLASS: Readonly<Record<M.DiffRow['kind'], string>> = {
  path: 'ac-diff-path',
  gap: 'ac-diff-gap',
  del: 'ac-diff-del',
  add: 'ac-diff-add',
  context: 'ac-diff-context',
}

/** `DiffBlock` (`primitives/index.js:9801-9864`) with `maxLines = 9`. */

export function DiffCard({ model }: { model: M.DiffCardModel }) {
  const [expanded, setExpanded] = useState(false)
  const rows = model.rows
  if (rows.length === 0) return null
  const hidden = rows.length - M.DIFF_MAX_LINES
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(M.DIFF_MAX_LINES / 2)
  const tailLines = M.DIFF_MAX_LINES - headLines
  const head = capped ? rows.slice(0, headLines) : rows
  const tail = capped ? rows.slice(rows.length - tailLines) : []
  const copyText = rows
    .map(r => (r.kind === 'del' ? `- ${r.text}` : r.kind === 'add' ? `+ ${r.text}` : r.kind === 'context' ? `  ${r.text}` : r.text))
    .join('\n')
  const lang = M.languageForPath(model.path) ?? ''
  const renderRow = (row: M.DiffRow, key: string): ReactNode => (
    <div key={key} className={cx('ac-diff-line', DIFF_ROW_CLASS[row.kind])}>
      {row.kind === 'path' || row.kind === 'gap' || lang === '' ? row.text : <CodeText code={row.text} lang={lang} />}
    </div>
  )
  return (
    <div className="ac-card-card ac-diff-block ac-tool-diff-body" data-diff="" data-code-wrap={false}>
      <CodeToolbar lang={M.languageForPath(model.path) ?? 'diff'} title={model.path} status={null} text={copyText} />
      <div className="ac-diff-body">
        {head.map((row, index) => renderRow(row, `h${index}`))}
        {hidden > 0 && (
          <FoldToggle
            className="ac-diff-expand"
            expanded={expanded}
            hidden={hidden}
            collapse={M.DIFF_LABELS.collapse}
            expand={M.DIFF_LABELS.expand}
            collapseAria={M.DIFF_LABELS.collapseAria}
            expandAria={M.DIFF_LABELS.expandAria}
            onToggle={() => { setExpanded(value => !value) }}
          />
        )}
        {tail.map((row, index) => renderRow(row, `t${index}`))}
      </div>
    </div>
  )
}

// ── ReadCard ──────────────────────────────────────────────────────────────────

/** `ReadBlock` (`primitives/index.js:9601-9680`) with `maxLines = 8`. */

export function ReadCard({ model }: { model: M.ReadCardModel }) {
  const [expanded, setExpanded] = useState(false)
  const lines = model.lines
  if (lines.length === 0) return null
  const hidden = lines.length - M.READ_MAX_LINES
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(M.READ_MAX_LINES / 2)
  const tailLines = M.READ_MAX_LINES - headLines
  const head = capped ? lines.slice(0, headLines) : lines
  const tail = capped ? lines.slice(lines.length - tailLines) : []
  const digits = lines.reduce((max, line) => Math.max(max, String(line.number).length), 3)
  const status = model.windowed ? M.READ_LABELS.window(lines.length, model.totalLines) : null
  const readLang = M.languageForPath(model.path) ?? ''
  const renderRow = (line: M.ReadLine, key: string): ReactNode => (
    <div key={key} className="ac-read-line">
      <span className="ac-read-gutter" aria-hidden="true">{line.number}</span>
      <span className="ac-read-content">
        {readLang === '' ? line.text : <CodeText code={line.text} lang={readLang} />}
      </span>
    </div>
  )
  return (
    <div
      className="ac-card-card ac-read-block ac-tool-read-body"
      data-read=""
      data-code-wrap={false}
      style={{ '--dsl-read-gutter': `${digits}ch` } as CSSProperties}
    >
      <CodeToolbar lang={M.languageForPath(model.path)} title={model.path} status={status} text={lines.map(l => l.text).join('\n')} />
      <div className="ac-card-body">
        {head.map((line, index) => renderRow(line, `h${index}`))}
        {hidden > 0 && (
          <FoldToggle
            className="ac-read-expand"
            expanded={expanded}
            hidden={hidden}
            collapse={M.READ_LABELS.collapse}
            expand={M.READ_LABELS.expand}
            collapseAria={M.READ_LABELS.collapseAria}
            expandAria={M.READ_LABELS.expandAria}
            onToggle={() => { setExpanded(value => !value) }}
          />
        )}
        {tail.map((line, index) => renderRow(line, `t${index}`))}
      </div>
    </div>
  )
}

// ── SearchCard ────────────────────────────────────────────────────────────────

export type SearchRow =
  | { readonly type: 'path'; readonly text: string }
  | { readonly type: 'file'; readonly index: number; readonly path: string; readonly count: string; readonly collapsed: boolean }
  | { readonly type: 'match'; readonly fileIndex: number; readonly lineNumber: number; readonly line: string }

/** `SearchBlock` (`primitives/index.js:9961-10040`) with `maxLines = 8`. */

export function SearchCard({ model }: { model: M.SearchCardModel }) {
  const [expanded, setExpanded] = useState(false)
  const [collapsed, setCollapsed] = useState<readonly number[]>([])
  const rows: SearchRow[] = []
  const isCollapsed = (index: number): boolean => collapsed.includes(index)
  if (model.kind === 'glob') {
    for (const path of model.paths) rows.push({ type: 'path', text: path })
  } else if (model.parsed) {
    model.files.forEach((file, index) => {
      rows.push({ type: 'file', index, path: file.path, count: String(file.matches.length), collapsed: isCollapsed(index) })
      if (!isCollapsed(index)) {
        for (const match of file.matches) {
          rows.push({ type: 'match', fileIndex: index, lineNumber: match.lineNumber, line: match.line })
        }
      }
    })
  } else {
    for (const line of model.rawLines) rows.push({ type: 'path', text: line })
  }
  const empty = rows.length === 0
  const hidden = rows.length - M.SEARCH_MAX_LINES
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(M.SEARCH_MAX_LINES / 2)
  const tailLines = M.SEARCH_MAX_LINES - headLines
  const head = capped ? rows.slice(0, headLines) : rows
  const naturalTail = capped ? rows.slice(rows.length - tailLines) : []
  // `primitives:9983-9985` — a tail that starts mid-file re-prints that file's header.
  const tailLead = naturalTail[0]
  const tailHeader: SearchRow | undefined = tailLead !== undefined && tailLead.type === 'match'
    && !head.some(r => r.type === 'file' && r.index === tailLead.fileIndex)
    ? rows.find(r => r.type === 'file' && r.index === tailLead.fileIndex)
    : undefined
  const tail = tailHeader === undefined ? naturalTail : naturalTail.slice(1)
  const shown = model.kind === 'glob' ? model.paths.length : model.matchCount
  const summary = model.kind === 'glob' ? `${shown} 个路径` : `${shown} 处匹配 · ${model.fileCount} 个文件`
  const copyText = rows
    .map(row => (row.type === 'file' ? row.path : row.type === 'match' ? `${row.lineNumber}: ${row.line}` : row.text))
    .join('\n')

  const renderRow = (row: SearchRow, key: string): ReactNode => {
    if (row.type === 'path') return <div key={key} className="ac-search-line">{row.text}</div>
    if (row.type === 'match') {
      return (
        <div key={key} className="ac-search-line">
          <span className="ac-search-line-number">{`${row.lineNumber}: `}</span>
          {row.line}
        </div>
      )
    }
    return (
      <button
        key={key}
        type="button"
        className="ac-search-file-header"
        aria-expanded={!row.collapsed}
        onClick={() => {
          setCollapsed(prev => (prev.includes(row.index) ? prev.filter(i => i !== row.index) : [...prev, row.index]))
        }}
      >
        <span className="ac-search-file-path">{row.path}</span>
        <span className="ac-search-file-count">{row.count}</span>
      </button>
    )
  }

  return (
    <div className="ac-search-block ac-tool-search-body" data-search={model.kind}>
      <div className="ac-search-header">
        <span className="ac-search-summary">{summary}</span>
        {!empty && (
          <button type="button" className="ac-search-copy-button" onClick={() => { void copyToClipboard(copyText) }}>
            {M.LABEL_COPY}
          </button>
        )}
      </div>
      {empty ? (
        <div className="ac-search-empty">{M.SEARCH_LABELS.noResults}</div>
      ) : (
        <div className="ac-search-body">
          {head.map((row, index) => renderRow(row, `h${index}`))}
          {hidden > 0 && (
            <FoldToggle
              className="ac-search-expand"
              expanded={expanded}
              hidden={hidden}
              collapse={M.SEARCH_LABELS.collapse}
              expand={M.SEARCH_LABELS.expand}
              collapseAria={M.SEARCH_LABELS.collapseAria}
              expandAria={M.SEARCH_LABELS.expandAria}
              onToggle={() => { setExpanded(value => !value) }}
            />
          )}
          {tailHeader !== undefined && renderRow(tailHeader, 'th')}
          {tail.map((row, index) => renderRow(row, `t${index}`))}
        </div>
      )}
    </div>
  )
}

// ── WebCard ───────────────────────────────────────────────────────────────────

/** `WebBlock` (`primitives` WebBlock.module.css) for `web_search` / `web_fetch`. */

export function WebCard({ model }: { model: M.WebCardModel }) {
  if (model.kind === 'fetch') {
    return (
      <div className="ac-web-block ac-tool-web-body">
        <div className="ac-web-fetch">
          {model.url !== null && (
            <a className="ac-web-fetch-url" href={model.url} target="_blank" rel="noopener noreferrer">{model.url}</a>
          )}
          <div className="ac-web-fetch-meta">
            {model.status !== null && <span className="ac-web-status">{model.status}</span>}
            {model.truncated && <span className="ac-web-truncated">{M.WEB_CONTENT_TRUNCATED}</span>}
          </div>
        </div>
        {model.content !== null && <div className="ac-web-answer"><Markdown text={model.content} /></div>}
        {model.content === null && model.url === null && <div className="ac-web-empty">{M.WEB_NO_RESULTS}</div>}
      </div>
    )
  }
  const empty = model.answer === null && model.sources.length === 0
  return (
    <div className="ac-web-block ac-tool-web-body">
      {model.answer !== null && <div className="ac-web-answer"><Markdown text={model.answer} /></div>}
      {model.sources.length > 0 && (
        <ol className="ac-web-sources">
          {model.sources.map((source, index) => (
            <li key={`${source.url}-${index}`} className="ac-web-source">
              <a className="ac-web-source-link" href={source.url} target="_blank" rel="noopener noreferrer">
                {/* Native uses the site favicon when it can resolve one and falls
                    back to the globe artwork — this is the dependency-free branch. */}
                <IconGlobeOutlineRegular size={14} className="ac-web-link-icon" />
                {source.title}
              </a>
              {source.snippet !== null && <div className="ac-web-snippet">{source.snippet}</div>}
              {source.published !== null && <div className="ac-web-published">{source.published}</div>}
            </li>
          ))}
        </ol>
      )}
      {empty && <div className="ac-web-empty">{M.WEB_NO_RESULTS}</div>}
      {model.truncated && <div className="ac-web-truncated">{M.WEB_SOURCES_TRUNCATED}</div>}
    </div>
  )
}

// ── DetailsCard ───────────────────────────────────────────────────────────────

/** `DetailItem.status` → the mark `tool:1305-1309` paints. */

export function DetailStatusMark({ status }: { status: M.DetailsItem['status'] }) {
  if (status === 'completed') return <IconCheckOutlineRegular size={14} />
  if (status === 'in_progress') return <IconPlayOutlineRegular size={14} />
  return <span className="ac-details-pending" />
}

/** One native `DetailItem` row (`tool:1296-1340`). */

export function DetailItemRow({ item }: { item: M.DetailsItem }) {
  return (
    <li className="ac-details-item">
      <div className="ac-details-heading">
        <span className="ac-details-status" role="img" aria-label={stateLabel(item.status)}>
          <DetailStatusMark status={item.status} />
        </span>
        <span className="ac-details-text">{item.title}</span>
        {item.badge !== null && <span className="ac-details-badge" data-tone={item.badge.tone}>{item.badge.label}</span>}
      </div>
      {item.subtitle !== null && <div className="ac-details-subtitle">{item.subtitle}</div>}
      {item.fields.length > 0 && (
        <dl className="ac-details-fields">
          {item.fields.map((field, index) => (
            <div key={index} className="ac-details-field">
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {item.description !== null && <div className="ac-details-description">{item.description}</div>}
    </li>
  )
}

/**
 * `ToolDetails` (`tool:1294-1345`) + `ToolDetails.module.css`: a caption, the
 * flat item list, then one `<details>` fold per status group. The fold summary
 * carries the native right-chevron, which the stylesheet rotates 90° when open
 * (`.ac-details-group[open]>summary svg`).
 */

export function DetailsCard({ model, hasInspect }: { model: M.DetailsCardModel; hasInspect: boolean }) {
  return (
    <div
      className="ac-details-root"
      data-inspect={hasInspect || undefined}
      data-caption={model.caption !== null || undefined}
    >
      {model.caption !== null && <div className="ac-details-caption">{model.caption}</div>}
      {model.items.length > 0 && (
        <ul className="ac-details-list">
          {model.items.map((item) => <DetailItemRow key={item.title} item={item} />)}
        </ul>
      )}
      {model.groups.map((group, index) => (
        <details key={group.label} className="ac-details-group" open={index === 0}>
          <summary>
            <IconChevronRightOutlineRegular size={14} />
            <span>{group.label}</span>
            <span className="ac-details-status-text">{group.count}</span>
          </summary>
          <ul className="ac-details-list">
            {group.items.map((item, itemIndex) => <DetailItemRow key={itemIndex} item={item} />)}
          </ul>
        </details>
      ))}
      {model.statusText !== null && model.items.length > 0 && (
        <div className="ac-details-status-text">{model.statusText}</div>
      )}
    </div>
  )
}

/** Accessible name of a details status mark (`tool:1308`). */

export function stateLabel(status: M.DetailsItem['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'in_progress') return '进行中'
  return '待处理'
}

// ── AskCard ───────────────────────────────────────────────────────────────────

/** `AskQuestionCard` (`tool:1197` css) — questions and their recorded answers. */

export function AskCard({ model }: { model: M.AskCardModel }) {
  return (
    <div className="ac-ask-card">
      {model.items.map((item, index) => (
        <div key={index} className="ac-ask-item">
          <p className="ac-ask-question">{item.question}</p>
          {item.answer !== null
            ? <p className="ac-ask-answer">{item.answer}</p>
            : <p className="ac-ask-skipped">{M.ASK_NOT_ANSWERED}</p>}
        </div>
      ))}
    </div>
  )
}

// ── IoCard ────────────────────────────────────────────────────────────────────

/** The native fallback body: `row.input` / `row.output` in one bordered card. */

export function IoCard({ input, output, error }: { input: string | null; output: string | null; error: boolean }) {
  return (
    <div className="ac-tool-io-card">
      {input !== null && (
        <div className="ac-tool-io-section">
          <span className="ac-tool-io-label">{M.ROW_INPUT}</span>
          {/* Native `ioText` paints BOTH sections as plain `--dsw-alias-label-secondary`
              text (`.ioText{color:var(--dsw-alias-label-secondary)}` in the ui-tool
              CSS) — it highlights neither. NOTE `lang="text"`, not `lang=""`: an empty
              language means AUTO-DETECT (`resolveRules` → `detectLang`), so `lang=""`
              would still colour JSON. An explicitly unknown language is what makes the
              tokenizer return a single plain run. */}
          <span className="ac-tool-io-text"><CodeText code={input} lang="text" /></span>
        </div>
      )}
      {input !== null && output !== null && <span className="ac-tool-io-divider" aria-hidden="true" />}
      {output !== null && (
        <div className="ac-tool-io-section">
          <span className="ac-tool-io-label">{M.ROW_OUTPUT}</span>
          <span className="ac-tool-io-text" data-error={error || undefined}>
            {/* Free text: "text" is not a known grammar, so this stays plain. */}
            <CodeText code={output} lang="text" />
          </span>
        </div>
      )}
    </div>
  )
}

// ── ToolRow ───────────────────────────────────────────────────────────────────

/** Everything the native `ToolRow` receives, minus the i18n function. */
