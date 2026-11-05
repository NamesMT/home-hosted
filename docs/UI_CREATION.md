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
  index.html                  ← required, at the root (or inside one wrapper directory)
  assets/…
  ui.json                     ← optional, see below
```

**Global settings → Interface → Install UI** takes a `.zip` (refresh to see it), or copy the files
into `$HHOSTED_HOME/.hh/.ui` yourself. From the CLI, `home-hosted ui-switch` installs one from a
GitHub release asset, a local zip (`--file ./ui.zip`) or a URL.

**If it breaks:** `home-hosted ui-revert` (or *Revert to stock* in Global settings) brings the stock
UI back. The delete is not archived — keep your own copy of the build. While a custom UI is active,
`up` prints a reminder, so a broken UI never locks you out.

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
   over loopback, a LAN IP, TLS or a proxy. Unknown paths fall back to `index.html`, so client-side
   routing and deep links work.
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
- **Text the panel formats itself** (a backup entry's label, why a path is skipped) arrives as
  English plus an optional `labelKey`/`noteKey` and `…Params`. Resolve the key if you have a catalog,
  otherwise render the English.
- **A start event's `actor`** (`policy`, `user`, `agent`, `boot`) says what asked for it; absent on
  older events.
- `GET /api/backups` is not in the state frame (it reads secrets and stats archives): fetch it when
  a dialog opens.

## Building one in this repo

The repo's own UIs are Vite + Vue apps: `uis/<name>/` holds `index.html`, `src/`, a `tsconfig.json`
and a two-line `vite.config.ts` calling `createUiConfig` from `uis/vite.shared.ts`, with
`public/ui.json` naming it. Yours does not have to be Vite — only the output matters.

```sh
pnpm dev --ui <name>                      # panel on :6000, your UI's dev server on :6001, /api proxied
node scripts/build-uis.mjs <name> --zip   # → uis/dist/home-hosted-ui-<name>.zip
```

Inside the repo, `@shared/…` is `src/shared/` (contracts, the API client, formatters) and `@server`
gives types only — `hc<AppType>` from `hono/client` is a fully typed client (`uis/stock/src/lib/rpc.ts`).

## A worked example, outside this repo

```bash
npm create vite@latest my-panel -- --template vue-ts
cd my-panel && pnpm install && pnpm run build      # → dist/
cd dist && zip -r ../my-panel.zip . && cd ..
# Global settings → Interface → Install UI, then refresh
```

For development, proxy `/api` from your dev server to a panel (`pnpm dev` in this repo runs one on
`http://127.0.0.1:6000`, password `dev`).

## Checklist

- [ ] `index.html` at the root of the zip, assets referenced relatively
- [ ] only relative `/api/...` calls
- [ ] `401 AUTH_REQUIRED` → login screen
- [ ] live data from SSE
- [ ] deep links render, each page has its own path
- [ ] assets self-hosted
- [ ] works over plain http on a LAN
- [ ] `ui.json` with a name and version (plus `repo`/`asset` to follow your releases)
- [ ] usable at 320–390 px
