/**
 * `.xlsx` / `.csv` preview: SheetJS parses, a windowed table paints.
 *
 * The parse half is deliberately boring: `sheet_to_json` with `raw: false` hands back
 * the strings Excel itself would print (dates, percentages, currency and the cell's own
 * number format are already applied), plus `!cols` gives the column widths Excel saved.
 *
 * The render half has to survive spreadsheets that are far taller than any DOM should
 * be, so only a fixed-height window of rows exists at any time:
 *
 *   ┌────────── scroll container (overflow:auto) ──────────┐
 *   │  header row      position:sticky; top:0              │
 *   │  top spacer      height = firstVisibleRow × ROW_H    │
 *   │  visible rows    firstVisibleRow … firstVisibleRow+n│
 *   │  bottom spacer   height = remainingRows × ROW_H      │
 *   └──────────────────────────────────────────────────────┘
 *
 * `onScroll` only records the new `scrollTop` (coalesced to one rAF), and the window is
 * recomputed from it. Each row is memoised on its cell array, so scrolling re-renders
 * the handful of rows entering the window and nothing else. The header row is sticky
 * inside the same scroll container, which is also what makes it scroll horizontally in
 * lockstep with the columns beneath it — exactly how the spreadsheet app behaves.
 *
 * Styling is inline only and reads the panel's existing `--dsw-*` theme tokens, so the
 * viewer inherits the DSH light/dark theme without shipping a stylesheet.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type UIEvent } from 'react'
import * as XLSX from 'xlsx/xlsx.mjs'
import type { ViewerProps } from './types.ts'

/** The two payload shapes the loader can hand this viewer: workbook bytes or CSV text. */
export type SheetSource =
  | { readonly kind: 'bytes'; readonly bytes: ArrayBuffer }
  | { readonly kind: 'text'; readonly text: string }

/** Fixed row height (also the sticky header height); must stay in sync with the spacers. */
const ROW_HEIGHT = 26
/** Rows rendered above and below the viewport so fast scrolling never shows a gap. */
const OVERSCAN_ROWS = 8
/** Hard display caps: the DOM is windowed, but the parsed string matrix is not. */
const MAX_ROWS = 200_000
const MAX_COLS = 100
/** Column width when the workbook carries no `<cols>` entry for the column. */
const DEFAULT_COLUMN_WIDTH = 120
const MIN_COLUMN_WIDTH = 56
const MAX_COLUMN_WIDTH = 420
/**
 * Excel stores column widths in "characters" of its own 11pt font. The grid renders at
 * 12px, slightly wider per character, so the saved `wch` is translated with a little
 * padding — otherwise ordinary values (`2024-01-01`, `1,234,567.89`) would be ellipsised
 * in columns that the spreadsheet app itself displays in full.
 */
const COLUMN_WIDTH_PER_CHARACTER = 7
const COLUMN_WIDTH_PADDING = 14
/** Width reserved for the (optional) sticky row-number gutter. */
const ROW_NUMBER_WIDTH = 44
/**
 * When a sheet's declared `!ref` covers more cells than this, the reference is verified
 * against the actually populated cells before parsing: generators that stamp a whole
 * column/whole sheet reference would otherwise make `sheet_to_json` materialise millions
 * of blank strings. Scanning stops at the same cell count — a genuinely dense sheet just
 * keeps the declared range (the display caps then bound what is rendered).
 */
const REF_AREA_CHECK_LIMIT = 400_000

const FONT_FAMILY = 'var(--dsw-font-family, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif)'

/** Theme tokens, with the light-theme fallbacks the rest of the panel uses. */
const COLOR = {
  text: 'var(--dsw-alias-label-primary, #1b2129)',
  textSecondary: 'var(--dsw-alias-label-secondary, #5b6572)',
  textTertiary: 'var(--dsw-alias-label-tertiary, #8a929c)',
  border: 'var(--dsw-alias-border-secondary, #e4e7eb)',
  borderStrong: 'var(--dsw-alias-border-l3, #d0d5dd)',
  surface: 'var(--dsw-alias-bg-elevated, #fff)',
  surfaceMuted: 'var(--dsw-alias-bg-secondary, #f2f4f7)',
  accent: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  error: 'var(--dsw-alias-state-error-primary, #c0392b)',
  warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
} as const

