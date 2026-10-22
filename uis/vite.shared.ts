import type { Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import vueDevTools from 'vite-plugin-vue-devtools'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Serves the brand's favicon from the one place it lives — `docs/branding/` — in dev and
 * in the build, instead of each UI carrying its own copy of the files.
 *
 * A copy was committed into every UI's `public/` before, which is two files to keep in
 * step with the brand by hand. A symlink is not the alternative: npm drops symlinks from
 * the tarball entirely, and a Windows checkout with `core.symlinks=false` writes a text
 * file holding the link target instead of the image.
 */
function brandFavicons(): Plugin {
  const brand = path.join(repoRoot, 'docs', 'branding')
  const files = { 'favicon.ico': 'favicon.ico', 'favicon.svg': 'logo-mark.svg' }

  return {
    name: 'hh:brand-favicons',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0]?.slice(1) ?? ''
        const source = files[name as keyof typeof files]
        if (source === undefined)
          return next()
        res.setHeader('Content-Type', name.endsWith('.svg') ? 'image/svg+xml' : 'image/x-icon')
        res.end(fs.readFileSync(path.join(brand, source)))
      })
    },
    generateBundle() {
      for (const [name, source] of Object.entries(files))
        this.emitFile({ type: 'asset', fileName: name, source: fs.readFileSync(path.join(brand, source)) })
    },
  }
}

/**
 * A dev UI proxies `/api` to the panel `pnpm dev` started. Both sit in the 6xxx
 * range by default, so a dev instance never fights an installed panel's 3999.
 * Override with `HHOSTED_DEV_UI_PORT` / `HHOSTED_DEV_PANEL`.
 */
const devUiPort = Number(process.env.HHOSTED_DEV_UI_PORT ?? 6001)
const devPanel = process.env.HHOSTED_DEV_PANEL ?? 'http://127.0.0.1:6000'

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
      brandFavicons(),
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
      port: devUiPort,
      strictPort: true,
      fs: { allow: [repoRoot] },
      proxy: {
        '/api': { target: devPanel, changeOrigin: false },
        /*
         * `/healthz` and `/openapi` are the panel's two unauthenticated, **non-`/api`** reads
         * (`docs/UI_CREATION.md`), and a UI reaches them same-origin. Proxying only `/api` meant
         * Vite answered `index.html` for both — so the stock UI's own panel-uptime tile read
         * `—` on every dev machine, and a UI author following the contract got an HTML page
         * where JSON was promised. Neither is visible from the panel's side, which is why it
         * survived: the defect only exists in the dev server.
         */
        '/healthz': { target: devPanel, changeOrigin: false },
        '/openapi': { target: devPanel, changeOrigin: false },
      },
    },
  }))
}
