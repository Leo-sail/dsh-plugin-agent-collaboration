import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

const require = createRequire(import.meta.url)
const RAW_SUFFIX = '?raw'

/**
 * Vite-style `?raw` imports for the browser build: the caller gets the file's text as
 * a default export, which is how pdf.js's module worker source travels inside the
 * single-file client bundle instead of as a sibling asset the DSH loader would never
 * serve. TS declares the same modules in `src/client/preview/vendor.d.ts`.
 */
const rawAsset = {
  name: 'raw-asset',
  resolveId(source: string): string | null {
    if (!source.endsWith(RAW_SUFFIX)) return null
    return require.resolve(source.slice(0, -RAW_SUFFIX.length)) + RAW_SUFFIX
  },
  load(id: string): string | null {
    if (!id.endsWith(RAW_SUFFIX)) return null
    return `export default ${JSON.stringify(readFileSync(id.slice(0, -RAW_SUFFIX.length), 'utf8'))}`
  },
}

export default defineConfig([
  // Node-side host half
  {
    entry: { index: 'src/index.ts' },
    format: 'esm',
    dts: true,
    clean: true,
    outDir: 'lib',
    fixedExtension: false,
    platform: 'node',
  },
  // Browser client bundle — pure ESM; wrap-client.mjs post-processes into
  // window.__ModuleLoader__.load({id, factory}) format after this build step
  {
    entry: { client: 'src/client/index.ts' },
    format: 'esm',
    dts: false,
    clean: false,
    outDir: 'lib',
    fixedExtension: false,
    platform: 'browser',
    // The loader evaluates this bundle as a classic script, where `import.meta` is a
    // syntax error. pdf.js touches `import.meta.url` only in its Node canvas branch;
    // the worker source that legitimately uses it is a string, not module code.
    define: { 'import.meta.url': '""' },
    plugins: [rawAsset],
    external: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-workspace',
      '@dsh-plugin-agent-community/agent-community',
    ],
  },
])
