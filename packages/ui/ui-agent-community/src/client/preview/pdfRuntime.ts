/**
 * The pdf.js runtime behind the in-panel PDF viewer.
 *
 * pdf.js normally loads its worker from a sibling script; the DSH client loader serves
 * exactly one JS file, so that asset would never resolve. Two build facts make the
 * inlined setup below work, and both were verified in a headless-Chrome proof of concept
 * before this file was written:
 *
 * 1. The worker module source travels inside the bundle as a `?raw` string (the `rawAsset`
 *    plugin in `tsdown.config.ts`, declared to TypeScript in `vendor.d.ts`). Here it is
 *    turned into a Blob URL and started as a `{ type: 'module' }` Worker. A ready message is
 *    appended to the worker source so the main thread knows when the module has actually
 *    evaluated — the port-based worker otherwise has no public readiness signal.
 * 2. The caller's `ArrayBuffer` is copied before it reaches `getDocument`, because pdf.js
 *    transfers the backing buffer to the worker. Without the copy the preview prop would be
 *    detached after the first open, and switching back to the same file would see an empty
 *    buffer.
 *
 * The runtime owns one Worker, one document loading task and at most one render task. All of
 * them are torn down through `dispose()`, which is idempotent and safe at any point in the
 * lifecycle; that is what keeps React StrictMode remounts and fast preview-tab switches from
 * leaking workers or leaving stale renders pointed at a canvas that has been unmounted.
 *
 * Failures are normalised to `PdfError` with a Chinese user-facing message, so the component
 * never has to interpret pdf.js's exception classes or English messages.
 */
