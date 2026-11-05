import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * `home-hosted/client` — the typed client for third-party tools. It imports the server only for
 * types, so the bundle is the client itself plus `hono/client`, left external (a dependency).
 */
export default defineConfig({
  resolve: { alias: { '#src': `${root}src` } },
  build: {
    lib: { entry: 'src/client.ts', formats: ['es'], fileName: () => 'client.js' },
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: { external: [/^hono(\/.*)?$/] },
  },
})
