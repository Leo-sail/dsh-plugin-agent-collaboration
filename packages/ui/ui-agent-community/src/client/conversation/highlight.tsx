/**
 * Reference-token highlighting, shared by the composer overlay and the sent
 * message bubble so a `/skill` reads identically before and after sending.
 */
import type { ReactNode } from 'react'

/**
 * Paint a draft with reference tokens in the link colour.
 *
 * Native colours a `/name` token against the trigger's lexicon; everything else keeps
 * the normal label colour. Only tokens that pass the same boundary + lexicon rules as
 * the send path are highlighted, so what looks like a reference is what actually
 * expands.
 */
const HIGHLIGHT_TOKEN_RE = /(^|\s)(\/)([\w-]+)/g

export function renderHighlighted(draft: string, names: ReadonlySet<string>): ReactNode {
  if (draft === '' || names.size === 0) return draft
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  HIGHLIGHT_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HIGHLIGHT_TOKEN_RE.exec(draft)) !== null) {
    const name = m[3] ?? ''
    if (!names.has(name)) continue
    const after = draft.slice(m.index + m[0].length)
    if (after !== '' && !/^\s/.test(after)) continue
    const lead = m[1] ?? ''
    const tokenStart = m.index + lead.length
    const tokenEnd = m.index + m[0].length
    if (tokenStart > last) out.push(draft.slice(last, tokenStart))
    out.push(<span key={key++} className="ac-composer-ref">{draft.slice(tokenStart, tokenEnd)}</span>)
    last = tokenEnd
  }
  if (out.length === 0) return draft
  if (last < draft.length) out.push(draft.slice(last))
  return out
}

