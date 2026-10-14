/**
 * Markdown — a small, dependency-free renderer for Bot Community replies.
 *
 * The plugin ships no third-party runtime dependencies and its client bundle must
 * stay self-contained, so this covers the subset LLM replies actually use:
 * fenced code blocks, ATX headings, unordered/ordered lists, blockquotes, rules,
 * GFM tables, and inline bold / italic / inline-code / links.
 *
 * Deliberately NOT supported: raw HTML (never injected — everything is React
 * text nodes, so model output can never become markup).
 */
import { memo } from 'react'
import type { CSSProperties, ReactNode } from 'react'

export interface MarkdownProps {
  readonly text: string
  /** Slightly smaller type for compact surfaces. */
  readonly dense?: boolean
}

// ── inline ────────────────────────────────────────────────────────────────────

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]*\]\([^)\s]+\))/g

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  INLINE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const token = m[0]
    const k = `${keyBase}-i${n++}`
    if (token.startsWith('`')) {
      out.push(<code key={k} style={inlineCode}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={k} style={{ fontWeight: 600 }}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*') || token.startsWith('_')) {
      out.push(<em key={k}>{token.slice(1, -1)}</em>)
    } else {
      const label = token.slice(1, token.indexOf(']'))
      const href = token.slice(token.indexOf('](') + 2, -1)
      out.push(
        <a key={k} href={href} target="_blank" rel="noreferrer noopener" style={link}>{label}</a>,
      )
    }
    last = m.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// ── syntax highlighting ───────────────────────────────────────────────────────
//
// A tiny regex tokenizer, not a parser: each language is a priority-ordered rule
// list whose rules are anchored at the scan position (sticky `y` flag). It adds no
// dependency, cannot throw on malformed or half-streamed input, and the token
// texts concatenated always equal the input byte for byte — which is what keeps
// indentation and blank lines intact inside `white-space: pre`.
//
// Every colour below is a DSH theme alias, all verified to exist in the runtime.
// Nothing is hard-coded and nothing is injected as HTML: tokens become React
// text/element nodes only.

/** Token classes the highlighter can emit. `plain` renders with no extra style. */
export type HighlightKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'literal'
  | 'keyword'
  | 'builtin'
  | 'function'
  | 'type'
  | 'property'
  | 'attr'
  | 'tag'
  | 'variable'
  | 'meta'
  /** An object/map KEY (`support.type.property-name.json`, `entity.name.tag.yaml`). */
  | 'key'
  /**
   * An OPERATOR or key/value separator (`keyword.operator.*`,
   * `punctuation.separator.key-value`) — keyword coloured, unlike `operator`.
   */
  | 'symbol'
  /** A markdown link target (`markup.underline.link`). */
  | 'link'
  /**
   * A parameter in a function DECLARATION (`variable.parameter.function`).
   *
   * Not emitted by a lexer rule: a parameter list and a call's argument list are
   * lexically identical, so this kind is assigned by {@link markParameters}, which
   * fires only inside a construct that is unambiguously a declaration.
   */
  | 'param'
  /** Markdown emphasis — native styles these with fontStyle only, never a colour. */
  | 'bold'
  | 'italic'
  | 'operator'

export interface HighlightToken {
  readonly kind: HighlightKind
  readonly text: string
}

interface Rule {
  readonly kind: HighlightKind
  readonly re: RegExp
}

/** A rule that only matches at the current scan position. */
function hlRule(kind: HighlightKind, source: string, flags = ''): Rule {
  return { kind, re: new RegExp(source, 'y' + flags) }
}

/** Above this size a block degrades to plain text instead of paying the scan. */
const MAX_HIGHLIGHT_CHARS = 20000

// shared lexemes
const STR_DQ = String.raw`"(?:\\[\s\S]|[^"\\\n])*"`
const STR_SQ = String.raw`'(?:\\[\s\S]|[^'\\\n])*'`
const STR_BT = String.raw`\x60(?:\\[\s\S]|[^\\\x60])*\x60`
const C_LINE_COMMENT = hlRule('comment', String.raw`\/\/[^\n]*`)
const C_BLOCK_COMMENT = hlRule('comment', String.raw`\/\*[\s\S]*?(?:\*\/|$)`)
const HASH_COMMENT = hlRule('comment', String.raw`#[^\n]*`)
const C_NUMBER = hlRule(
  'number',
  String.raw`(?:\b0[xX][0-9a-fA-F_]+|\b0[bB][01_]+|\b0[oO][0-7_]+|\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)n?(?![\w$])`,
)
// `keyword.operator.*` → the theme's bare `keyword` rule, so operators take the
// KEYWORD colour. A bare `:` is deliberately NOT here: a TS type annotation uses
// `punctuation.separator.type-annotation` (punctuation grey), and a regex
// tokenizer cannot tell that apart from an object-literal key separator, so `:`
// stays in the punctuation set.
const C_OPERATOR = hlRule(
  'symbol',
  String.raw`=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\*\*|<<|>>|[+\-*/%<>=!&|^~?]+`,
)
const C_PUNCT = hlRule('operator', String.raw`[{}\[\](),;.:]`)
const JS_IDENT = hlRule('plain', String.raw`[A-Za-z_$][\w$]*`)
const WS = hlRule('plain', String.raw`\s+`)

const TS_RULES: readonly Rule[] = [
  C_LINE_COMMENT,
  C_BLOCK_COMMENT,
  hlRule('string', STR_DQ),
  hlRule('string', STR_SQ),
  hlRule('string', STR_BT),
  C_NUMBER,
  hlRule('literal', String.raw`\b(?:true|false|null|undefined|NaN|Infinity)\b`),
  hlRule(
    'keyword',
    String.raw`\b(?:abstract|as|asserts|async|await|break|case|catch|class|const|continue|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|is|keyof|let|namespace|new|of|override|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield)\b`,
  ),
  // `storage.type` in the native sheet — a builtin type name is a KEYWORD token,
  // not a type reference. `entity.name.type` (below) is what paints as function.
  hlRule('keyword', String.raw`\b(?:any|bigint|boolean|never|number|object|string|symbol|unknown)\b`),
  hlRule(
    'builtin',
    String.raw`\b(?:AbortController|AbortSignal|Array|BigInt|Boolean|Date|Error|Function|Intl|JSON|Map|Math|Number|Object|Promise|Proxy|RangeError|Reflect|RegExp|Set|String|Symbol|TypeError|URL|URLSearchParams|WeakMap|WeakSet|clearInterval|clearTimeout|console|document|exports|fetch|globalThis|localStorage|module|navigator|process|queueMicrotask|require|sessionStorage|setInterval|setTimeout|structuredClone|window)\b`,
  ),
  hlRule('function', String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()`),
  hlRule('type', String.raw`\b[A-Z][\w$]*\b`),
  hlRule('property', String.raw`\.[A-Za-z_$][\w$]*`),
  C_OPERATOR,
  C_PUNCT,
  JS_IDENT,
  hlRule('plain', String.raw`[^\s]`),
  WS,
]

const JSON_RULES: readonly Rule[] = [
  // `support.type.property-name.json` → token-keyword (an object KEY, not a value).
  hlRule('key', String.raw`"(?:\\[\s\S]|[^"\\])*"(?=\s*:)`),
  hlRule('string', String.raw`"(?:\\[\s\S]|[^"\\])*"`),
  hlRule('number', String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`),
  hlRule('literal', String.raw`\b(?:true|false|null)\b`),
  hlRule('operator', String.raw`[{}\[\],:]`),
  hlRule('plain', String.raw`[^\s]`),
  WS,
]

const SH_RULES: readonly Rule[] = [
  HASH_COMMENT,
  hlRule('string', STR_DQ),
  hlRule('string', String.raw`'[^'\n]*'`),
  hlRule('variable', String.raw`\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$[0-9@*#?!\-]`),
  hlRule(
    'keyword',
    String.raw`\b(?:alias|break|case|continue|declare|do|done|elif|else|esac|eval|exec|exit|export|fi|for|function|if|in|let|local|readonly|return|select|set|shift|source|then|time|trap|typeset|unalias|unset|until|while)\b`,
  ),
  hlRule(
    'builtin',
    String.raw`\b(?:apt|apt-get|awk|base64|brew|cat|cd|chmod|chown|code|cp|curl|cut|df|diff|dig|docker|du|echo|env|find|free|git|go|grep|gzip|head|helm|jq|kill|killall|kubectl|less|ln|ls|make|mkdir|more|mv|npx|open|patch|ping|pip|pip3|pnpm|printf|ps|pwd|python|python3|read|rm|rmdir|rsync|scp|sed|service|shasum|sleep|sort|ssh|sudo|systemctl|tail|tar|tee|test|top|touch|tr|tree|uniq|unzip|wc|wget|which|xargs|yarn|zip)\b`,
  ),
  hlRule('number', String.raw`\b\d+\b`),
  hlRule('property', String.raw`--?[A-Za-z][\w-]*`),
  hlRule('symbol', String.raw`[|&<>!=]+`),
  hlRule('operator', String.raw`[;()\[\]{}]`),
  hlRule('plain', String.raw`[A-Za-z_][\w.-]*`),
  hlRule('plain', String.raw`[^\s]`),
  WS,
]