/** One decoded worksheet, already formatted and capped for display. */
interface GridSheet {
  /** Worksheet name, shown in the tabs / status line. */
  readonly name: string
  /** Formatted display text; `rows[0]` is the frozen header row. */
  readonly rows: ReadonlyArray<ReadonlyArray<string>>
  /** Pixel width for each displayed column. */
  readonly colWidths: ReadonlyArray<number>
  /** Row/column counts as the sheet declares them (before the display caps). */
  readonly totalRows: number
  readonly totalCols: number
  readonly rowsCapped: boolean
  readonly colsCapped: boolean
  /** True when every parsed cell is blank — the sheet is shown as its empty state. */
  readonly blank: boolean
}

type ParseState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly detail: string }
  | { readonly status: 'ready'; readonly sheets: ReadonlyArray<GridSheet> }

const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  overflow: 'hidden',
  background: COLOR.surface,
  color: COLOR.text,
  fontFamily: FONT_FAMILY,
}

const STATE_ROOT_STYLE: CSSProperties = {
  ...ROOT_STYLE,
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: 24,
  textAlign: 'center',
}

const TABS_STYLE: CSSProperties = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'stretch',
  minWidth: 0,
  overflowX: 'auto',
  overflowY: 'hidden',
  overscrollBehaviorX: 'contain',
  borderBottom: `1px solid ${COLOR.border}`,
  background: COLOR.surfaceMuted,
  boxSizing: 'border-box',
}

const TAB_STYLE: CSSProperties = {
  flex: '0 0 auto',
  maxWidth: 180,
  height: 28,
  padding: '0 12px',
  margin: 0,
  border: 'none',
  borderBottomWidth: 2,
  borderBottomStyle: 'solid',
  borderBottomColor: 'transparent',
  background: 'transparent',
  color: COLOR.textSecondary,
  fontFamily: FONT_FAMILY,
  fontSize: 12,
  lineHeight: '26px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  cursor: 'pointer',
  boxSizing: 'border-box',
}

const ACTIVE_TAB_STYLE: CSSProperties = {
  ...TAB_STYLE,
  borderBottomColor: COLOR.accent,
  background: COLOR.surface,
  color: COLOR.text,
  fontWeight: 500,
}

const SCROLL_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  overflow: 'auto',
  overscrollBehavior: 'contain',
  position: 'relative',
  background: COLOR.surface,
}

const HEADER_ROW_STYLE: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 3,
  display: 'flex',
  width: '100%',
  height: ROW_HEIGHT,
  boxSizing: 'border-box',
  background: COLOR.surfaceMuted,
  borderBottom: `1px solid ${COLOR.borderStrong}`,
}

const ROW_NUMBER_BASE: CSSProperties = {
  flex: '0 0 auto',
  width: ROW_NUMBER_WIDTH,
  boxSizing: 'border-box',
  padding: '0 5px',
  textAlign: 'right',
  fontSize: 10,
  lineHeight: `${ROW_HEIGHT - 1}px`,
  color: COLOR.textTertiary,
  background: COLOR.surfaceMuted,
  borderRight: `1px solid ${COLOR.border}`,
  overflow: 'hidden',
  fontVariantNumeric: 'tabular-nums',
  userSelect: 'none',
}

const CORNER_STYLE: CSSProperties = {
  ...ROW_NUMBER_BASE,
  position: 'sticky',
  left: 0,
  zIndex: 1,
  fontWeight: 500,
}

const ROW_NUMBER_STYLE: CSSProperties = {
  ...ROW_NUMBER_BASE,
  position: 'sticky',
  left: 0,
  zIndex: 2,
}

const HEADER_CELL_BASE: CSSProperties = {
  flex: '0 0 auto',
  boxSizing: 'border-box',
  padding: '0 8px',
  fontSize: 12,
  fontWeight: 500,
  lineHeight: `${ROW_HEIGHT - 1}px`,
  color: COLOR.text,
  borderRight: `1px solid ${COLOR.border}`,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
}

const DATA_ROW_STYLE: CSSProperties = {
  display: 'flex',
  width: '100%',
  height: ROW_HEIGHT,
  boxSizing: 'border-box',
  borderBottom: `1px solid ${COLOR.border}`,
  background: COLOR.surface,
}

const DATA_CELL_BASE: CSSProperties = {
  flex: '0 0 auto',
  boxSizing: 'border-box',
  padding: '0 8px',
  fontSize: 12,
  lineHeight: `${ROW_HEIGHT - 1}px`,
  color: COLOR.text,
  borderRight: `1px solid ${COLOR.border}`,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  fontVariantNumeric: 'tabular-nums',
}

