# noc-console

An alternate UI for keyboard- and TUI-style operation, aimed at shortcuts wizards — and usable on a
phone, which is the one place those shortcuts are not.

Actions are single keys, the shell keeps a help overlay behind `?`, and navigation uses `g`-prefixed
chords. Two groups sit in the rail: **global** (`g o` global overview, `g g` global settings) and the
selected **workspace** (`g s` servers, `g l` logs, `g t` workspace settings), with a workspace
switcher that creates, renames and deletes workspaces. Routes mirror the stock UI —
`/global/overview`, `/global/settings`, and `/w/<workspaceId>/servers|logs|settings` — and the
pre-workspace paths (`/servers`, `/logs`, `/settings`, `/vitals`) redirect to the canonical URL under
the selected workspace.

It ships as a release asset, not inside the npm package. `public/ui.json` names it `noc-console`
with the version Settings shows once installed, and declares `repo`/`asset` so the panel can
re-install the matching build on an upgrade. `../../docs/media/tour.gif` shows both UIs.

**Editing this UI means bumping that file**: raise `version` (patch for a fix, minor for a feature,
major only for a rewrite or restyle). `tag` and `unix` are not in it on purpose — `build-uis.mjs`
stamps both into the built copy, and a hand-maintained one is stale the moment the zip is cut.

## One language, on purpose

This UI is **English only**. It has no `i18n/` sheets and no language picker, so a browser that chose
German in the stock UI gets English here — measured: `hh.locale=de` leaves `document.documentElement.lang`
at `en` and every nav row in English. That is the same scope call the mobile-layout decision made
(`.agents/ralph/DECISIONS_NEEDED.md` item 5: leave this UI's own visual language alone, and say so
here): the console is a deliberately dense, shortcut-first alternative, and translating ~420 text
nodes plus a second catalog is a port, not a fix. The stock UI carries the translations.

## On a phone

Below `860px` the density stays; what changes is where the width goes.

- **The nav fits.** Under `640px` the secondary pages (`global settings`, workspace settings, reverse
  proxy, keyboard, sign out) move behind `more`; above it they wrap as ordinary rows. Never a hidden
  horizontal scroll — a row that scrolls with no signal reads as a clipped row.
- **Tables scroll sideways, and say so.** Identity and action columns are pinned, with an edge shadow
  on the side that still has content. The stacked layout drops the per-row `s x r e` buttons — the
  same four actions are full size in the detail pane one tap below.
- **The status line keeps its live state.** The `j k` / `s` / `x` hint is hidden unless the pointer
  can hover.

Every control is at least 24 px at normal density and 44 px under a coarse pointer
(`../tap-targets.css`, shared with the stock UI).

## The keyboard belongs to the overlay

While any dialog is open, single-key shortcuts act on **nothing behind it**: `x` does not stop the
server under a confirmation, and `j` does not move the selection it covers. `esc` closes the
topmost overlay and only that one, so a confirmation inside a page cannot dismiss the page's own
unsaved work. The console keeps one registry for this (`src/composables/useModalLayer.ts`) rather
than a listener per dialog, and `test/modal-overlay-scan.test.ts` fails a new overlay that does not
join it. The live-log drawer is not modal — it sits beside the page, so `j`/`s` stay live while it
is up.

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
- `pnpm run quickcheck` is eslint, `tsc` and `vue-tsc`; `pnpm test` runs the vitest suite, which
  includes `test/mobile-layout.test.ts` — a source scan, because happy-dom has no layout engine and
  a phone layout only breaks at a real viewport.

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
