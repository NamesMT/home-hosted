# Building a UI for home-hosted

The panel's UI is **a static site, and it is replaceable**. The stock one ships in the package;
yours is a folder of files the panel serves instead — same API, same authentication, no server
changes and no fork. Everything it can do is in [API.md](./API.md).

## Ask an AI to build it

This file plus [API.md](./API.md) is the whole contract, so a coding agent can do the work. Point it
at this repo and be specific:

> Help me build a UI for `home-hosted`: a nostalgic game theme. Servers as a party menu, health as
> HP bars, logs in a text-box pane, keyboard navigation, and a save-state corner for backups.
> Follow `docs/UI_CREATION.md` and `docs/API.md`.

Directions to borrow from live in [`mockups/`](./mockups).

## Install it

```text
$HHOSTED_HOME/.hh/.ui/        ← where your build lives
  index.html                  ← required
  assets/…
  ui.json                     ← optional, see below
```

**A hand-copied UI must put `index.html` at the root of `.ui`.** The "one wrapper directory" allowance
below belongs to the **zip upload**, which unpacks into a staging directory and looks one level down
for `index.html` (`zip -r ui.zip dist` is a common shape). Copying a `dist/` folder into `.ui/`
instead leaves the shell at `.ui/dist/index.html`, where nothing serves it.

**Global settings → Interface → Install UI** takes a `.zip` (refresh to see it), or copy the files
into `$HHOSTED_HOME/.hh/.ui` yourself. The upload is `multipart/form-data` with one `file` part, and
it is **session-only**: an API token is refused `403 SESSION_REQUIRED` before the archive is read — a
UI is script on the panel's own origin, so installing one is a person's act. On success the panel
rewrites `ui.json` in the installed directory with `uploadedAt` and `files` (the count it unpacked),
keeping whatever `name`/`version`/`repo`/`asset` the archive declared. From the CLI, `home-hosted ui-switch` installs one from a
GitHub release asset, a local zip (`--file ./ui.zip`) or an https URL (plain `http://` is refused
unless you pass `--insecure`). A release asset is checked against the sha256 digest GitHub publishes
for it, and the startup update of an official UI never replaces one you installed meanwhile.

**If it breaks:** `home-hosted ui-revert` (or *Revert to stock* in Global settings) brings the stock
UI back. The delete is not archived — keep your own copy of the build. While a custom UI is active,
`up` prints a reminder, so a broken UI never locks you out.

### Caching, and what a missing path means

The panel decides `Cache-Control` per request from the **name**, not from the directory:

| Path | `Cache-Control` | Why |
| --- | --- | --- |
| `/assets/<name>-<hash>.<ext>`, where `<hash>` is 8 base64url characters carrying both a letter and an upper-case character or digit | `public, max-age=31536000, immutable` | The URL changes with the bytes, so a year is safe. This is what a Vite build emits. |
| anything else (`index.html`, an unhashed `assets/logo.svg`, `favicon.ico`) | `no-cache` | The URL outlives one build. `immutable` on such a name froze a rebuilt UI in every browser. |

`index.html` is always `no-cache` on purpose: it names the hashed files a rebuild deletes, so a
cached shell pointing at a file that no longer exists is a blank page.

**A missing path is a 404 unless it can be a page.** An extension-less path (a client route such as
`/w/default/servers`) is answered with `index.html`, and so is any path outside `/assets/` requested
with `Accept: text/html` — a browser navigating, and a route that happens to contain a dot. A request
for a missing **file** is a 404: a `fetch`/`<script>`/`<link>` sends its own `Accept`, so a missing
`.js` or `.css` never arrives as HTML (which a browser would report as a syntax error and hide the
real 404). Nothing under `/assets/` is ever a page, so a missing name there is a 404 even for a
request that accepts HTML — a broken reference in the build, not a route.

### `ui.json`

Every field is optional; together they let the panel show what is installed and offer updates:

```json
{ "name": "my-panel", "version": "2.1.0", "repo": "you/my-panel", "asset": "my-panel.zip" }
```

| field | |
| --- | --- |
| `name`, `version` | what Global settings → Interface shows |
| `repo` | `owner/name` the releases come from — all `ui-update` needs |
| `asset` | the release asset name, when a release carries more than one UI |

