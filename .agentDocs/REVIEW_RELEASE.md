# Release review: `0.16.0`

**Status: mechanical pass done, independent review still outstanding.**

This file is the deliverable `task-1` describes. It currently holds what the root agent could verify
mechanically — page loads, section presence, layout, console errors — which is evidence rather than
opinion. It is **not** the independent review: a same-agent pass cannot contradict the agent that wrote the
code, and `RELEASING.md` requires that review's findings to be accounted for before a dispatch.

An independent reviewer should treat the section below as a baseline to check, not as done work, and add
findings above it.

## Browser tooling for the reviewer: Playwright, not bsk

`task-1` originally said *"bsk tools are available and verified working"*. **They are not usable here**, and
the task has been corrected. Measured twice:

- `bsk status` answers *"cannot start an independent Windows daemon; the Job Object of this process does not
  allow breakaway … Access is denied (os error 5)"*.
- `bsk.exe daemon start --foreground` **does** bring a daemon up from a background job, and `bsk status
  --json` then answers — but `bsk_session start` still fails with **"no browser is currently connected"**.
  Attaching one needs a human to open the browser-skill extension and wait for "connected".

**Playwright is installed and works** (`chromium.launch()` succeeds), and it is what `pnpm run smoke` uses,
so a finding reproduces in CI. That is the supported path.

## Mechanical pass (root agent, built panel, Playwright)

Panel: `HHOSTED_HOME=/tmp/hh-mech node dist/cli.js up --port 6993`, stock UI from the package.

| Route | h1 | Content | Console errors |
| --- | --- | --- | --- |
| `/global/settings` | Global settings | 7 601 chars | 0 |
| `/w/default/settings` | Workspace settings | 4 071 chars | 0 |
| `/w/default/servers` | Servers | 677 chars | 0 |
| `/w/default/jobs` | Jobs | 453 chars | 0 |
| `/w/default/logs` | Logs | 735 chars | 0 |
| `/proxy` | Reverse Proxy | 2 940 chars | 0 |
| `/global/overview` | Global Overview | 1 181 chars | 0 |
| `/openapi/ui` | home-hosted API | 4 746 chars | 0 |

**Settings sub-sections, all present:** `/global/settings` carries Listener, Authentication, Host vitals,
Backups, TLS, Language, Interface, Paths (8/8); `/w/default/settings` carries Server defaults, Logs,
Notifications, Dynamic DNS (4/4).

**Narrow viewport (390 × 844):** no sideways document scroll on the three text-heaviest pages
(`global/settings`, `w/default/settings`, `proxy`) — 0 px overflow on each.

**Long-language probe:** switched the UI to German through its own selector, then re-checked at 390 px.
Headings render as *Globale Einstellungen*, *Arbeitsbereich-Einstellungen*, *Reverse-Proxy* — the long
compounds — with **0 px** sideways overflow and no console errors.

## Mutating actions (root agent, same pass)

The review task points at these because the page-load pass above could not reach them. Driven with
Playwright against the built panel, `HHOSTED_HOME=/tmp/hh-mut`, port 6994.

**Add a server, end to end — works.** The dialog is a **two-step wizard**: it opens on a preset picker
(Minecraft, Jellyfin, Node, Python, each with a sentence about what to change), and the form is
`v-show="!showPresets"` — `display: none` until a preset is chosen. Two readings of mine were wrong before
that was clear: the first said "dialog has 1 visible field", the second "the form has zero size, it is a
bug". Both were the first step of a working wizard.

After picking **A Node app**, filling `demo` / `Demo app` / port `7985` and submitting:

- the server appears in the list;
- it **survives a reload**;
- and it reached the config file with every field intact —
  `demo  command=node port=7985 label=Demo app`.

**Start — works.** The row control reads `Start`; after clicking, the row reads `running` and the workspace
counter moved `0/1`. No console errors.

**A crash is surfaced, in both places a person looks.** The Node preset pre-fills `args: ["server.js"]`, which
did not exist in my scratch working directory, so it exited 1 and gave up after its retries. The servers page
says `Crashed` / `node server.js` / `Exited`; `/w/default/logs` carries the detail — `exited with code 1 after
1s`, `gave up after 3 retries (code 1)`, `84 lines`. That is correct behaviour for a broken entry, and the
reporting is the useful kind.

**One routing note for the reviewer, not a defect:** there is no per-server logs control on the servers page;
logs are the workspace route `/w/<id>/logs`. If a finding is "I cannot find the logs", look there.

## Global settings save — verified (root agent, same pass)

**A panel-wide setting saves, persists and lands in the file.** Changed *Panel name* (`#v-38`, the last text
field on `/global/settings`) to `Renamed panel`, pressed **Save settings**, reloaded the page: the field reads
`Renamed panel`, and `settings.json` carries `control.label: "Renamed panel"`. No console errors. The page
also marks itself dirty correctly — *Discard changes* appears once a field is edited and *No unsaved changes*
once the save returns.

**One probe of mine was meaningless, and it is the shape to avoid.** My first attempt picked `#v-11` — the
fourth number input, which I *assumed* was the session TTL — filled `1234`, saved, and found `sessionTtlMs`
absent from `settings.json`. That reads exactly like "the save silently dropped my change". It did not:
`sessionTtlMs` lives under `auth`, not `control`, and `#v-11` was some other field entirely. The fields carry
**generated ids** (`v-7`, `v-11`, `v-38`, …) and no `name`, so the only way to know which is which is to read
the label beside it — which is what the last run does, and what any future probe must do first.

## Switch state, error association and dialog focus — verified (root agent, same pass)

Three candidates from the accessibility seam, driven in Chromium. **All three are correct.**

- **Six switches on `/global/settings`** carry `role="switch"`, are named by their own label text through
  `aria-labelledby`, and report an `aria-checked` that matches the setting — and it *updates on click*:
  measured `false → true → false` across two clicks, with no console errors. (`SwitchRoot` from reka-ui
  supplies the role and the state pair; the code only had to name it, which it does.)
- **`aria-labelledby` is used once**, in `ToggleSwitch.vue`, and the id it names exists.
- **Dialog focus** — the add-server dialog moves focus *into* it on open (`activeElement` inside
  `[role="dialog"]`), Escape closes it, and focus returns to the button that opened it (`Add a server`).
  That is the whole focus contract, working.

## What this pass did NOT cover

- Every action a person takes: add/edit/delete a server, start/stop/restart, the config editor, presets,
  job create/run/secret-env, backup create/list/restore dialogs, proxy route editing, account management,
  the activity feed. The form-save path is covered by `pnpm run smoke` (it saves a settings value and reads
  it back), but nothing else is.
- The other eight stock languages (only German was probed).
- `noc-console`, which `pnpm run smoke` walks in CI but which this pass did not.
- Anything requiring a docker daemon or a public name (compose lifecycle, full ACME issuance).

## Verdict

**Not this file's call.** The mechanical baseline is green; the dispatch still needs an independent
reviewer to walk the actions above and record findings.