const PY_RULES: readonly Rule[] = [
  HASH_COMMENT,
  hlRule('string', String.raw`(?:[rRbBuUfF]{0,2})?"""[\s\S]*?(?:"""|$)`),
  hlRule('string', String.raw`(?:[rRbBuUfF]{0,2})?'''[\s\S]*?(?:'''|$)`),
  hlRule('string', String.raw`(?:[rRbBuUfF]{0,2})?"(?:\\[\s\S]|[^"\\\n])*"`),
  hlRule('string', String.raw`(?:[rRbBuUfF]{0,2})?'(?:\\[\s\S]|[^'\\\n])*'`),
  hlRule('meta', String.raw`@[A-Za-z_]\w*`),
  hlRule(
    'number',
    String.raw`(?:\b0[xX][0-9a-fA-F_]+|\b0[bB][01_]+|\b0[oO][0-7_]+|\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)j?(?!\w)`,
  ),
  hlRule('literal', String.raw`\b(?:True|False|None)\b`),
  hlRule(
    'keyword',
    String.raw`\b(?:and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|self|cls|try|while|with|yield)\b`,
  ),
  hlRule(
    'builtin',
    String.raw`\b(?:abs|all|any|bin|bool|bytearray|bytes|callable|chr|classmethod|complex|dict|dir|divmod|enumerate|eval|filter|float|format|frozenset|getattr|globals|hasattr|hash|hex|id|input|int|isinstance|issubclass|iter|len|list|locals|map|max|min|next|object|oct|open|ord|pow|print|property|range|repr|reversed|round|set|setattr|slice|sorted|staticmethod|str|sum|super|tuple|type|vars|zip|AssertionError|AttributeError|Exception|FileNotFoundError|ImportError|IndexError|KeyError|NotImplementedError|OSError|RuntimeError|StopIteration|TypeError|ValueError|ZeroDivisionError)\b`,
  ),
  hlRule('function', String.raw`\b[A-Za-z_]\w*(?=\s*\()`),
  hlRule('type', String.raw`\b[A-Z]\w*\b`),
  hlRule('property', String.raw`\.[A-Za-z_]\w*`),
  hlRule('symbol', String.raw`->|:=|==|!=|<=|>=|\*\*|\/\/|<<|>>|[+\-*/%@<>=&|^~]+`),
  hlRule('operator', String.raw`[{}\[\](),:;.]`),
  hlRule('plain', String.raw`[A-Za-z_]\w*`),
  hlRule('plain', String.raw`[^\s\w]`),
  WS,
]

