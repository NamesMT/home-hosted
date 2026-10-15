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

## Languages

The panel ships in English, Vietnamese, Chinese (zh-CN), Japanese, Spanish, Korean, Russian,
French and German. A person picks one on the login page or under **Global settings → Language**;
the choice is kept per browser (`hh.locale`, beside `hh.theme`) so it applies before sign-in.

Only English is loaded eagerly. Every other catalog is a lazily-imported chunk fetched when it is
chosen, so a panel serving one language pays for one.

### Adding or editing strings

- **`i18n/sheets/*.csv` are the source of truth** — one row per string, one column per language,
  one file per key prefix (`settings.ddns.csv` holds `settings.ddns.*`). They are sharded because a
  single 462 KB file was returned whole by one read; the rule is in `i18n/sheets/README.md` and
  `test/i18n-catalog.test.ts` enforces the home, the size and the duplicates.
- `pnpm run build:locales` merges every sheet into the `i18n/generated/*.json` the app imports (also
  run on install and before every UI build). That directory is git-ignored, so the sheets are what a
  reviewer reads.
- Add a language by adding its column to every sheet *and* its entry to `LOCALES` in
  `src/i18n/locales.ts`.
- A plural entry is one row per CLDR category, keyed `key[one]`, `key[few]`, `key[many]`,
  `key[other]`, and is folded back into a message object. Leave a category blank when the language
  has no such form — Spanish `many` only occurs at a million and reads from `other`. A blank
  non-plural cell is a bug: `test/i18n-catalog.test.ts` fails on it, and on a translation whose
  placeholders differ from the English, and on generated JSON that is stale.
- `src/i18n/` is the engine: `index.ts` (the singleton and `t`/`tc`), `locales.ts` (the language
  table), `plural.ts` (CLDR plural selection).
- In a component: `import { t } from '@/i18n'`, then `t('nav.servers')`. `t` is available to the
  template from `<script setup>` with no extra wiring. `tc('key', count)` selects a plural form.
- Interpolate with `{name}` placeholders: `t('theme.label', { theme: 'dark' })`.
- A sentence containing markup keeps the whole sentence in the sheet with a `{placeholder}` and
  renders through `src/components/ui/TransText.vue` — never split a sentence into fragments.

## Before you edit

- Vue 3 and Tailwind v4, built through `uis/vite.shared.ts`.
- Aliases: `@` is `uis/stock/src`, `@shared` is `src/shared`, `@server` is `src` (types only;
  never import runtime server code into a UI).
- The API and SSE contract is `../../docs/UI_CREATION.md`. `src/lib/api.ts` and `src/lib/rpc.ts` are the clients.
- Views live in `src/views/`, the shell in `src/components/shell/`, settings in `src/components/settings/`.
- Tests live in `uis/stock/test/`; component tests mount under `// @vitest-environment happy-dom`.
