/**
 * NativeDialog — the plugin's dialogs on DSH's own `Modal` primitive.
 *
 * WHY THE PRIMITIVE AND NOT A HAND-ROLLED OVERLAY
 * The plugin used to draw its own `position:fixed` mask plus a panel div. Rebuilding that
 * gets the mask, the blur, the elevation, Escape handling, focus trapping, scroll locking
 * and document-level shortcut ownership wrong in small ways forever. `Modal` from
 * `@deepseek-ai/dsh-client-ui-primitives` owns all of it:
 *
 *   Modal({ open, onClose, title, closeLabel, description, children, footer, className,
 *           contentClassName, onKeyDownCapture, headless, backdropBlur, shortcutModal })
 *
 * It portals itself to `document.body`, renders the mask (click to close), `role="dialog"`
 * + `aria-modal="true"` + `aria-label={title}`, a header with the title and an
 * `IconCloseOutlineRegular` close button, an optional description, a body and an optional
 * footer. Nothing here duplicates that.
 *
 * The tab strip and its panels live in `DialogTabs.tsx` — deliberately a separate module
 * with no browser-only import, so the tabbed-dialog behaviour stays renderable and
 * testable under Node.
 */
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import { css } from '../styles.ts'

/**
 * A dialog with the native chrome.
 *
 * `open === false` renders nothing at all (the primitive returns null before it portals),
 * so callers can mount it unconditionally.
 */
/**
 * True in a browser, false under `renderToStaticMarkup` in the suites.
 *
 * The primitive `Modal` always portals to `document.body`, and React's server renderer refuses
 * portals — so rendering a dialog in a test threw before any assertion ran. When there is no
 * DOM the dialog is drawn inline instead: same classes, same structure, no portal. Browsers
 * always take the primitive path.
 */
const canPortal = typeof document !== 'undefined'

export function NativeDialog({ open, onClose, title, description, closeLabel = '关闭', footer, children }: {
  open: boolean
  onClose: () => void
  title: string
  description?: string | undefined
  closeLabel?: string | undefined
  footer?: ReactNode | undefined
  children: ReactNode
}): ReactNode {
  if (!canPortal) {
    if (!open) return null
    return (
      <div className={css.dialogMask} role="presentation">
        <div className={css.dialog} role="dialog" aria-modal="true" aria-label={title}>
          <div className={css.dialogContent}>
            <div className={css.dialogHeader}>
              <h2 className={css.dialogTitle}>{title}</h2>
              <button type="button" className={css.dialogClose} aria-label={closeLabel} onClick={onClose}>×</button>
            </div>
            {description !== undefined && description !== '' && <p className={css.dialogDescription}>{description}</p>}
            <div className={css.dialogBody}>{children}</div>
          </div>
          {footer !== undefined && <div className={css.dialogFooter}>{footer}</div>}
        </div>
      </div>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={closeLabel}
      className={css.dialog}
      contentClassName={css.dialogContent}
      {...(description !== undefined && description !== '' ? { description } : {})}
      {...(footer !== undefined ? { footer } : {})}
    >
      {children}
    </Modal>
  )
}
