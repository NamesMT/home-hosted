# stock

The panel that ships inside the `home-hosted` npm package and is served by default.

A general-purpose browser panel for a home server: an overview dashboard, the server list,
per-server detail, logs and settings. The control plane serves `uis/stock/dist` as static
files; no build step runs on the server.

This is one of the two UIs in the repo; `../noc-console` is the alternate, and
`../../docs/media/tour.gif` shows both in context.

## Run it in development

`pnpm dev` starts the panel (`tsx watch`, port 3999) and this UI's Vite dev server together.

- Vite dev server: `http://127.0.0.1:3998`, from `uis/vite.shared.ts` (`strictPort: true`).
- `/api` is proxied to `http://127.0.0.1:3999`.
- Dev state goes to `.dev-state/`; UI edits hot-reload while the API keeps running.

## Build and check

- `node scripts/build-uis.mjs stock` builds into `uis/stock/dist`.
- `node scripts/build-uis.mjs stock --zip` also writes `uis/dist/home-hosted-ui-stock.zip`.
- `pnpm run build:uis` builds and zips every UI under `uis/`.
- `pnpm run build` builds the CLI plus this UI (`pnpm run build:ui`).
- `pnpm run quickcheck` is eslint, `tsc` and `vue-tsc`; `pnpm test` is vitest over `uis/stock/test/**`.

## Install it into a running panel

The stock UI is what a panel serves when no custom UI is installed. It can still be installed
from its release bundle:

- Settings → Interface, pick the zip, then Install UI and refresh.
- Or drop the build into `$HHOSTED_HOME/.ui` yourself (`index.html` at the root).
- Or `home-hosted ui-switch --asset home-hosted-ui-stock.zip` (a unique substring works: `--asset stock`).
- `home-hosted ui-revert` removes the custom UI and serves the packaged stock panel again.

## Before you edit

- Vue 3 and Tailwind v4, built through `uis/vite.shared.ts`.
- Aliases: `@` is `uis/stock/src`, `@shared` is `src/shared`, `@server` is `src` (types only;
  never import runtime server code into a UI).
- The API and SSE contract is `../../docs/UI_CREATION.md`. `src/lib/api.ts` and `src/lib/rpc.ts` are the clients.
- Views live in `src/views/`, the shell in `src/components/shell/`, settings in `src/components/settings/`.
- Tests live in `uis/stock/test/`; component tests mount under `// @vitest-environment happy-dom`.
