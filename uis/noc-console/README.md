# noc-console

An alternate UI for keyboard- and TUI-style operation, aimed at shortcuts wizards.

Actions are single keys, the shell keeps a help overlay behind `?`, and navigation uses `g`-prefixed
chords (`g s`, `g l`, `g v`, `g t`). The layout is a rail plus panes: servers, per-server config,
disk logs, host vitals, settings.

It ships as a release asset, not inside the npm package. `public/ui.json` names it `noc-console`
version `1.0.0`, what Settings shows once installed, and declares `repo`/`tag`/`asset` so the panel
can re-install the matching build on an upgrade. `../../docs/media/tour.gif` shows both UIs.

**Editing this UI means bumping that file**: raise `version` (patch for a fix, minor for a feature,
major only for a rewrite or restyle) and set `unix` to the commit's epoch seconds. `tag` names the
release that carries the build, and `build-uis.mjs` stamps it into the built copy — never chase a
release by hand-editing it, because a stale one makes `ui-update` re-install the same UI every boot.

## Run it in development

`pnpm dev` starts the panel (3999) and only the stock UI's dev server. For this UI, run the two
processes yourself:

```sh
pnpm run start                                           # panel on http://127.0.0.1:3999
pnpm exec vite --config uis/noc-console/vite.config.ts   # this UI
```

- The Vite dev server listens on `http://127.0.0.1:3998` (`strictPort: true`), the port from
  `uis/vite.shared.ts`; the stock UI shares it, so run one dev server at a time.
- `/api` is proxied to `http://127.0.0.1:3999`; prefix `HHOSTED_HOME=./.dev-state` for dev state.

## Build and check

- `node scripts/build-uis.mjs noc-console` builds into `uis/noc-console/dist`.
- `node scripts/build-uis.mjs noc-console --zip` also writes `uis/dist/home-hosted-ui-noc-console.zip`.
- `pnpm run build:uis` builds and zips every UI under `uis/`; the release attaches the zips.
- `pnpm run quickcheck` is eslint, `tsc` and `vue-tsc`; `pnpm test` runs the vitest suite (this UI has no `test/` directory yet).

## Install it into a running panel

- Settings → Interface, pick the zip, then Install UI and refresh.
- Or drop the build into `$HHOSTED_HOME/.ui` yourself (`index.html` at the root).
- Or `home-hosted ui-switch --asset home-hosted-ui-noc-console.zip` (or `--asset noc-console`).
- `home-hosted ui-update` re-installs the build for the running panel, since this UI declares
  `repo: NamesMT/home-hosted`.
- `home-hosted ui-revert` puts the stock panel back.

## Before you edit

- Vue 3 and Tailwind v4, built through `uis/vite.shared.ts`. Aliases: `@` is `uis/noc-console/src`, `@shared` is `src/shared`, `@server` is `src` (types only).
- Key handling is `src/composables/useKeymap.ts` and the shell `keydown` in `src/App.vue`.
- Views live in `src/views/`, panes in `src/components/`, shared state in `src/composables/`.
- The API and SSE contract is `../../docs/UI_CREATION.md`.