const YAML_RULES: readonly Rule[] = [
  HASH_COMMENT,
  hlRule('meta', String.raw`^---[^\n]*$|^\.\.\.[^\n]*$`, 'm'),
  hlRule('operator', String.raw`^[ \t]*-[ \t]+`, 'm'),
  // `entity.name.tag.yaml` → token-keyword.
  hlRule('key', String.raw`^[ \t]*(?:"[^"\n]*"|'[^'\n]*'|[A-Za-z_][\w.-]*)(?=\s*:)`, 'm'),
  hlRule('meta', String.raw`[&*][A-Za-z_][\w-]*`),
  hlRule('meta', String.raw`![A-Za-z_][\w!/-]*`),
  hlRule('string', STR_DQ),
  hlRule('string', String.raw`'[^'\n]*'`),
  hlRule(
    'literal',
    String.raw`\b(?:False|No|Null|Off|On|True|Yes|false|null|no|off|on|true|yes)\b`,
  ),
  hlRule('number', String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`),
  hlRule('operator', String.raw`[-:,\[\]{}|>?~]+`),
  hlRule('plain', String.raw`[^\s:,\[\]{}|>?#\-]+`),
  hlRule('plain', String.raw`[^\s]`),
  WS,
]

const CSS_RULES: readonly Rule[] = [
  hlRule('comment', String.raw`\/\*[\s\S]*?(?:\*\/|$)`),
  hlRule('meta', String.raw`@[\w-]+`),
  hlRule('variable', String.raw`--[\w-]+`),
  hlRule('string', STR_DQ),
  hlRule('string', String.raw`'[^'\n]*'`),
  hlRule('number', String.raw`#[0-9a-fA-F]{3,8}(?![\w-])`),
  hlRule('property', String.raw`[-A-Za-z][\w-]*(?=\s*:)`),
  hlRule('type', String.raw`[.#][A-Za-z_-][\w-]*`),
  hlRule('keyword', String.raw`::[A-Za-z-][\w-]*`),
  hlRule('function', String.raw`[-A-Za-z][\w-]*(?=\()`),
  hlRule('number', String.raw`-?\b\d*\.?\d+(?:%|[a-zA-Z]{1,4})?`),
  hlRule(
    'literal',
    String.raw`\b(?:absolute|auto|block|bold|bottom|capitalize|center|collapse|contents|currentColor|dashed|dotted|double|fixed|flex|grid|hidden|inherit|initial|inline|italic|left|lowercase|middle|none|normal|nowrap|pointer|relative|revert|right|solid|static|sticky|top|transparent|unset|uppercase|visible|wrap)\b`,
  ),
  hlRule('operator', String.raw`[{}();:,>+~*=\[\]!]`),
  hlRule('plain', String.raw`[^\s{}();:,>+~*=\[\]!#\-]+`),
  hlRule('plain', String.raw`[^\s]`),
  WS,
]

const HTML_RULES: readonly Rule[] = [
  hlRule('comment', String.raw`<!--[\s\S]*?(?:-->|$)`),
  hlRule(
    'meta',
    String.raw`<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<!DOCTYPE[^>]*>|<\?[\s\S]*?(?:\?>|$)`,
    'i',
  ),
  hlRule('tag', String.raw`<\/?[A-Za-z][\w:.-]*`),
  hlRule('attr', String.raw`[A-Za-z_:@#][\w:.-]*(?=\s*=)`),
  hlRule('string', String.raw`"[^"]*"`),
  hlRule('string', String.raw`'[^']*'`),
  hlRule('literal', String.raw`&#\d+;|&#[xX][0-9a-fA-F]+;|&[A-Za-z]\w*;`),
  hlRule('operator', String.raw`<\/|\/>|=|>`),
  hlRule('plain', String.raw`[A-Za-z_][\w:.-]*`),
  hlRule('plain', String.raw`[^\s]`),
  WS,
]

const SQL_RULES: readonly Rule[] = [
  hlRule('comment', String.raw`--[^\n]*`),
  hlRule('comment', String.raw`\/\*[\s\S]*?(?:\*\/|$)`),
  hlRule('string', String.raw`'(?:''|[^'])*'`),
  hlRule('string', String.raw`"(?:""|[^"])*"`),
  hlRule('variable', String.raw`[@:$][A-Za-z_]\w*`),
  hlRule(
    'keyword',
    String.raw`\b(?:add|all|alter|and|analyze|as|asc|begin|between|bigint|blob|bool|boolean|by|cascade|case|char|check|column|commit|conflict|constraint|create|cross|database|date|decimal|default|delete|desc|distinct|do|double|drop|else|end|exists|explain|fetch|float|foreign|from|full|grant|group|having|if|ilike|in|index|inner|insert|int|integer|into|is|join|json|jsonb|key|left|like|limit|natural|next|not|null|numeric|nothing|offset|on|only|or|order|outer|over|partition|precision|primary|real|references|replace|returning|revoke|right|rollback|rows|schema|select|serial|set|smallint|table|text|then|timestamp|timestamptz|transaction|truncate|union|unique|update|use|using|uuid|vacuum|values|varchar|view|when|where|window|with)\b`,
    'i',
  ),
  hlRule(
    'builtin',
    String.raw`\b(?:abs|array_agg|avg|cast|ceil|coalesce|concat|count|current_date|current_timestamp|current_user|date_trunc|dense_rank|extract|floor|generate_series|greatest|json_agg|jsonb_agg|lag|lead|least|length|lower|max|min|nullif|now|random|rank|round|row_number|string_agg|substring|sum|to_char|to_date|trim|upper)\b`,
    'i',
  ),
  hlRule('number', String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`),
  hlRule('symbol', String.raw`<>|!=|<=|>=|\|\||::|[-+*/%=<>]`),
  hlRule('operator', String.raw`[(),;.\[\]{}]`),
  hlRule('plain', String.raw`[A-Za-z_]\w*`),
  hlRule('plain', String.raw`[^\s]`),
  WS,
]

const GO_RULES: readonly Rule[] = [
  C_LINE_COMMENT,
  C_BLOCK_COMMENT,
  hlRule('string', STR_DQ),
  hlRule('string', String.raw`\x60[^\x60]*\x60`),
  hlRule('string', String.raw`'(?:\\[\s\S]|[^'\\\n])*'`),
  C_NUMBER,
  hlRule('literal', String.raw`\b(?:false|iota|nil|true)\b`),
  hlRule(
    'keyword',
    String.raw`\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b`,
  ),
  hlRule(
    'type',
    String.raw`\b(?:any|bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr)\b`,
  ),
  hlRule(
    'builtin',
    String.raw`\b(?:append|cap|clear|close|copy|delete|len|make|max|min|new|panic|print|println|recover)\b`,
  ),
  hlRule('function', String.raw`\b[A-Za-z_]\w*(?=\s*\()`),
  hlRule('type', String.raw`\b[A-Z]\w*\b`),
  hlRule('property', String.raw`\.[A-Za-z_]\w*`),
  C_OPERATOR,
  C_PUNCT,
  hlRule('plain', String.raw`[A-Za-z_]\w*`),
  hlRule('plain', String.raw`[^\s]`),
  WS,
]

const RUST_RULES: readonly Rule[] = [
  C_LINE_COMMENT,
  C_BLOCK_COMMENT,
  hlRule('meta', String.raw`#!?\[[^\]\n]*\]`),
  hlRule('string', String.raw`r#*"[\s\S]*?"#*`),
  hlRule('string', String.raw`b?"(?:\\[\s\S]|[^"\\\n])*"`),
  hlRule('string', String.raw`b?'(?:\\[\s\S]|[^'\\\n])*'`),
  hlRule('function', String.raw`\b[a-z_]\w*!(?!=)`),
  hlRule('literal', String.raw`\b(?:Err|None|Ok|Some|false|true)\b`),
  hlRule(
    'keyword',
    String.raw`\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|union|unsafe|use|where|while|yield)\b`,
  ),
  hlRule(
    'type',
    String.raw`\b(?:Arc|BTreeMap|BTreeSet|Box|Cell|Cow|Duration|HashMap|HashSet|Instant|Mutex|Option|Path|PathBuf|Rc|RefCell|Result|RwLock|String|Vec|VecDeque|bool|char|f32|f64|i8|i16|i32|i64|i128|isize|str|u8|u16|u32|u64|u128|usize)\b`,
  ),
  C_NUMBER,
  hlRule('function', String.raw`\b[a-z_]\w*(?=\s*\()`),
  hlRule('type', String.raw`\b[A-Z]\w*\b`),
  hlRule('property', String.raw`(?:\.[A-Za-z_]\w*|::[A-Za-z_]\w*)`),
  C_OPERATOR,
  C_PUNCT,
  hlRule('plain', String.raw`[A-Za-z_]\w*`),
  hlRule('plain', String.raw`[^\s]`),
  WS,
]

const MD_RULES: readonly Rule[] = [
  hlRule('meta', String.raw`^[ \t]*(?:\x60{3,}|~~~)[^\n]*$`, 'm'),
  hlRule('keyword', String.raw`^[ \t]*#{1,6}[ \t][^\n]*$`, 'm'),
  hlRule('keyword', String.raw`^[ \t]*>[ \t]?`, 'm'),
  hlRule('keyword', String.raw`^[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+)`, 'm'),
  hlRule('operator', String.raw`^[ \t]*(?:[-*_][ \t]*){3,}$`, 'm'),
  hlRule('string', String.raw`\x60[^\x60\n]*\x60`),
  // Native gives emphasis FONT STYLE ONLY (`markup.bold.markdown` → fontStyle bold,
  // `markup.italic.markdown` → italic) with no colour, so these must not borrow a
  // token colour — they previously reused `type` and came out coloured.
  hlRule('bold', String.raw`\*\*[^*\n]+\*\*|__[^_\n]+__`),
  hlRule('italic', String.raw`\*[^*\n]+\*|_[^_\n]+_`),
  // A markdown link is TWO scopes in native: the title is
  // `string.other.link.title.markdown` → keyword, the target is
  // `markup.underline.link` / `punctuation.definition.metadata.markdown` → link.
  // The single `function` rule this replaces coloured both halves the same.
  hlRule('keyword', String.raw`!?\[[^\]\n]*\]`),
  hlRule('link', String.raw`\([^)\s]*\)`),
  hlRule('operator', String.raw`[\[\]()]`),
  hlRule('plain', String.raw`[^\s]`),
  WS,
]

const RULES_BY_LANG: Readonly<Record<string, readonly Rule[]>> = {
  ts: TS_RULES,
  json: JSON_RULES,
  sh: SH_RULES,
  py: PY_RULES,
  yaml: YAML_RULES,
  css: CSS_RULES,
  html: HTML_RULES,
  sql: SQL_RULES,
  go: GO_RULES,
  rust: RUST_RULES,
  md: MD_RULES,
}

const LANG_ALIAS: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', javascript: 'ts', typescript: 'ts',
  mjs: 'ts', cjs: 'ts', mts: 'ts', cts: 'ts', node: 'ts',
  json: 'json', jsonc: 'json', json5: 'json',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', terminal: 'sh', shellscript: 'sh',
  py: 'py', python: 'py', python3: 'py',
  yaml: 'yaml', yml: 'yaml',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  sql: 'sql', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql', plpgsql: 'sql',
  go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  md: 'md', markdown: 'md', mdx: 'md',
}