const EMPTY_STATE_STYLE: CSSProperties = {
  flex: '1 1 auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  fontSize: 12,
  color: COLOR.textTertiary,
}

const STATUS_BAR_STYLE: CSSProperties = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: 24,
  padding: '0 8px',
  boxSizing: 'border-box',
  borderTop: `1px solid ${COLOR.border}`,
  background: COLOR.surfaceMuted,
  color: COLOR.textTertiary,
  fontSize: 11,
  lineHeight: '23px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
}

const EMPTY_ROW: ReadonlyArray<string> = []
const EMPTY_SHEETS: ReadonlyArray<GridSheet> = []

/**
 * Formatted cells whose text still reads as a plain number are right-aligned, like the
 * spreadsheet app does. The regex deliberately rejects dates/times/booleans, only
 * accepting digit groups with separators, decimals, exponents, currency and `%`.
 */
const NUMBER_LIKE = /^[+-]?(?:[¥$€£]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?%?$/

function alignsRight(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && NUMBER_LIKE.test(trimmed)
}

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

function errorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const compact = raw.replace(/\s+/g, ' ').trim()
  if (compact === '') return '未知错误。'
  return compact.length > 200 ? `${compact.slice(0, 200)}…` : compact
}

/** An `.xlsx`/`.xlsm` file is a ZIP, and a legacy `.xls` an OLE/CFB container. */
function looksLikeSpreadsheet(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false
  const head = new Uint8Array(bytes, 0, 4)
  if (head[0] === 0x50 && head[1] === 0x4b) return true
  return head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0
}

function readWorkbook(source: SheetSource): XLSX.WorkBook {
  if (source.kind === 'bytes') {
    // A corrupt download must become the Chinese error state, not a table full of NUL
    // characters: SheetJS happily decodes arbitrary bytes as a single text cell.
    if (!looksLikeSpreadsheet(source.bytes)) {
      throw new Error('文件头不是有效的 Excel 工作簿（可能已损坏或不是 .xlsx 文件）。')
    }
    // `cellStyles` is what makes SheetJS parse `!cols` (the saved column widths).
    return XLSX.read(new Uint8Array(source.bytes), { type: 'array', cellStyles: true })
  }
  // `cellDates` keeps CSV date strings as real dates instead of timezone-shifted serials,
  // and `dateNF` prints them as yyyy-mm-dd (CSV cells carry no number format of their own).
  return XLSX.read(source.text, { type: 'string', cellDates: true, dateNF: 'yyyy-mm-dd' })
}

/** Sheets the spreadsheet app would show as tabs: hidden/very-hidden ones are skipped. */
function visibleSheetNames(workbook: XLSX.WorkBook): string[] {
  const props = workbook.Workbook?.Sheets
  const visible = workbook.SheetNames.filter((_sheetName, index) => {
    const hidden = props?.[index]?.Hidden
    return hidden !== 1 && hidden !== 2
  })
  return visible.length > 0 ? visible : workbook.SheetNames.slice()
}

/** 1-based endpoint of an `A1`-style cell address, or null when the key is not a cell. */
function decodedCellAddress(address: string): { readonly r: number; readonly c: number } | null {
  let index = 0
  let column = 0
  while (index < address.length) {
    const code = address.charCodeAt(index)
    if (code >= 65 && code <= 90) column = column * 26 + (code - 64)
    else if (code >= 97 && code <= 122) column = column * 26 + (code - 96)
    else break
    index += 1
  }
  if (index === 0 || index >= address.length) return null
  const row = Number(address.slice(index))
  if (!Number.isInteger(row) || row < 1 || column < 1) return null
  return { r: row - 1, c: column - 1 }
}

/**
 * Row/column counts of the cells that actually exist.
 *
 * Only used when the declared `!ref` covers an implausibly large area; a sparse sheet
 * with an inflated reference then previews just its real extent instead of forcing the
 * decoder through millions of blank rows. Returns the fallback once the scan itself
 * grows past the same budget (dense sheets are trusted as declared).
 */
