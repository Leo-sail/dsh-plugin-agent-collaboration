# Third-party notices

The **browser half** of `@dsh-plugin-agent-community/ui-agent-community` bundles the libraries
below into its single-file client bundle (`lib/client.js`), because the DSH client module system
serves exactly one script per plugin and re-reads no sibling assets. Their licenses apply to those
portions of that artifact; the Node-side packages ship no third-party code.

| Library | Version | License | Upstream |
| --- | --- | --- | --- |
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 6.3.289 | Apache-2.0 | Mozilla |
| [docx-preview](https://github.com/zVolodymyr/docxjs) | 0.3.7 | Apache-2.0 | Volodymyr Baydalka |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.2 | MIT (dual-licensed MIT / GPLv3; used under MIT) | Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso |
| [SheetJS Community Edition](https://github.com/SheetJS/sheetjs) (`xlsx`) | 0.18.5 | Apache-2.0 | SheetJS LLC |

The complete license texts are distributed with each npm package under `node_modules/<package>/`
in a checkout, and in the upstream repositories linked above. No code from these projects is
modified beyond normal bundling (tree-shaking, minification already present in the pdf.js build).

PDF.js note: the plugin inlines the PDF.js **worker** module source as a string and starts it as a
Blob-URL module worker. That is the same deployment shape PDF.js itself supports; the worker is
unmodified. The plugin bundles no PDF.js standard fonts, CMaps or WASM decoders — PDFs that rely on
non-embedded standard fonts use the browser's system fonts, and exotic image codecs may warn.
