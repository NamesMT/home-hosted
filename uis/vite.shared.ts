import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import vueDevTools from 'vite-plugin-vue-devtools'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Every UI under `uis/` is a Vite app rooted at its own directory; they share the
 * plugin set, the aliases and the dev proxy, and differ only in their source.
 * `@server` is types-only (the typed RPC client) — never import runtime server code.
 */
export function createUiConfig(uiDir: string) {
  return defineConfig(({ command }) => ({
    root: uiDir,
    plugins: [
      vue(),
      tailwindcss(),
      ...(command === 'serve' ? [vueDevTools()] : []),
    ],
    resolve: {
      alias: {
        '@': `${uiDir}src`,
        '@shared': `${repoRoot}src/shared`,
        '@server': `${repoRoot}src`,
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // These UIs are hand-rolled and small; one chunk keeps the first paint cheap.
      chunkSizeWarningLimit: 900,
    },
    server: {
      host: '127.0.0.1',
      port: 3998,
      strictPort: true,
      fs: { allow: [repoRoot] },
      proxy: {
        '/api': { target: 'http://127.0.0.1:3999', changeOrigin: false },
      },
    },
  }))
}