function normalizeLang(lang: string): string | undefined {
  const key = lang.trim().toLowerCase().replace(/^language-/, '').replace(/[^a-z0-9]/g, '')
  return LANG_ALIAS[key]
}

/** Conservative auto-detection, only for blocks the author left unlabelled. */
function detectLang(code: string): string | undefined {
  const head = code.replace(/^\s+/, '')
  if (/^[{[]/.test(head) && /[}\]]\s*$/.test(head)) return 'json'
  if (/^(?:<!DOCTYPE|<html|<head|<body|<div|<span|<p\b|<a\b|<ul|<li|<table|<script|<style)/i.test(head)) return 'html'
  if (/^#!\/|^(?:cd|curl|docker|echo|git|go|kubectl|ls|make|mkdir|mv|node|npm|pip3?|pnpm|python3?|rm|sudo|wget|yarn)\s/m.test(head)) return 'sh'
  if (/^(?:alter|create|delete|drop|grant|insert|select|truncate|update|with)\b/i.test(head)) return 'sql'
  return undefined
}

function resolveRules(code: string, lang: string): readonly Rule[] | undefined {
  const named = normalizeLang(lang)
  if (named !== undefined) return RULES_BY_LANG[named]
  // An explicitly unknown language degrades to plain text without guessing.
  if (lang.trim() !== '') return undefined
  const detected = detectLang(code)
  return detected === undefined ? undefined : RULES_BY_LANG[detected]
}

function runRules(code: string, rules: readonly Rule[]): HighlightToken[] {
  const out: HighlightToken[] = []
  const end = code.length
  let pos = 0
  let plainFrom = 0
  while (pos < end) {
    let hit: Rule | undefined
    let text = ''
    for (let i = 0; i < rules.length; i++) {
      const candidate = rules[i]
      if (candidate === undefined) continue
      candidate.re.lastIndex = pos
      const match = candidate.re.exec(code)
      const matched = match === null ? undefined : match[0]
      if (matched !== undefined && matched !== '') {
        hit = candidate
        text = matched
        break
      }
    }
    if (hit === undefined) {
      pos++
      continue
    }
    if (plainFrom < pos) out.push({ kind: 'plain', text: code.slice(plainFrom, pos) })
    out.push({ kind: hit.kind, text })
    pos += text.length
    plainFrom = pos
  }
  if (plainFrom < end) out.push({ kind: 'plain', text: code.slice(plainFrom) })
  return out
}

/**
 * Tokenize a fenced code body. Never throws: an unknown or missing language falls
 * back to a single `plain` run, and the token texts concatenated equal `code`.
 */

/**
 * Declaration forms whose parameter list can be located WITHOUT a parser.
 *
 * Only unambiguous constructs are listed. A bare `f(a, b)` is deliberately absent:
 * it is a call, and native paints those arguments with the ordinary identifier
 * colour (`variable.parameter.function` is scoped to DECLARATIONS).
 */
const PARAM_DECLS: Readonly<Record<string, readonly RegExp[]>> = {
  // ts also serves js/tsx (LANG_ALIAS folds them together)
  ts: [
    /\bfunction\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g,
    /\(([^()]*)\)\s*(?::[^=(){}]*)?=>/g,
  ],
  py: [/\bdef\s+[A-Za-z_]\w*\s*\(([^)]*)\)/g],
  // the optional receiver group is why capture indices are used, not indexOf('(')
  go: [/\bfunc\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\(([^)]*)\)/g],
  rust: [/\bfn\s+[A-Za-z_]\w*\s*\(([^)]*)\)/g],
}

