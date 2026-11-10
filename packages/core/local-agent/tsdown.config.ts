import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  outDir: 'lib',
  fixedExtension: false,
})
