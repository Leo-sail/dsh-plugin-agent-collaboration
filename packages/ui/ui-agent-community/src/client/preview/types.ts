/**
 * Shared shapes for the in-panel file viewers (0.3.1's pdf.js / docx-preview / SheetJS).
 *
 * The dock and the fallback dialog both hand a viewer the finished bytes: reading,
 * size-capping, Office→PDF conversion and text paging all happen before this point,
 * so every viewer is a pure "bytes in, pixels out" component with no RPC of its own.
 */

/** Props every binary viewer receives. */
export interface ViewerProps {
  /** The exact file bytes (already fetched from the preview RPC or the host converter). */
  readonly bytes: ArrayBuffer
  /** Original file name, used for the loading/error text and the accessible labels. */
  readonly name: string
}

/** What the shared loader hands the content dispatcher. */
export type PreviewSource =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'missing'; readonly name: string }
  | { readonly kind: 'binary'; readonly size: number }
  | { readonly kind: 'image'; readonly dataUrl: string }
  | { readonly kind: 'text'; readonly text: string; readonly truncated: boolean }
  | { readonly kind: 'bytes'; readonly bytes: ArrayBuffer; readonly mime: string; readonly name: string }
