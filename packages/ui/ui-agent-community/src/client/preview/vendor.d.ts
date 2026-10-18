/**
 * Ambient module declarations for the vendored viewer libraries.
 *
 * Three of the packages we bundle ship typings that do not line up with the exact
 * specifiers the browser bundle imports:
 *
 *   - `pdfjs-dist`'s `types` entry describes the package root, while its ESM browser
 *     build is the `build/pdf.min.mjs` subpath (and the worker is imported as raw
 *     text through this repo's `?raw` build plugin);
 *   - `xlsx`'s typings are written for the CommonJS entry, not the `xlsx.mjs` ESM
 *     build we bundle.
 *
 * Each shim re-exports the package's real typings, so viewer code is still checked
 * against the actual API instead of degrading to `any`.
 */
declare module 'pdfjs-dist/build/pdf.min.mjs' {
  export * from 'pdfjs-dist'
}

declare module 'pdfjs-dist/build/pdf.worker.min.mjs?raw' {
  /** The complete PDF.js worker module source, inlined at build time by the `?raw` plugin. */
  const source: string
  export default source
}

declare module 'xlsx/xlsx.mjs' {
  export * from 'xlsx'
}