const IDENT_ONLY = /^[A-Za-z_$][\w$]*$/

/**
 * Re-tag identifiers that sit inside a declaration's parameter list as `param`.
 *
 * Runs as a POST-PASS over the finished token list rather than as a lexer rule:
 * the lexer has no memory, and this decision needs the surrounding construct. It
 * never splits a token — a parameter is only re-tagged when the WHOLE token falls
 * inside the list — so it cannot corrupt neighbouring highlighting.
 *
 * @param code - the exact source the tokens were produced from.
 * @param tokens - finished tokens, mutated in place.
 * @param lang - the normalised language id.
 * @returns the same token array, for chaining.
 */
function markParameters(code: string, tokens: HighlightToken[], lang: string): HighlightToken[] {
  const decls = PARAM_DECLS[lang]
  if (decls === undefined || tokens.length === 0) return tokens
  const spans: Array<[number, number]> = []
  for (const decl of decls) {
    // `d` gives exact capture offsets, so a Go receiver paren cannot shift the span.
    const re = new RegExp(decl.source, decl.flags + 'd')
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      const group = m[1]
      if (group === undefined || group === '') continue
      const start = m.indices?.[1]?.[0]
      if (start === undefined) continue
      for (const id of group.matchAll(/[A-Za-z_$][\w$]*/g)) {
        // Only parameter NAMES. A type annotation inside the list is a different
        // token in native, so it must not be re-tagged:
        //   `a: i32`   (Rust/TS/Python) — preceded by the annotation colon
        //   `a int`    (Go)             — preceded by the previous identifier
        const before = group.slice(0, id.index)
        if (/:\s*$/.test(before)) continue
        if (/[A-Za-z_$][\w$]*\s*$/.test(before)) continue
        spans.push([start + id.index, start + id.index + id[0].length])
      }
    }
  }
  if (spans.length === 0) return tokens
  // Build a new list rather than mutating: `HighlightToken.kind` is readonly, and
  // the caller caches the result, so shared mutable tokens would be a hazard.
  let offset = 0
  let changed = false
  const out = tokens.map((token) => {
    const from = offset
    offset += token.text.length
    if ((token.kind !== 'plain' && token.kind !== 'type') || !IDENT_ONLY.test(token.text)) return token
    if (!spans.some(([a, b]) => from >= a && offset <= b)) return token
    changed = true
    return { kind: 'param' as HighlightKind, text: token.text }
  })
  return changed ? out : tokens
}

