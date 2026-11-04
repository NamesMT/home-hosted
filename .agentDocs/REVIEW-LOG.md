# home-hosted — review log

What review rounds found, still worth knowing. **Shipped work lives in `git log`** — a row here is
either still open or a rule future work must not re-break.

## Open

| # | Item | Why it is open |
| --- | --- | --- |
| 19 | A panel started without `node` on `PATH` fails every entry | Correct behaviour — the panel has Node (`process.execPath`), children inherit `PATH`, and `describeSpawnError` names the cause. A systemd/docker user hits it fleet-wide, so a docs note may be worth one line. No code change. |
| 43 | `status` cannot say "did everything come back after the reboot" | Measured: a panel up with every entry stopped prints `running`, exit 0. The *failure* states are covered — `crashed`/`conflict`/`stoppedByPanel` print `running — a server needs attention` and set `degraded: true`. The count lives in `/healthz`, but that only includes it for an **authenticated** caller, and the local channel's token (`x-home-hosted-token`) is a different secret from the API bearer token — so `status` cannot read it without a new route or touching secrets. Deliberately not done; `usage` answers it today. |

## Rules these rounds established

Each cost a real defect. Re-breaking one is a regression.

- **A command that answers on spawn lies when the process dies.** `start`/`restart <id>` read the
  entry back over `/_hh` and refuse when it is gone; the panel answers on spawn by design, the caller
  decides.
- **"Not running" is a claim about the machine, not the record.** With `run.json` gone, `down`
  probes the port its own `settings.json` names and refuses, signalling nothing.
- **`exitedCleanly` distinguishes a stop from a crash** — absence of `run.json` cannot, because `up`
  tidies a crashed record too. Only a deliberate stop writes the marker.
- **One `needsAttention` decides "broken"** for `/healthz`, both UIs and `usage`. It was seven
  hand-picked disjunctions and they disagreed in both directions.
- **The default workspace is `defaultWorkspaceId`, not the literal `default`** — the panel falls back
  to the first listed. The CLI re-derived it and read a directory that never existed.
- **A port frees after the process is reaped, not when the kill returns.**
- **Windows has no `chmod`.** Any platform-specific remedy comes from `process.platform`, as
  `shellQuote` already does.
- **A response field is optional (`'x?'`) and read defensively**; a required one blanks an older UI.
- **A missing reading is absent, never `0`.** A zero on a CPU column reads as "idle".
- **A test that leaks a temp directory fails no assertion.** Sweep it; a full run leaked ~290.
- **A guard earns its place only if a plausible change could violate it.** Two were deleted for
  restating a static fact.

## Verified good — recorded so nobody "fixes" them

Broken `servers.config.json` keeps running servers and says so · the crash retry budget survives a
panel restart · a panel without `node` on `PATH` fails with the right message · `--help`, `--version`,
unknown commands and idempotency · the 0.9→0.11 upgrade surface · restamping a live panel's configs
reloads it without touching a running entry · the scaffold's `.gitignore` is correct (config tracked;
secrets, logs, TLS, backups, proxy and generated schemas ignored) · `--frozen-lockfile` cannot run in
a `--no-install` project, by design.
