import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types.ts',
    client: 'src/client.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  outDir: 'lib',
  fixedExtension: false,
})