export function tokenizeCode(code: string, lang = ''): HighlightToken[] {
  if (code === '') return []
  const rules = resolveRules(code, lang)
  if (rules === undefined || code.length > MAX_HIGHLIGHT_CHARS) return [{ kind: 'plain', text: code }]
  return markParameters(code, runRules(code, rules), normalizeLang(lang) ?? lang)
}

/** Token palette — DSH theme aliases only, no hard-coded colours. */

/** Cheap 32-bit hash — enough to key a render cache, never used for correctness. */
function hashCode(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const HL_CACHE_LIMIT = 64
const HL_CACHE = new Map<string, readonly ReactNode[]>()

/**
 * Highlight a code body into React text/element nodes. Model output is only ever
 * placed in text nodes, so it can never become markup (no HTML injection).
 *
 * Exported for the tool row's code surfaces (code variant, diff rows, read
 * lines), which reuse this tokenizer instead of growing a second highlighter.
 */
export function highlightCode(code: string, lang: string): ReactNode {
  if (code === '') return ''
  // Oversized bodies render as one plain run and are never cached, which also
  // bounds the cache's retained memory.
  if (code.length > MAX_HIGHLIGHT_CHARS) return code
  // The key used to be the ENTIRE code text: a streaming block inserted a brand-new key per token
  // and evicted every other entry, so the cache was a net loss in exactly the case it exists for —
  // and it retained a full copy of every keyed body (~2.6 MB worst case) in a module singleton.
  const cacheKey = `${lang}\u0000${code.length}\u0000${hashCode(code)}`
  const cached = HL_CACHE.get(cacheKey)
  if (cached !== undefined) return cached
  const tokens = tokenizeCode(code, lang)
  const nodes: ReactNode[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === undefined) continue
    // Per-KIND class, not a 5-alias inline style.
    //
    // `TOKEN_STYLE` collapsed the tokenizer's 14 kinds onto five DSH aliases, so a
    // type name and a keyword came out the same colour and `operator` borrowed the
    // function colour. The `.ac-hl-<kind>` sheet has one rule per kind, generated
    // from the theme bundle's shiki variables (`regen-css.mjs`), so this now matches
    // what the line-level path (diff rows / read lines) already did.
    nodes.push(
      token.kind === 'plain'
        ? token.text
        : <span key={i} className={`ac-hl ac-hl-${token.kind}`}>{token.text}</span>,
    )
  }
  if (HL_CACHE.size >= HL_CACHE_LIMIT) {
    const oldest = HL_CACHE.keys().next()
    if (oldest.done !== true) HL_CACHE.delete(oldest.value)
  }
  HL_CACHE.set(cacheKey, nodes)
  return nodes
}

// ── GFM tables ────────────────────────────────────────────────────────────────
//
// A table is only a table because of its DELIMITER row. A line that merely contains
// a `|` must stay a paragraph: prose like "内容 | 数量" is common, and a table whose
// header has streamed but whose delimiter has not must not flash a broken grid. So
// the parser commits only when header and delimiter agree on the column count.

export type TableAlign = 'left' | 'center' | 'right' | undefined

export interface ParsedTable {
  readonly header: readonly string[]
  readonly aligns: readonly TableAlign[]
  readonly rows: readonly (readonly string[])[]
  /** Index of the first line AFTER the table. */
  readonly end: number
}

/** Does this line carry a `|` that is not escaped as `\|`? */
function hasUnescapedPipe(line: string): boolean {
  return line.replace(/\\\|/g, '').includes('|')
}