import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'
import type {
  OnProgressParameters,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist'

/**
 * Sent by the appended line of the inlined worker source once the worker module is live.
 * pdf.js's own "ready" messages belong to its private MessageHandler and are not observable
 * before `getDocument` is called, hence this extra signal.
 */
const WORKER_READY = 'agent-community:pdf-worker-ready'

/** The blob worker must evaluate quickly; a hung worker would otherwise be an endless spinner. */
const WORKER_TIMEOUT_MS = 15_000

/** Manual zoom is clamped to a sane range; fit-width may shrink a large page further. */
export const MIN_PDF_SCALE = 0.02
export const MAX_PDF_SCALE = 8

/** devicePixelRatio is clamped to keep a mis-reported ratio from allocating a huge canvas. */
const MAX_PIXEL_RATIO = 4

/**
 * Backing-store budget for one page render (~80 MB at four bytes per pixel).
 *
 * A 500 % zoom of an A4 page at DPR 3 would otherwise allocate a canvas large enough to
 * fail on lower-end GPUs; when the requested ratio would exceed this budget the backing
 * store is scaled down (CSS size keeps its true zoom, so the page just renders softer).
 */
const MAX_CANVAS_PIXELS = 20_000_000

/** One in-flight render; `cancelled` is flipped before the task is cancelled. */
interface RenderToken {
  cancelled: boolean
  task: RenderTask | null
}

/** States failure classes the viewer renders with different Chinese copy. */
export type PdfErrorKind =
  | 'password'
  | 'invalid'
  | 'missing'
  | 'worker'
  | 'timeout'
  | 'render'
  | 'range'
  | 'unknown'

const USER_MESSAGES: Record<PdfErrorKind, string> = {
  password: '该 PDF 已加密，需要密码才能打开，暂时无法预览。',
  invalid: 'PDF 文件已损坏或格式无法识别，无法预览。',
  missing: '读取 PDF 数据失败，文件可能已被移动或删除。',
  worker: 'PDF 预览组件启动失败，请重试或使用应用打开。',
  timeout: 'PDF 加载超时，请重试。',
  render: '这一页渲染失败，请重试。',
  range: '页码超出范围。',
  unknown: 'PDF 预览失败，请重试或使用应用打开。',
}

/** A classified preview failure: `message` is technical, `userMessage` is what the viewer shows. */
export class PdfError extends Error {
  readonly kind: PdfErrorKind
  readonly userMessage: string

  constructor(kind: PdfErrorKind, message: string, userMessage: string = USER_MESSAGES[kind]) {
    super(message)
    this.name = 'PdfError'
    this.kind = kind
    this.userMessage = userMessage
  }
}

/**
 * Thrown when the runtime was disposed (or a newer render superseded the current one) before
 * the operation could finish. Callers treat it as "ignore, the viewer has moved on".
 */
export class PdfDisposedError extends Error {
  constructor(message = 'PDF runtime disposed before the operation completed.') {
    super(message)
    this.name = 'PdfDisposedError'
  }
}

/** Map a pdf.js exception (or any thrown value) to a `PdfError`. */
export function toPdfError(error: unknown, fallbackKind: PdfErrorKind = 'unknown'): PdfError {
  if (error instanceof PdfError) return error
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  switch (name) {
    case 'PasswordException':
      return new PdfError('password', message)
    case 'InvalidPDFException':
      return new PdfError('invalid', message)
    case 'MissingPDFException':
    case 'UnexpectedResponseException':
    case 'ResponseException':
      return new PdfError('missing', message)
    default:
      return new PdfError(fallbackKind, message === '' ? 'Unknown PDF failure.' : message)
  }
}

/** CSS-pixel size of one page at scale 1 (rotation already applied). */
export interface PdfPageSize {
  readonly width: number
  readonly height: number
}

export interface PdfRuntimeOptions {
  /** Called while the document is parsed; `total` is 0 when pdf.js cannot report a total. */
  readonly onProgress?: (loaded: number, total: number) => void
}

/**
 * One document's pdf.js lifetime: worker + loading task + page renders.
 *
 * `open()` is idempotent, and `dispose()` may be called before, during or after it. All
 * operations reject with `PdfDisposedError` once disposed; the component treats that as a
 * no-op rather than an error worth showing.
 */
export class PdfRuntime {
  #bytes: ArrayBuffer
  #options: PdfRuntimeOptions
  #abort = new AbortController()
  #blobUrl: string | null = null
  #worker: Worker | null = null
  #loading: PDFDocumentLoadingTask | null = null
  #pdf: PDFDocumentProxy | null = null
  #opening: Promise<PDFDocumentProxy> | null = null
  #disposed = false
  #pagePromises = new Map<number, Promise<PDFPageProxy>>()
  #pageSizes = new Map<number, PdfPageSize>()
  #renderToken: RenderToken | null = null

  constructor(bytes: ArrayBuffer, options: PdfRuntimeOptions = {}) {
    this.#bytes = bytes
    this.#options = options
  }

  /** True once `dispose()` ran; no further work will be accepted. */
  get disposed(): boolean {
    return this.#disposed
  }

  /** Page count, or 0 before the document finished loading. */
  get numPages(): number {
    return this.#pdf?.numPages ?? 0
  }

  /** Parse the document (idempotent). The returned promise is shared by every caller. */
  open(): Promise<PDFDocumentProxy> {
    if (this.#disposed) return Promise.reject(new PdfDisposedError())
    if (this.#pdf !== null) return Promise.resolve(this.#pdf)
    this.#opening ??= this.#start()
    return this.#opening
  }

  /** Size of `pageNumber` at scale 1, cached per page. */
  async pageSize(pageNumber: number): Promise<PdfPageSize> {
    if (this.#disposed) throw new PdfDisposedError()
    const cached = this.#pageSizes.get(pageNumber)
    if (cached !== undefined) return cached
    const pdf = await this.open()
    if (this.#disposed) throw new PdfDisposedError()
    const page = await this.#getPage(pdf, pageNumber)
    if (this.#disposed) throw new PdfDisposedError()
    const viewport = page.getViewport({ scale: 1 })
    const size: PdfPageSize = { width: viewport.width, height: viewport.height }
    this.#pageSizes.set(pageNumber, size)
    return size
  }

  /**
   * Render one page at `scale` CSS pixels per PDF unit into `canvas`.
   *
   * The canvas' CSS box is the unscaled viewport; its backing store is multiplied by
   * `pixelRatio` and the context is transformed to match, which is the DPR-correct pattern
   * for pdf.js (the viewport itself stays in CSS pixels). Any previous render is cancelled
   * first, so only one render task can ever be alive.
   */
  async render(pageNumber: number, scale: number, canvas: HTMLCanvasElement, pixelRatio: number): Promise<PdfPageSize> {
    if (this.#disposed) throw new PdfDisposedError()
    if (!(scale > 0) || !Number.isFinite(scale)) throw new PdfError('range', `Invalid PDF scale: ${String(scale)}.`)
    this.cancelRender()
    const token: RenderToken = { cancelled: false, task: null }
    this.#renderToken = token
    try {
      const pdf = await this.open()
      if (token.cancelled || this.#disposed) throw new PdfDisposedError()
      const page = await this.#getPage(pdf, pageNumber)
      if (token.cancelled || this.#disposed) throw new PdfDisposedError()

      const viewport = page.getViewport({ scale: clampScale(scale) })
      const ratio = backingRatio(viewport.width, viewport.height, pixelRatio)
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      const task = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
      token.task = task
      try {
        await task.promise
      } catch (error) {
        if (token.cancelled || this.#disposed || isRenderingCancelled(error)) throw new PdfDisposedError()
        throw toPdfError(error, 'render')
      }
      if (token.cancelled || this.#disposed) throw new PdfDisposedError()
      return { width: viewport.width, height: viewport.height }
    } finally {
      if (this.#renderToken === token) this.#renderToken = null
    }
  }

  /** Cancel the in-flight render (if any). Safe to call repeatedly. */
  cancelRender(): void {
    const token = this.#renderToken
    if (token === null) return
    this.#renderToken = null
    token.cancelled = true
    if (token.task !== null) {
      try {
        token.task.cancel()
      } catch {
        // The task already settled; cancellation is best-effort.
      }
    }
  }

  /**
   * Release everything this runtime owns: the worker (terminated), the Blob URL, the loading
   * task and the page cache. Exceptions during teardown are swallowed — teardown runs from
   * React unmount paths where throwing would mask the real cause of the unmount.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#abort.abort()
    this.cancelRender()

    const loading = this.#loading
    this.#loading = null
    if (loading !== null) void loading.destroy().catch(() => undefined)

    const worker = this.#worker
    this.#worker = null
    if (worker !== null) {
      try {
        worker.terminate()
      } catch {
        // Already terminated by the browser.
      }
    }

    const url = this.#blobUrl
    this.#blobUrl = null
    if (url !== null) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // revokeObjectURL is infallible in practice; keep teardown noise-free.
      }
    }

    this.#pdf = null
    this.#opening = null
    this.#pagePromises.clear()
    this.#pageSizes.clear()
  }

  /** Worker creation + readiness + document parse; the body of `open()`. */
  async #start(): Promise<PDFDocumentProxy> {
    try {
      // Copy: getDocument transfers this buffer to the worker, and the caller's ArrayBuffer
      // (a React prop that outlives this runtime) must stay usable for later remounts.
      const data = new Uint8Array(this.#bytes.slice(0))
      const blobUrl = URL.createObjectURL(new Blob(
        [workerSource, `\nself.postMessage({type:${JSON.stringify(WORKER_READY)}});\n`],
        { type: 'text/javascript' },
      ))
      this.#blobUrl = blobUrl
      const worker = new Worker(blobUrl, { type: 'module', name: 'agent-community-pdf' })
      this.#worker = worker

      await waitForWorkerReady(worker, this.#abort.signal)
      if (this.#disposed) throw new PdfDisposedError()

      const loading = pdfjs.getDocument({ data, worker: pdfjs.PDFWorker.create({ port: worker }) })
      this.#loading = loading
      // `onProgress` is typed as a bare `Function` by pdf.js, so the parameter type is explicit.
      loading.onProgress = (progress: OnProgressParameters): void => {
        if (this.#disposed) return
        this.#options.onProgress?.(progress.loaded, progress.total)
      }

      const pdf = await loading.promise
      if (this.#disposed) throw new PdfDisposedError()
      this.#pdf = pdf
      return pdf
    } catch (error) {
      if (this.#disposed || error instanceof PdfDisposedError) {
        this.dispose()
        throw new PdfDisposedError()
      }
      this.dispose()
      throw toPdfError(error)
    }
  }

  /** Get a page proxy, caching the promise and evicting it again if the page failed to load. */
  async #getPage(pdf: PDFDocumentProxy, pageNumber: number): Promise<PDFPageProxy> {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
      throw new PdfError('range', `Page ${String(pageNumber)} is outside 1..${pdf.numPages}.`)
    }
    const cached = this.#pagePromises.get(pageNumber)
    if (cached !== undefined) return cached
    const promise = pdf.getPage(pageNumber)
    this.#pagePromises.set(pageNumber, promise)
    // Attach a handler so a rejection is never "unhandled"; evict so a retry re-fetches.
    promise.catch(() => {
      if (this.#pagePromises.get(pageNumber) === promise) this.#pagePromises.delete(pageNumber)
    })
    return promise
  }
}

/** Resolve once the inlined worker module has evaluated (or reject on error/timeout/abort). */
function waitForWorkerReady(worker: Worker, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onMessageError)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown } | null
      if (data !== null && typeof data === 'object' && data.type === WORKER_READY) finish()
    }
    const onError = (event: ErrorEvent): void => {
      finish(new PdfError('worker', event.message === '' ? 'PDF worker failed to start.' : event.message))
    }
    const onMessageError = (): void => {
      finish(new PdfError('worker', 'PDF worker sent a message that could not be deserialized.'))
    }
    const onAbort = (): void => {
      finish(new PdfDisposedError())
    }
    const timer = window.setTimeout(() => {
      finish(new PdfError('timeout', `PDF worker did not start within ${WORKER_TIMEOUT_MS} ms.`))
    }, WORKER_TIMEOUT_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onMessageError)
  })
}

/** Clamp a scale into the supported range; non-finite values fall back to 100 %. */
function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return Math.min(MAX_PDF_SCALE, Math.max(MIN_PDF_SCALE, scale))
}

/**
 * The backing-store ratio for a canvas whose CSS size is `width` x `height` CSS pixels:
 * the requested DPR, reduced if necessary to stay inside `MAX_CANVAS_PIXELS`.
 */
function backingRatio(width: number, height: number, pixelRatio: number): number {
  const wanted = Number.isFinite(pixelRatio) && pixelRatio > 0
    ? Math.min(MAX_PIXEL_RATIO, Math.max(1, pixelRatio))
    : 1
  const area = width * height
  if (!(area > 0)) return wanted
  const pixels = area * wanted * wanted
  if (pixels <= MAX_CANVAS_PIXELS) return wanted
  return Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / area))
}

/** pdf.js rejects a cancelled render with a RenderingCancelledException; that is not a failure. */
function isRenderingCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException'
}
