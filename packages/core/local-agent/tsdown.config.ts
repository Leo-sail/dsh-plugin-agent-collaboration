import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types.ts',
    // Internal entry: lets the A2 unit harness exercise the adapter with a fake driver.
    adapter: 'src/adapter.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  outDir: 'lib',
  fixedExtension: false,
})