function contentBounds(worksheet: XLSX.WorkSheet, fallback: { readonly rows: number; readonly cols: number }): { readonly rows: number; readonly cols: number } {
  let rows = 0
  let cols = 0
  let scanned = 0
  for (const key in worksheet) {
    if (key.charCodeAt(0) === 33 /* '!' */) continue
    const cell = decodedCellAddress(key)
    if (cell === null) continue
    if (cell.r + 1 > rows) rows = cell.r + 1
    if (cell.c + 1 > cols) cols = cell.c + 1
    scanned += 1
    if (scanned > REF_AREA_CHECK_LIMIT) return fallback
  }
  return { rows, cols }
}

/** Declared display extent of a worksheet, starting at A1 (leading blanks are shown too). */
function sheetBounds(worksheet: XLSX.WorkSheet): { readonly rows: number; readonly cols: number } {
  const reference = worksheet['!ref']
  if (reference === undefined) return { rows: 0, cols: 0 }
  const end = XLSX.utils.decode_range(reference).e
  const declared = { rows: end.r + 1, cols: end.c + 1 }
  if (declared.rows * declared.cols <= REF_AREA_CHECK_LIMIT) return declared
  return contentBounds(worksheet, declared)
}

function columnWidths(worksheet: XLSX.WorkSheet, count: number): number[] {
  const saved = worksheet['!cols']
  const widths: number[] = []
  for (let column = 0; column < count; column += 1) {
    const info = saved?.[column]
    let width = DEFAULT_COLUMN_WIDTH
    if (info !== undefined) {
      const characters = typeof info.wch === 'number' ? info.wch : typeof info.width === 'number' ? info.width : undefined
      if (characters !== undefined) width = characters * COLUMN_WIDTH_PER_CHARACTER + COLUMN_WIDTH_PADDING
      else if (typeof info.wpx === 'number') width = info.wpx * 1.1 + 4
    }
    widths.push(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width))))
  }
  return widths
}

/** Decode one worksheet into formatted display strings, capped to the render limits. */
function readGrid(workbook: XLSX.WorkBook, sheetName: string): GridSheet {
  const worksheet = workbook.Sheets[sheetName]
  const bounds = worksheet === undefined ? { rows: 0, cols: 0 } : sheetBounds(worksheet)
  const totalRows = bounds.rows
  const totalCols = bounds.cols
  if (worksheet === undefined || totalRows === 0 || totalCols === 0) {
    return { name: sheetName, rows: [], colWidths: [], totalRows: 0, totalCols: 0, rowsCapped: false, colsCapped: false, blank: true }
  }

  const displayRows = Math.min(totalRows, MAX_ROWS)
  const displayCols = Math.min(totalCols, MAX_COLS)
  const decoded = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: true,
    range: { s: { r: 0, c: 0 }, e: { r: displayRows - 1, c: displayCols - 1 } },
  })

  const rows: string[][] = []
  let blank = true
  for (let rowIndex = 0; rowIndex < displayRows; rowIndex += 1) {
    const source = decoded[rowIndex] ?? []
    const row: string[] = []
    for (let column = 0; column < displayCols; column += 1) {
      const value = source[column]
      let text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
      // A UTF-8 BOM is legal file preamble that SheetJS keeps inside the first cell.
      if (rowIndex === 0 && column === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      if (blank && text.trim() !== '') blank = false
      row.push(text)
    }
    rows.push(row)
  }

  return {
    name: sheetName,
    rows,
    colWidths: columnWidths(worksheet, displayCols),
    totalRows,
    totalCols,
    rowsCapped: totalRows > displayRows,
    colsCapped: totalCols > displayCols,
    blank,
  }
}

function readSheets(source: SheetSource): readonly GridSheet[] {
  const workbook = readWorkbook(source)
  return visibleSheetNames(workbook).map(sheetName => readGrid(workbook, sheetName))
}

interface GridRowProps {
  readonly rowIndex: number
  readonly cells: ReadonlyArray<string>
  readonly widths: ReadonlyArray<number>
}

/**
 * One windowed body row. Memoised on the row's cell array: scrolling changes which rows
 * are mounted, but a row whose `cells`/`widths` identities did not change renders nothing.
 */
const GridRow = memo(function GridRow({ rowIndex, cells, widths }: GridRowProps): ReactElement {
  const number = rowIndex + 2
  return (
    <div role="row" aria-rowindex={number} style={DATA_ROW_STYLE}>
      <div aria-hidden="true" style={ROW_NUMBER_STYLE}>{number}</div>
      {widths.map((width, column) => {
        const text = cells[column] ?? ''
        return (
          <div
            key={column}
            role="gridcell"
            style={alignsRight(text)
              ? { ...DATA_CELL_BASE, width, textAlign: 'right' }
              : { ...DATA_CELL_BASE, width }}
            {...(text.length > 8 ? { title: text } : {})}
          >
            {text}
          </div>
        )
      })}
    </div>
  )
})