With `repo` set, `home-hosted ui-update` lists releases carrying your asset and installs the one you
pick (`--old` for older ones). Official UIs (`repo: NamesMT/home-hosted`) instead follow the panel's
own version automatically. Don't write `tag` or `unix` — those are build provenance this repo's build
stamps. A BOM or UTF-16 file (Notepad, PowerShell) is read fine.

## Rules of the road

1. **Static only.** Everything comes from the API; nothing is built on the server.
2. **Same origin, relative paths.** Call `/api/...`, never an absolute host — the panel may be reached
   over loopback, a LAN IP, TLS or a proxy. A path a person navigated to falls back to `index.html`,
   so client-side routing and deep links work; a missing *file* is a 404 (see
   [Caching, and what a missing path means](#caching-and-what-a-missing-path-means)).
3. **Keep the login flow.** `401 { code: "AUTH_REQUIRED" }` → show a login screen and
   `POST /api/auth/login`. While `session.usingDefaultPassword` is true, tell the person to change it
   (`home-hosted status` on the machine shows the first-run password).
4. **Live data from SSE** (`/api/events`). A panel that only polls feels broken.
5. **Self-host your assets.** An offline home server should not need a CDN.
6. **Plain-http LAN friendly.** No `Secure`-only cookies, no hard-coded port, and no reliance on
   secure-context APIs: `navigator.clipboard` is *undefined* on `http://192.168.x.x`. Fall back to
   `document.execCommand('copy')` and say so when even that fails (`uis/stock/src/lib/clipboard.ts`).
7. **A phone is a real client.** Controls ≥ 24 px, ≥ 44 px under `@media (pointer: coarse)`
   (`uis/tap-targets.css`); rows fit the width or visibly scroll; check 320 px, not only 390 px;
   keyboard hints only under `@media (hover: hover)`.
8. **Give each page its own path.** Matching the stock paths keeps two UIs of one panel alike:
   `/w/<workspace>` (· `/servers` · `/logs` · `/settings`), `/w/<workspace>/servers/<id>`,
   `/global/overview`, `/global/settings`, `/proxy`.
9. **Limits:** ≤ 20 000 entries and ≤ 512 MB uncompressed per zip; no absolute paths, `..`,
   symlinks or drive letters.

## What a UI has to get right

- **Key servers by `(workspaceId, serverId)`.** The same id can exist in two workspaces, and every
  `server` and `log` frame carries both.
- **Send an entry as a diff.** `POST /api/servers` and `PATCH` take only what the person chose; the
  workspace's server defaults fill the rest. `diffFields` in `src/shared/patch-diff.ts` builds it.
- **A live frame must never overwrite a half-typed edit.** Frames carry fresh objects every second.
  Fill each settings block on its own, and only while it is untouched since it was last filled —
  and make that snapshot cover *every* field the block's form holds, lists included, or an edit to
  the forgotten field is reverted on the next frame
  (`uis/stock/src/components/settings/settingsForm.ts`).
- **Decide to open the stream from the session**, not from the auth flags: with auth off both flags
  are `false` forever, and a watcher on them never fires (`uis/stock/src/composables/useSession.ts`).
- **Reconnect after the browser gives up.** Sessions live in memory, so a restarted panel answers
  the stream's reconnect with `401` — and an `EventSource` stops retrying on any non-`200`. On an
  error with `readyState === CLOSED`, re-check the session: signed out goes to login, anything else
  reconnects with backoff. Inside this repo, `src/shared/live-store.ts` does all of this for both
  UIs.
- **Resume a stream, don't rebuild it.** Every frame carries an `id:`, so a reconnect can say
  `Last-Event-ID` (`EventSource` sends the last one itself) or `?since=<seq>` for a `fetch` reader.
  A resumed stream sends one **current** `hello`/`server` snapshot and then replays the `log` frames
  you missed — so treat the replay as **log lines only, never as fresher state**, and do not refetch
  `/api/state` after a clean resume. The snapshot's `id:` is the resume point itself, so a frame you
  receive never numbers below the one you asked from. Only the last 200 log frames are retained: a
  gap is log-only, never state, and `/api/logs/:id?since=` plus the download cover the rest.
  **A fresh (unresumed) per-server stream still seeds its last 200 lines**, so keep clearing that
  server's buffer on each `open` — but do not clear it on a *resumed* connect, or the replay goes
  into a buffer you just emptied.
- **Tolerate a value you have not heard of.** A newer panel may add a status or a health state;
  show it as it came rather than refusing the frame (`src/shared/live-frames.ts`).
- **Text the panel formats itself** (a backup entry's label, why a path is skipped) arrives as
  English plus an optional `labelKey`/`noteKey` and `…Params`. Resolve the key if you have a catalog,
  otherwise render the English.
- **An event's `actor`** (`policy`, `user`, `agent`, `boot`) says what asked for it; absent on older
  events, and on a `start`/`exit` nobody asked for — a process that ended on its own has no actor.
  A `start` carries whoever asked for it, and an `exit` only when a stop asked for it.
- **A timestamp is ISO, in the host's timezone, and never localised.** Render it as
  `YYYY-MM-DD` / `YYYY-MM-DD HH:MM:SS` through `formatDateIso`/`formatDateTimeIso` in
  `src/shared/ui-format.ts`; a log line's clock is `HH:MM:SS.mmm` from `formatClockIso`. Do **not**
  format one with `Intl` or `toLocaleString`: passing `undefined` follows the *browser* rather than the
  panel's language (an English date on a Japanese panel), and a localised date spells the same moment
  differently in each language — `03/04/2026` is a different day in two of the nine the stock UI
  ships. A control panel's date is read against a log line and pasted into a bug report, so it has to
  sort and match as a string. Relative times (`in 4s`, `12s ago`) are the opposite: those stay `Intl`.
- `GET /api/backups` is not in the state frame (it reads secrets and stats archives): fetch it when
  a dialog opens.

## Building one in this repo

The repo's own UIs are Vite + Vue apps: `uis/<name>/` holds `index.html`, `src/`, a `tsconfig.json`
and a two-line `vite.config.ts` calling `createUiConfig` from `uis/vite.shared.ts`, with
`public/ui.json` naming it. Yours does not have to be Vite — only the output matters.

```sh
pnpm dev --ui <name>                      # panel on :6600, your UI's dev server on :6601, /api proxied
node scripts/build-uis.mjs <name> --zip   # → uis/dist/home-hosted-ui-<name>.zip
```

Inside the repo, `@shared/…` is `src/shared/` (contracts, the API client, formatters) and `@server`
gives types only. The API client is `@shared/api-client`: both UIs import it, and the workspace-scoped
calls take an optional workspace so each UI decides where that comes from (`useWorkspaceResolver`).

## A worked example, outside this repo

```bash
npm create vite@latest my-panel -- --template vue-ts
cd my-panel && pnpm install && pnpm run build      # → dist/
cd dist && zip -r ../my-panel.zip . && cd ..
# Global settings → Interface → Install UI, then refresh
```

For development, proxy `/api` from your dev server to a panel (`pnpm dev` in this repo runs one on
`http://127.0.0.1:6600`, password `dev`). Two settings matter, and both are visible only in the dev
server:

- **`changeOrigin: false`.** The panel's host guard answers `421 HOST_NOT_ALLOWED` to a `Host` it does
  not know, and a proxy that rewrites it to the target's sends one the panel never accepted. Your dev
  server keeps the browser's `Host`, which is what a same-origin UI already is.
- **Proxy `/healthz` and `/openapi` too**, not only `/api`. They are the panel's two unauthenticated
  non-`/api` reads, and a UI reaches them same-origin: proxying only `/api` makes the dev server
  answer `index.html` for both, so a health tile reads `—` and an OpenAPI fetch parses a page.
  (`uis/vite.shared.ts` is the working configuration.)

## Checklist

- [ ] `index.html` at the root of the zip (or of `.ui/` when you copy by hand), assets
      **root-absolute** (`/assets/…`, never `./assets/…` — a relative path breaks on a deep link
      like `/servers/web`, which is served `index.html` and then resolves against the wrong base)
- [ ] only relative `/api/...` calls
- [ ] `401 AUTH_REQUIRED` → login screen
- [ ] live data from SSE
- [ ] deep links render, each page has its own path
- [ ] assets self-hosted
- [ ] works over plain http on a LAN
- [ ] `ui.json` with a name and version (plus `repo`/`asset` to follow your releases)
- [ ] usable at 320–390 px
