import { defineConfig } from 'tsdown'

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
      '@dsh-plugin/agent-community',
    ],
  },
])