interface GridHeaderProps {
  readonly cells: ReadonlyArray<string>
  readonly widths: ReadonlyArray<number>
}

/** The frozen header row: sticky at the top of the scroll container. */
const GridHeader = memo(function GridHeader({ cells, widths }: GridHeaderProps): ReactElement {
  return (
    <div role="row" aria-rowindex={1} style={HEADER_ROW_STYLE}>
      <div aria-hidden="true" style={CORNER_STYLE} />
      {widths.map((width, column) => {
        const text = cells[column] ?? ''
        return (
          <div
            key={column}
            role="columnheader"
            aria-colindex={column + 1}
            title={text.length > 8 ? text : undefined}
            style={alignsRight(text)
              ? { ...HEADER_CELL_BASE, width, textAlign: 'right' }
              : { ...HEADER_CELL_BASE, width }}
          >
            {text}
          </div>
        )
      })}
    </div>
  )
})

/**
 * The panel's spreadsheet viewer.
 *
 * `source.kind === 'bytes'` is a complete workbook (`.xlsx`/`.xlsm`), `kind === 'text'`
 * is CSV text straight from the host. Parsing is deferred one task so the loading state
 * paints before SheetJS blocks the main thread, and the result is kept in state — the
 * viewer owns no RPC and never reloads on its own.
 */
