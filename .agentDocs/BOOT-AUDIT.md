# Boot ladder audit — what to keep, what to trim, what to port

An outside read of `src/boot/` (4 314 lines, 11 modules) against a second implementation of the same
idea (`home-hosted`'s `service install`, 586 lines in one file). Written from the consumer's side:
which parts earn their lines, which exist for a shape this plugin has, and what a *smaller* consumer
should take.

## Where the lines actually are

| module | lines | ~code | ~doc | notes |
| --- | --- | --- | --- | --- |
| `windows.ts` | 1 121 | 718 | 403 | three providers (Run key, Task, boot task) + a `wscript` hidden-launch layer |
| `systemd.ts` | 810 | 616 | 194 | two providers (user, system) |
| `launchd.ts` | 572 | 452 | 120 | two providers (agent, daemon) |
| `escape.ts` | 417 | 208 | 209 | three formats' escapers + assertions |
| `ladder.ts` | 415 | 312 | 103 | ordering, `activate`/`retire`/`control` |
| `common.ts` | 413 | 219 | 194 | paths, ownership, probes |
| `types.ts` | 244 | 113 | 131 | the frozen surface |
| `xdg.ts` | 175 | 140 | 35 | `~/.config/autostart` |
| `fallback.ts` | 112 | 90 | 22 | container + unsupported terminals |
| `index.ts` | 45 | 38 | 7 | re-exports |

**Roughly 45 % of it is documentation, and that is the right ratio** — the doc is where the measured
platform behaviour lives (`schtasks /End` does not run a shutdown handler; WSL2 has no `systemd-user`;
`Restart=always` turns a CLI `down` into a restart). That prose is the most valuable thing in the
directory and should not be trimmed. The *code* is ~2 900 lines.

## What earns its lines

- **`escape.ts`** — three formats, one control-character rule, and Windows quoting split into the CRT
  layer and the `cmd.exe` layer. Both were validated against a real Windows command line. A consumer
  that quotes Windows argv needs the CRT half and nothing else.
- **`systemd.ts`'s `mayCommand`** — proving the unit systemd actually *loaded* (`FragmentPath`) is ours
  before commanding it, not merely that a file exists at the path we would write. This caught a real
  class of bug: the distro unit for `home-hosted` lives at `/etc/systemd/system/home-hosted.service`,
  so a name match is not an ownership match.
- **`common.ts`'s `inspectOwned`/`writeOwned`/`removeOwned`** — one marker check used by every writer,
  reader and remover. Cheaper than each provider re-deriving "is this ours".
- **`ladder.ts`'s `activate()`** — an install *proves* it can start the panel rather than trusting that
  the artifact exists. A LaunchAgent whose label was never booted reads as installed while nothing runs.

## What is over-built for this plugin's shape

- **Three Windows providers.** `windows-run` (HKCU Run key), `windows-task` (logon task) and
  `windows-boot` (SYSTEM task before login) are three answers to one question. The Run key exists
  because it needs no privilege and starts earliest at logon; the boot task exists for the
  before-login case. **The Run key is the one that needs the least code and fails the most quietly**
  (no restart policy, no supervision, no log to name) — it is the fallback, yet it is ranked first in
  the ladder. Ranking the *task* first would remove the Run provider's most common path.
- **The `wscript` hidden-launch layer** (~200 lines: `wscriptExecutable`, `mayExpandByWscript`,
  `hiddenLaunchPath`, `hiddenLaunchScript`, `hiddenLaunch`, `windowlessSpec`) exists solely to stop a
  console window flashing when the Run key starts the panel. A task action has
  `<Hidden>true</Hidden>` and needs none of it. Keeping the Run key forces this layer to exist.
- **`xdg.ts`.** It is honest — "runs at login, never at boot" — but a home-server panel wants boot,
  and `systemd-user` + `systemd-system` already cover Linux better (linger, restart policy, journal).
  Its real value is the **no-systemd** Linux case (Alpine, a bare container host), which is narrow.
  It is 175 lines and 3 test files for that case; reasonable, but it should be ranked *after* both
  systemd providers, which it is.
- **`fallback.ts`'s container provider** — ~110 lines to produce one refusal message. The *detection*
  (four ordered probes) is worth having anywhere; the provider shape is not.

## What a smaller consumer should port

Ranked by value per line, for a CLI that writes a file and exits (not a long-lived plugin):

1. **Container detection before install** — `/.dockerenv`, `/run/.containerenv`, `container=`,
   `/proc/1/cgroup`, in that order. Without it the CLI writes an entry the host's manager never reads,
   inside a filesystem that disappears with the container, and says nothing. *Ported.*
2. **A marker + ownership check on `status`/`uninstall`**, so a fixed path with a common name cannot
   be mistaken for ours. *Ported (the marker half); the `FragmentPath` half is still open — see below.*
3. **Refuse a spec value no format can carry** (C0 controls). A newline in `--home` injects a whole
   directive into a unit that starts at boot. *Ported.*
4. **Validate the account, not the environment.** `SUDO_USER` is an instruction and `SUDO_UID` is the
   fact; a stale inherited name must not collapse the unit to root. *Ported.*
5. **Round-trip the Windows quoting through an independent CRT parser** rather than asserting a
   string. *Ported.*
6. **`mayCommand` via `FragmentPath`** — **not yet ported.** Our `status` reads the file; it does not
   ask systemd which file it loaded. A unit copied into `/etc/systemd/system` by hand is therefore
   invisible to us while systemd runs it.
7. **`startVerb()` from `ActiveState`** — `start` is a no-op on an active unit, `restart` stops a
   working panel over a false negative. Only relevant once the CLI can start a panel *through* the
   entry, which `home-hosted service` does not do (its `start`/`down` signal pids directly).
   **Deliberately not ported** — it belongs with feature 6 above, together.

## Concrete suggestions for this repository

- **`home-hosted` already ranks the task over the Run key**, so the largest suggestion below does not
  apply to it: `service install` writes a Task Scheduler XML and registers it with `schtasks`, with no
  registry Run key and therefore no `wscript` hidden-launch layer. That is the shape this audit
  recommends — one provider, a restart policy, and a log to name.
- **~~Rank `windows-task` above `windows-run`.~~ Withdrawn — it was wrong, and the attempt is
  recorded here because the mistake is the useful part.** I recommended demoting the Run key, then
  tried removing it outright. Both are blocked by a fact the audit missed: `windows-run` is the
  **only** Windows mechanism that needs no administrator rights. `windows-task` and `windows-boot`
  both detect as `available: elevated` with the reason "registering a scheduled task needs an
  elevated process", so deleting the Run provider leaves an ordinary unelevated Windows user with
  **no autostart at all** — the ladder answers `recommended: 'unsupported'`. `docs/BOOT.md` already
  said so in its own table (the `needs: nothing` row), and the provider's own comment did too
  ("HKCU\…\Run needs no admin"). **Its 250 lines are not footprint; they buy the only
  no-privilege path on that platform.** The `wscript` layer is likewise not Run-only — the logon task
  is `hideWindow: true`, because a task starting `node.exe` at logon was measured `visible=True`.
  Ranked *second* would still have been wrong: `auto` prefers `bootCapable`, so the task would win
  and an unelevated user would fall through to Run only by accident of ordering.
- **Move `detectContainer` out of `fallback.ts`** into `common.ts` — it is a fact about the host that
  `systemd`, `launchd` and `windows` all want (a task or unit inside a container is equally pointless),
  and today only the terminal provider consults it.
- **`BOOT.md` and the gotchas file say "measured" a lot; name the build.** Several notes say "measured
  on Windows 11" without the build number, which is what a later reader needs to judge whether the
  measurement still applies.