/**
 * Split one GFM table row into trimmed cells.
 *
 * `\|` is a literal pipe, and GFM applies that escape inside other inline spans too
 * (spec example 200: `` b `\|` az `` renders a literal pipe), which is why this
 * splits on unescaped pipes only rather than tracking backtick spans first. A
 * leading or trailing pipe is a boundary marker, never an empty cell.
 */
export function splitTableRow(line: string): string[] | undefined {
  let s = line.trim()
  if (s === '') return undefined
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? ''
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

/**
 * Parse a delimiter row (`|---|:--:|`) into one alignment per column.
 *
 * Undefined when ANY cell is not a valid delimiter, so a row that merely contains
 * dashes can never be read as one.
 */
export function parseTableDelimiter(line: string): TableAlign[] | undefined {
  const cells = splitTableRow(line)
  if (cells === undefined) return undefined
  const aligns: TableAlign[] = []
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return undefined
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : undefined)
  }
  return aligns.length > 0 ? aligns : undefined
}

/**
 * Try to read a table starting at `start`. Null means "not a table": the caller then
 * handles the lines exactly as it did before tables existed, i.e. as a paragraph.
 */
export function tryParseTable(lines: readonly string[], start: number): ParsedTable | null {
  const headerLine = lines[start]
  const delimiterLine = lines[start + 1]
  if (headerLine === undefined || delimiterLine === undefined) return null
  if (!hasUnescapedPipe(headerLine) || !hasUnescapedPipe(delimiterLine)) return null
  const header = splitTableRow(headerLine)
  const aligns = parseTableDelimiter(delimiterLine)
  if (header === undefined || aligns === undefined) return null
  // GFM: the delimiter row must have exactly as many cells as the header row.
  if (header.length === 0 || header.length !== aligns.length) return null
  const rows: string[][] = []
  let i = start + 2
  while (i < lines.length) {
    const line = lines[i] ?? ''
    // The body ends at a blank line, or at the first line with no unescaped pipe.
    // Requiring the pipe is what stops a following paragraph being eaten as a row.
    if (line.trim() === '' || !hasUnescapedPipe(line)) break
    const cells = splitTableRow(line)
    if (cells === undefined) break
    const row = cells.slice(0, header.length)
    // GFM keeps the grid rectangular: missing cells stay empty, extras are dropped.
    while (row.length < header.length) row.push('')
    rows.push(row)
    i++
  }
  return { header, aligns, rows, end: i }
}

// ── block ─────────────────────────────────────────────────────────────────────