export function SheetViewer({ source, name }: { readonly source: SheetSource; readonly name: ViewerProps['name'] }): ReactElement {
  const [parse, setParse] = useState<ParseState>({ status: 'loading' })
  const [activeIndex, setActiveIndex] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const pendingScrollTopRef = useRef(0)

  // Stable identities for the effect: the loader may hand a fresh wrapper object each
  // render, but the bytes / text it carries are the same and must not trigger a reparse.
  const sourceKind = source.kind
  const sourceKey: ArrayBuffer | string = source.kind === 'bytes' ? source.bytes : source.text

  useEffect(() => {
    let alive = true
    setParse({ status: 'loading' })
    setActiveIndex(0)
    // Defer one task: a large workbook takes hundreds of milliseconds of blocking JS,
    // and the user should see 正在解析表格… while that happens, not a frozen panel.
    const timer = window.setTimeout(() => {
      try {
        const sheets = readSheets(source)
        if (!alive) return
        setParse(sheets.length === 0
          ? { status: 'error', detail: '工作簿中没有任何可显示的工作表。' }
          : { status: 'ready', sheets })
      } catch (error: unknown) {
        if (alive) setParse({ status: 'error', detail: errorDetail(error) })
      }
    }, 0)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [sourceKind, sourceKey])

  const sheets = parse.status === 'ready' ? parse.sheets : EMPTY_SHEETS
  const selectedIndex = Math.min(activeIndex, Math.max(0, sheets.length - 1))
  const grid = sheets[selectedIndex]
  const isEmptySheet = grid === undefined || grid.blank

  // Measure the viewport for the window calculation; ResizeObserver keeps it honest when
  // the dock is resized (or the tab becomes visible after mounting at zero height).
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const measure = (): void => { setViewportHeight(element.clientHeight) }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => { window.removeEventListener('resize', measure) }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [parse.status, selectedIndex, isEmptySheet])

  // A different sheet always starts at its first row, and the header must stay frozen.
  useLayoutEffect(() => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
    pendingScrollTopRef.current = 0
    const element = scrollRef.current
    if (element !== null && element.scrollTop !== 0) element.scrollTop = 0
    setScrollTop(0)
  }, [parse, selectedIndex])

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    // Coalesce scroll events to one state update per animation frame: a trackpad can
    // fire far more often than the window needs to move.
    pendingScrollTopRef.current = event.currentTarget.scrollTop
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      setScrollTop(pendingScrollTopRef.current)
    })
  }

  if (parse.status === 'loading') {
    return (
      <div style={STATE_ROOT_STYLE}>
        <div style={{ fontSize: 12, color: COLOR.textTertiary }}>正在解析表格…</div>
      </div>
    )
  }

  if (parse.status === 'error') {
    return (
      <div style={STATE_ROOT_STYLE}>
        <div style={{ fontSize: 12, color: COLOR.error }}>无法解析表格「{name}」</div>
        <div style={{ maxWidth: 420, fontSize: 11, lineHeight: 1.5, color: COLOR.textTertiary, wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{parse.detail}</div>
      </div>
    )
  }

  const sheetCount = sheets.length

  const tabs = sheetCount > 1
    ? (
        <div role="tablist" aria-label="工作表" style={TABS_STYLE}>
          {sheets.map((sheet, index) => (
            <button
              key={`${sheet.name}:${index}`}
              type="button"
              role="tab"
              aria-selected={index === selectedIndex}
              title={sheet.name}
              onClick={() => setActiveIndex(index)}
              style={index === selectedIndex ? ACTIVE_TAB_STYLE : TAB_STYLE}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )
    : null

  if (grid === undefined || grid.blank) {
    return (
      <div style={ROOT_STYLE}>
        {tabs}
        <div style={EMPTY_STATE_STYLE}>空工作表</div>
      </div>
    )
  }

  const dataRowCount = Math.max(0, grid.rows.length - 1)
  // Before the first measurement, assume a dock-sized viewport; the layout effect above
  // corrects it before the first paint.
  const viewport = viewportHeight > 0 ? viewportHeight : 480
  const visibleRows = Math.ceil(viewport / ROW_HEIGHT) + 1
  const startRow = Math.max(0, Math.min(dataRowCount, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS))
  const endRow = Math.min(dataRowCount, startRow + visibleRows + OVERSCAN_ROWS * 2)
  const topSpacer = startRow * ROW_HEIGHT
  const bottomSpacer = Math.max(0, (dataRowCount - endRow) * ROW_HEIGHT)
  const totalWidth = ROW_NUMBER_WIDTH + grid.colWidths.reduce((sum, width) => sum + width, 0)
  const headerCells = grid.rows[0] ?? EMPTY_ROW

  const windowRows: ReactElement[] = []
  for (let rowIndex = startRow; rowIndex < endRow; rowIndex += 1) {
    windowRows.push(
      <GridRow
        key={rowIndex}
        rowIndex={rowIndex}
        cells={grid.rows[rowIndex + 1] ?? EMPTY_ROW}
        widths={grid.colWidths}
      />,
    )
  }

  const capParts: string[] = []
  if (grid.rowsCapped) capParts.push(`前 ${formatCount(MAX_ROWS)} 行`)
  if (grid.colsCapped) capParts.push(`前 ${formatCount(MAX_COLS)} 列`)
  const capText = capParts.length > 0 ? `仅显示${capParts.join('、')}` : ''
  const countText = `${formatCount(grid.totalRows)} 行 × ${formatCount(grid.totalCols)} 列`
  const statusText = sheetCount === 1
    ? `${grid.name} · ${countText}${capText === '' ? '' : ` · ${capText}`}`
    : `${countText}${capText === '' ? '' : ` · ${capText}`}`

  return (
    <div style={ROOT_STYLE}>
      {tabs}
      <div
        ref={scrollRef}
        role="grid"
        aria-label={`${name} 表格`}
        aria-rowcount={grid.rows.length}
        aria-colcount={grid.colWidths.length}
        tabIndex={0}
        onScroll={handleScroll}
        style={SCROLL_STYLE}
      >
        <div style={{ width: totalWidth, minWidth: '100%' }}>
          <GridHeader cells={headerCells} widths={grid.colWidths} />
          {topSpacer > 0 ? <div aria-hidden="true" style={{ height: topSpacer }} /> : null}
          {windowRows}
          {bottomSpacer > 0 ? <div aria-hidden="true" style={{ height: bottomSpacer }} /> : null}
        </div>
      </div>
      <div style={STATUS_BAR_STYLE} title={statusText}>
        {sheetCount === 1
          ? (
              <>
                <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{grid.name}</span>
                <span style={{ flex: '0 0 auto' }}>·</span>
              </>
            )
          : null}
        <span style={{ flex: '0 0 auto' }}>{countText}</span>
        {capText === ''
          ? null
          : (
              <>
                <span style={{ flex: '0 0 auto' }}>·</span>
                <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: COLOR.warn }} title={capText}>{capText}</span>
              </>
            )}
      </div>
    </div>
  )
}
