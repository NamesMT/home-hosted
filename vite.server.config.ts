import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * The CLI, bundled into `dist/cli.js` so a published install needs neither TypeScript
 * nor the source tree. Dependencies stay external (they are real dependencies), and
 * everything under `#src/` is inlined into the one file.
 */
export default defineConfig({
  resolve: {
    alias: { '#src': `${root}src` },
  },
  ssr: {
    target: 'node',
  },
  build: {
    ssr: 'src/cli.ts',
    outDir: 'dist',
    emptyOutDir: true,
    // The bin shim and the daemon both run this file with `node`, so no shebang is
    // needed and the output stays readable for stack traces.
    minify: false,
    sourcemap: true,
    target: 'node22',
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)],
      output: {
        entryFileNames: 'cli.js',
        codeSplitting: false,
      },
    },
  },
})
