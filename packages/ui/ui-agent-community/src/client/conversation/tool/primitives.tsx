/**
 * Tool-row primitives — the four small pieces every card shares: the decorative-copy context, the
 * shimmer text, the inert marker and the copy-to-clipboard hook.
 *
 * Split out of ToolRow.tsx (see tool/toolModel.tsx for the non-visual half) so the card renderers and
 * the row dispatcher can share them without one 2,000-line file in between.
 *
 * @module
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import * as M from './toolModel.tsx'

export const DecorativeCopy = createContext<boolean | undefined>(undefined)

export function TextContent({ children, className }: { children: ReactNode; className?: string | undefined }) {
  const generated = useContext(DecorativeCopy) === true && typeof children === 'string'
  return (
    <span
      className={cx('ac-ts-text', className)}
      {...(generated ? { 'data-shimmer-text': children as string } : {})}
    >
      {generated ? null : children}
    </span>
  )
}

/** `TextShimmer`, `primitives/index.js:3116-3147`; visuals in `TextShimmer.module.css`. */

export function TextShimmer({ children, active = false, className }: {
  children: ReactNode
  active?: boolean
  className?: string | undefined
}) {
  if (useContext(DecorativeCopy) !== undefined) return <TextContent className={className}>{children}</TextContent>
  const content = typeof children === 'string' ? <TextContent>{children}</TextContent> : children
  return (
    <span className={cx('ac-ts-root', className)} data-shimmer={active || undefined}>
      <DecorativeCopy.Provider value={false}>
        <span className="ac-ts-content">{content}</span>
      </DecorativeCopy.Provider>
      {active && (
        <span className="ac-ts-decoration" aria-hidden="true" {...INERT}>
          <span className="ac-ts-sweep">
            <DecorativeCopy.Provider value={true}>
              <span className="ac-ts-content ac-ts-highlight">{content}</span>
            </DecorativeCopy.Provider>
          </span>
        </span>
      )}
    </span>
  )
}

/** React 18's types predate the `inert` attribute that native sets here. */

export const INERT = { inert: '' } as unknown as { readonly inert?: string | undefined }

/** Tiny `clsx` — no new dependency is allowed. */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' ')
}

/**
 * `toggleFromKeyboard`, `primitives/index.js:3162-3166`.
 *
 * Exported so the acceptance harness can prove both native guarantees without a
 * DOM: only `Enter` and `Space` toggle, and the default action is always
 * prevented (Space would otherwise scroll the transcript).
 */

export function handleDisclosureKeyDown(
  event: { readonly key: string; preventDefault: () => void },
  rowExpands: boolean,
  onToggle: () => void,
): void {
  if (!rowExpands || (event.key !== 'Enter' && event.key !== ' ')) return
  event.preventDefault()
  onToggle()
}

/** Clipboard feedback — primitives' `useCopyFeedback` contract (1s revert). */

export function useCopy(text: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    if (copied) return
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard === undefined) return
    void clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    }).catch(() => { /* native keeps a failed write silent */ })
  }, [copied, text])
  return [copied, copy]
}

/** Fire-and-forget clipboard write (the search card's copy control). */
export async function copyToClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard === undefined) return
  try { await clipboard.writeText(text) } catch { /* silent, like the native control */ }
}

/**
 * Per-line code renderer.
 *
 * Reuses the repo's tokenizer (`tokenizeCode`, the same one markdown code blocks
 * use) and paints every token with the native shiki scope variables, so a tool
 * line carries the native CodeBlock palette instead of a plugin-invented one.
 * Whole-block surfaces use {@link highlightCode} directly.
 */