function MarkdownView({ text, dense = false }: MarkdownProps) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  const para = (buf: string[]) => {
    if (buf.length === 0) return
    blocks.push(
      <p key={`p${key++}`} style={{ ...paragraph, ...(dense ? denseText : null) }}>
        {renderInline(buf.join('\n'), `p${key}`)}
      </p>,
    )
  }

  /**
   * A parsed table is pure chrome: every cell goes through the SAME `renderInline`
   * the paragraphs use, so inline code, bold and links behave identically inside a
   * cell (and nothing here can turn model output into markup).
   *
   * The structure is the native markdown renderer's, transcribed from the shipped
   * bundle (`renderTable` in dsh-client-ui-chat):
   *   · wrapper class = `tableScroll` + (`md-table-wide` when ≥4 columns, else
   *     `tableFill`) — under four columns the table FILLS the column, at four or more
   *     it keeps its natural width and scrolls;
   *   · only a `md-table-wide` wrapper is keyboard focusable (`tabIndex=0`), because
   *     only that one can scroll;
   *   · per-column alignment is an INLINE `textAlign` on each cell, exactly as the
   *     native `renderTableRow` does it — not a class, so it cannot be lost by a
   *     stylesheet that fails to load.
   */
  const renderTable = (table: ParsedTable, k: string): ReactNode => {
    // Native: `wide = columnCount >= 4 && not in a blockquote`. This parser does not
    // nest blocks inside blockquotes, so only the column test applies.
    const wide = table.header.length >= 4
    return (
      <div
        className={wide ? 'ac-table-scroll md-table-wide' : 'ac-table-scroll ac-table-fill'}
        {...(wide ? { tabIndex: 0 } : {})}
      >
        <table data-md-table="">
          <thead>
            <tr>
              {table.header.map((cell, c) => (
                <th
                  key={c}
                  className="ac-table-th"
                  data-align={table.aligns[c] ?? undefined}
                  {...(table.aligns[c] !== undefined ? { style: { textAlign: table.aligns[c] } } : {})}
                >
                  {renderInline(cell, `${k}-h${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          {table.rows.length > 0 && (
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className="ac-table-td"
                      data-align={table.aligns[c] ?? undefined}
                      {...(table.aligns[c] !== undefined ? { style: { textAlign: table.aligns[c] } } : {})}
                    >
                      {renderInline(cell, `${k}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
    )
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // fenced code block
    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence !== null) {
      const lang = fence[1] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i++
      }
      i++ // closing fence
      blocks.push(
        <pre key={`c${key++}`} style={codeBlock}>
          {lang !== '' && <div style={codeLang}>{lang}</div>}
          <code style={{ fontFamily: 'inherit' }}>{highlightCode(body.join('\n'), lang)}</code>
        </pre>,
      )
      continue
    }

    // ATX heading
    const head = /^(#{1,6})\s+(.*)$/.exec(line)
    if (head !== null) {
      const level = (head[1] ?? '#').length
      blocks.push(
        <div key={`h${key++}`} style={{ ...heading, fontSize: dense ? headingSizeCompact(level) : headingSize(level) }}>
          {renderInline(head[2] ?? '', `h${key}`)}
        </div>,
      )
      i++
      continue
    }

    // GFM table. Checked before the horizontal rule so a delimiter row can never be
    // eaten by the `---` rule; `tryParseTable` returns null unless the NEXT line is
    // a real delimiter row, so an ordinary paragraph is untouched.
    const table = tryParseTable(lines, i)
    if (table !== null) {
      blocks.push(<div key={`tb${key++}`}>{renderTable(table, `tb${key}`)}</div>)
      i = table.end
      continue
    }

    // horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push(<hr key={`r${key++}`} style={rule} />)
      i++
      continue
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote key={`q${key++}`} style={quote}>
          {renderInline(body.join('\n'), `q${key}`)}
        </blockquote>,
      )
      continue
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={`u${key++}`} style={list}>
          {items.map((it, idx) => (
            <li key={idx} style={listItem}>
              <span style={bullet}>•</span>
              <span>{renderInline(it, `u${key}-${idx}`)}</span>
            </li>
          ))}
        </ul>,
      )
      continue
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={`o${key++}`} style={list}>
          {items.map((it, idx) => (
            <li key={idx} style={listItem}>
              <span style={bullet}>{idx + 1}.</span>
              <span>{renderInline(it, `o${key}-${idx}`)}</span>
            </li>
          ))}
        </ol>,
      )
      continue
    }

    // paragraph (blank line ends it)
    if (/^\s*$/.test(line)) {
      i++
      continue
    }
    const buf: string[] = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i] ?? '') &&
      !/^\s*```/.test(lines[i] ?? '') &&
      !/^(#{1,6})\s+/.test(lines[i] ?? '') &&
      !/^\s*>\s?/.test(lines[i] ?? '') &&
      !/^\s*[-*+]\s+/.test(lines[i] ?? '') &&
      !/^\s*\d+[.)]\s+/.test(lines[i] ?? '') &&
      // A table may interrupt a paragraph (GFM), so a header+delimiter pair inside
      // the buffer has to end it — otherwise the whole table would be one <p>.
      tryParseTable(lines, i) === null
    ) {
      buf.push(lines[i] ?? '')
      i++
    }
    para(buf)
  }

  // ── THE COLUMN MUST BE ALLOWED TO BE NARROWER THAN ITS CONTENT ──────────────
  //
  // A single-column grid with an `auto` track sizes it to the LARGEST min-content of
  // its items, and a GFM table is a plain `<div>` item whose min-content is driven by
  // `th/td{min-width:100px}` — roughly 132px per column. A 4-column table therefore
  // forced the track to ~512px inside a ~334px message column, the table's own
  // `max-width:100%` wrapper resolved against that already-inflated area (so it never
  // scrolled internally), and the transcript grew a horizontal scrollbar: the reported
  // "message content wider than the container".
  //
  // `minmax(0, 1fr)` lets the track shrink to the column and pushes the overflow back
  // into the wrapper, which scrolls internally as designed. `overflowWrap` gives the
  // non-answer paths (`.ac-think-body`, `.ac-web-answer`) the same break-anywhere
  // behaviour the answer path already inherits from `bodyText`, so an unbreakable token
  // in a heading / list / quote cannot widen the column either.
  return (
    <div style={{
      display: 'grid',
      gap: 8,
      minWidth: 0,
      gridTemplateColumns: 'minmax(0, 1fr)',
      overflowWrap: 'anywhere',
    }}>
      {blocks}
    </div>
  )
}

// ── styles ────────────────────────────────────────────────────────────────────

function headingSize(level: number): number {
  return [18, 16, 15, 14, 14, 13][level - 1] ?? 14
}
function headingSizeCompact(level: number): number {
  return [15, 14, 13, 13, 13, 12][level - 1] ?? 13
}

const paragraph: CSSProperties = {
  margin: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}
const denseText: CSSProperties = { fontSize: 13, lineHeight: '20px' }
const heading: CSSProperties = {
  margin: 0,
  fontWeight: 600,
  lineHeight: '24px',
  color: 'var(--dsw-alias-label-primary)',
}
const codeBlock: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  borderRadius: 'var(--dsw-radius-md, 8px)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-base)',
  fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: 12.5,
  lineHeight: '19px',
  whiteSpace: 'pre',
  overflowX: 'auto',
  color: 'var(--dsw-alias-label-primary)',
}
const codeLang: CSSProperties = {
  marginBottom: 6,
  fontSize: 10,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--dsw-alias-label-tertiary)',
}
const inlineCode: CSSProperties = {
  padding: '1px 5px',
  borderRadius: 4,
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-base)',
  fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: '0.92em',
}
const link: CSSProperties = {
  color: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary))',
  textDecoration: 'underline',
}
const rule: CSSProperties = {
  margin: '2px 0',
  border: 0,
  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
}
const quote: CSSProperties = {
  margin: 0,
  padding: '4px 0 4px 10px',
  borderLeft: '2px solid var(--dsw-alias-border-l3)',
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'pre-wrap',
}
const list: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'grid',
  gap: 4,
}
const listItem: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'flex-start',
}
const bullet: CSSProperties = {
  flexShrink: 0,
  minWidth: 14,
  color: 'var(--dsw-alias-label-tertiary)',
}

/**
 * Memoised on two primitives: a transcript re-renders on every ledger tick, and without this every
 * markdown body in it was re-parsed and re-highlighted each time.
 */
export const Markdown = memo(MarkdownView)
