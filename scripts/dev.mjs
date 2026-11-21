#!/usr/bin/env node
/**
 * Dev runner: the control plane (tsx watch) and the Vite dev server for one UI,
 * so UI edits hot-reload while the API keeps running.
 *
 * Both default to the 66xx range (panel 6600, UI 6601). Two separate reasons, and the second one is
 * why the range is 66xx rather than 60xx:
 *
 *  - An installed panel or another dev instance may already hold 3999, and the panel's port preflight
 *    runs before it refuses a broken config, so a busy default port fails unrelated tests for the
 *    wrong reason.
 *  - **6000 is held on some hosts before anything asks for it.** Measured on WSL2: `net.listen` on
 *    127.0.0.1:6000 answers `EADDRINUSE` with no process to name — Windows reserves the range for its
 *    own use and the guest inherits the refusal. A default nobody can bind is worse than a default
 *    that occasionally collides, so the range starts above it.
 *
 *   pnpm dev                            # panel 6600 + stock UI 6601
 *   pnpm dev --ui noc-console           # panel 6600 + noc-console on 6601
 *   pnpm dev --port 6610 --ui-port 6611
 *   pnpm dev --home /tmp/hh-dev         # a state directory of your own
 *   HHOSTED_DEV_PANEL_PORT=6610 pnpm dev
 *
 * **State is `.dev-state/` unless you say otherwise, and never inherited silently.** An exported
 * `HHOSTED_HOME` (a shell profile, a container image) used to win here, so `pnpm dev` ran against
 * the real panel's state: with that panel stopped it would have booted on the live config and
 * rewritten its persisted listener to the dev port. `--home` is the explicit way to point it
 * somewhere else, and the default state may not be `~/.home-hosted` at all.
 */
// @ts-check
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

const DEFAULT_PANEL_PORT = 6600
const DEFAULT_UI_PORT = 6601

/**
 * The package manager this checkout is driven by, as a spawnable command.
 *
 * A bare `pnpm` is resolved from `PATH`, and `PATH` is not something this script can assume: run it
 * from a bare `env -i`, an editor task, a CI step or a systemd unit and there is no pnpm on it even
 * though the install is right there — `spawn pnpm ENOENT`, from a stack trace rather than a message.
 * `process.execPath` is the node running this script, and every install layout we support puts pnpm
 * beside it (fnm/nvm/volta do; a distro package puts it in `/usr/bin` and `PATH` finds it anyway), so
 * that directory first, then the plain name as the last resort.
 *
 * Windows needs the `.cmd` shim and `shell: true` to execute it; a POSIX shell would re-parse the
 * argv and mangle a path with a space, so the shell is Windows-only.
 */
const windows = process.platform === 'win32'
function resolvePnpm() {
  const name = windows ? 'pnpm.cmd' : 'pnpm'
  const besideNode = path.join(path.dirname(process.execPath), name)
  if (fs.existsSync(besideNode))
    return besideNode
  return name
}
const pnpm = resolvePnpm()

/**
 * `PATH` for every child, with this node's own directory on it.
 *
 * Resolving pnpm to an absolute path is not enough: pnpm runs the scripts it is asked for through a
 * shell, and those scripts call a bare `node` (vite, tsx and `build-locales.mjs` all do). From a `PATH`
 * that has no node — the case the resolution above exists for — pnpm found none of them and every
 * child exited 127 with `env: 'node': No such file or directory`. Prepending the directory is what
 * makes the *grandchildren* work, and it costs nothing when the directory is already on `PATH`.
 */
const childPath = (() => {
  const nodeDir = path.dirname(process.execPath)
  const current = process.env.PATH ?? ''
  const parts = current.split(path.delimiter).filter(part => part.length > 0)
  return parts.includes(nodeDir) ? current : [nodeDir, ...parts].join(path.delimiter)
})()

/** `resolveDataRoot()`'s own default: the one directory dev must never touch on its own. */
const REAL_STATE = path.join(os.homedir(), '.home-hosted')
/** The dev panel's password. Weak on purpose — it is loopback-only, and nobody should hunt for it. */
const DEV_ACCOUNT = 'default'
const DEV_PASSWORD = 'dev'

function parseArgs(argv) {
  const options = { ui: 'stock', panelPort: undefined, uiPort: undefined, home: undefined, help: false, passthrough: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const [name, inline] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = () => inline ?? argv[++index]
    if (name === '--ui') {
      options.ui = value()
      continue
    }
    if (name === '--port') {
      options.panelPort = Number(value())
      continue
    }
    if (name === '--ui-port') {
      options.uiPort = Number(value())
      continue
    }
    // Consumed here rather than passed through, so it cannot also reach the panel as a flag it
    // would have to re-resolve: one owner for where state lives.
    if (name === '--home') {
      options.home = value()
      continue
    }
    /**
     * `--help` answers here, not in the passthrough.
     *
     * Every unrecognised flag is handed to the panel (`--log-level`, `--bind`), which is right — but
     * `--help` in that position reached `up`, and the panel answered it *after* both servers were up:
     * measured, `pnpm dev --help` built the UI and bound 6950/6951 before printing anything. Someone
     * asking what the command does got a dev server on two ports instead. `-h` is the same request.
     */
    if (name === '--help' || name === '-h') {
      options.help = true
      continue
    }
    options.passthrough.push(arg)
  }
  options.uiPort ??= Number(process.env.HHOSTED_DEV_UI_PORT ?? DEFAULT_UI_PORT)
  options.panelPort ??= Number(process.env.HHOSTED_DEV_PANEL_PORT ?? DEFAULT_PANEL_PORT)
  return options
}

const options = parseArgs(process.argv.slice(2))

/**
 * Print what this does and stop, before anything is built or bound.
 *
 * The header comment above is the documentation; this is the same list a person can ask for. Printed
 * here rather than passed to the panel because the panel's `up --help` describes *its own* flags, not
 * this script's `--ui`/`--ui-port`/`--home`.
 */
if (options.help) {
  process.stdout.write(`pnpm dev — run the panel and a UI dev server together

  pnpm dev                            panel ${DEFAULT_PANEL_PORT} + ${options.ui} UI ${DEFAULT_UI_PORT}
  pnpm dev --ui <name>                another UI from uis/
  pnpm dev --port <n> --ui-port <n>   different ports
  pnpm dev --home <dir>               a state directory of your own (default .dev-state/)

Environment: HHOSTED_DEV_PANEL_PORT, HHOSTED_DEV_UI_PORT, HHOSTED_DEV_SKIP_BUILD.
Any other flag is passed through to \`home-hosted up\`.
`)
  process.exit(0)
}

const uiDir = path.join(root, 'uis', options.ui)
if (!fs.existsSync(path.join(uiDir, 'vite.config.ts'))) {
  const names = fs.readdirSync(path.join(root, 'uis'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, 'uis', entry.name, 'vite.config.ts')))
    .map(entry => entry.name)
  process.stderr.write(`unknown UI "${options.ui}" — pick one of: ${names.join(', ')}\n`)
  process.exit(1)
}
for (const [label, port] of [['panel', options.panelPort], ['ui', options.uiPort]]) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`invalid ${label} port: ${port}\n`)
    process.exit(1)
  }
}

/**
 * Where this run keeps its state.
 *
 * `--home` when given; `.dev-state/` otherwise. `HHOSTED_HOME` is deliberately **not** consulted:
 * an inherited value is indistinguishable from one somebody meant, and the cost of guessing wrong
 * is the real panel's config.
 */
const stateDir = options.home === undefined ? path.join(root, '.dev-state') : path.resolve(options.home)
/**
 * Through any symlink: `path.resolve` compares spellings, and a link to the real state is still the
 * real state. Falls back to the resolved path when the target does not exist yet, which is the
 * normal case for a fresh `--home` and cannot be the installed panel's directory.
 */
function canonical(target) {
  try {
    return fs.realpathSync(target)
  }
  catch {
    return path.resolve(target)
  }
}

if (canonical(stateDir) === canonical(REAL_STATE)) {
  process.stderr.write(`refusing to run dev against ${REAL_STATE} — that is the installed panel's state\n`)
  process.stderr.write('  pass a different directory: pnpm dev --home /tmp/hh-dev\n')
  process.exit(1)
}

/**
 * Gives a fresh dev state the known password, so a wiped `.dev-state/` is not a locked door.
 *
 * Only when there is none: a credential set deliberately — here or through the UI — is left alone,
 * which is what keeps this from quietly resetting somebody's change on every run. Delegated to
 * `account create` rather than hashing here, so the record is written by the one implementation that
 * owns its shape; the panel re-reads the file per request, so no restart is needed for it to apply.
 *
 * This used to call `set-password`, which the accounts refactor **deleted** — so the spawn answered
 * "unknown command", the seed silently failed, and a wiped `.dev-state/` came up on a random
 * first-run secret while the banner still promised `dev`. The account model is what a login is now,
 * so it is what seeds one.
 */
function seedDevPassword() {
  const secretsPath = path.join(stateDir, '.hh', '.control-secrets.json')
  try {
    const existing = JSON.parse(fs.readFileSync(secretsPath, 'utf8'))
    // The account model is the credential: `password` is the pre-0.15 key and reads as absent on a
    // current file, so checking it alone would re-seed a state that already has a working login.
    if (existing !== null && typeof existing === 'object'
      && (existing.password != null || (Array.isArray(existing.accounts) && existing.accounts.length > 0))) {
      return false
    }
  }
  catch {
    // Absent or unreadable. An unreadable file is reported by the panel itself; only a missing
    // credential is this function's business, and `account create` writes one account record.
  }

  const result = spawnSync(pnpm, ['exec', 'tsx', 'src/cli.ts', '--home', stateDir, 'account', 'create', DEV_ACCOUNT, '--scope', 'read,lifecycle,config,proxy,admin'], {
    cwd: root,
    stdio: 'ignore',
    shell: windows,
    // `HHOSTED_SECRET` is the non-interactive way to give `account create` a known secret.
    env: { ...process.env, PATH: childPath, HHOSTED_HOME: stateDir, HHOSTED_SECRET: DEV_PASSWORD },
  })
  if (result.status !== 0) {
    // `status` is null when the process never started at all, which is a different problem from a
    // non-zero exit and deserves the reason rather than "exited null".
    const why = result.error ? result.error.message : `exited ${result.status}`
    process.stderr.write(`could not seed the dev account: ${why}\n`)
    return false
  }
  return true
}

/**
 * Builds the generated catalogs before Vite starts.
 *
 * The catalogs are generated from the sheets and are git-ignored, so they exist only after
 * `pnpm install` or an explicit `build:locales`. `install` runs it once, which is why this was
 * missed: start `pnpm dev`, then edit a sheet, and Vite kept serving the catalog it read at boot —
 * a key added a minute ago rendered as its own name (`views.globalOverview.serversTotal`), which
 * reads as a missing translation rather than a stale build. Vite cannot watch a directory that
 * `import.meta.glob` resolves at transform time, so the fix is to build once, before it starts.
 */
function buildLocales() {
  // `process.execPath`, not a bare `node`: this script is already running on a node, and a `PATH`
  // without one on it is the same trap the pnpm resolution above exists for.
  const result = spawnSync(process.execPath, ['scripts/build-locales.mjs'], {
    cwd: root,
    stdio: 'ignore',
    shell: windows,
  })
  // Not fatal: a clone whose sheets are fine still runs on whatever is on disk, and refusing to
  // start over a catalog would be a worse trade than a stale one.
  if (result.status !== 0) {
    const why = result.error ? ` (${result.error.message})` : ''
    process.stderr.write(`could not rebuild the i18n catalogs${why} — serving whatever is on disk\n`)
  }
}

/**
 * Build the stock UI the **panel** serves, before it starts.
 *
 * The panel serves `uis/stock/dist` (`src/index.ts` passes it as `stockDir`) — a gitignored build
 * artifact — while Vite serves the *other* port from source. So `pnpm dev` gave a working UI port and
 * a panel whose `/` was whatever `dist/` happened to hold, which can be arbitrarily old: measured on
 * 2026-11-15, a build three days stale, missing the whole API-tokens table added since. Opening the
 * panel URL showed a settings page with no token list and no way to manage one, which reads as a bug
 * in the feature rather than in the build.
 *
 * Built **only when it is missing or older than the newest source file**, so a repeat `pnpm dev` is
 * immediate and a source edit still needs a rebuild — which this says out loud rather than leaving a
 * person to wonder why the panel's copy lags the dev server's.
 */
function buildStockUi() {
  const dist = path.join(root, 'uis', 'stock', 'dist', 'index.html')
  const sources = [
    path.join(root, 'uis', 'stock', 'src'),
    path.join(root, 'src', 'shared'),
    path.join(root, 'uis', 'stock', 'i18n', 'generated'),
  ]

  /** The newest mtime under these directories — what `dist/` has to be younger than. */
  function newest(directories) {
    let latest = 0
    const walk = (current) => {
      let entries
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      }
      catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        try {
          latest = Math.max(latest, fs.statSync(full).mtimeMs)
        }
        catch {
          // A file that vanished mid-walk cannot be the newest one.
        }
      }
    }
    for (const directory of directories)
      walk(directory)
    return latest
  }

  let built = 0
  try {
    built = fs.statSync(dist).mtimeMs
  }
  catch {
    // Missing: build.
  }
  if (built !== 0 && built > newest(sources))
    return

  process.stdout.write(`building the stock UI the panel serves${built === 0 ? '' : ' (dist is older than the source)'}…\n`)
  const result = spawnSync(pnpm, ['run', 'build:ui'], {
    cwd: root,
    stdio: 'ignore',
    shell: windows,
    // Same reason as every other child: pnpm runs `node` for the build, and this spawn does not go
    // through `run()`, so it has to carry the PATH itself.
    env: { ...process.env, PATH: childPath },
  })
  // Not fatal: a stale panel build is a degraded demo, and refusing to start over it is worse.
  if (result.status !== 0)
    process.stderr.write(`the stock UI build failed${result.error ? ` (${result.error.message})` : ` (exited ${result.status})`} — the panel at / serves whatever dist/ holds\n`)
}

/**
 * `HHOSTED_DEV_SKIP_BUILD=1` skips both pre-builds.
 *
 * They are convenience: the catalogs and the stock UI a fresh clone needs. A caller that already
 * built them — a CI step, or the test that drives this script — pays for them twice, and both write
 * files *inside the repo* while the rest of a parallel test run reads them (`i18n/generated/*.json`
 * is a git-ignored build product the whole stock suite imports). Skipping is how that caller avoids
 * racing every other worker. `pnpm dev` leaves it unset, which is the common case.
 */
const skipBuild = process.env.HHOSTED_DEV_SKIP_BUILD === '1'
if (!skipBuild) {
  buildLocales()
  buildStockUi()
}

const seeded = seedDevPassword()

/** The panel gets `--port` unless the caller already named one in the passthrough. */
const named = options.passthrough.some(arg => arg === '--port' || arg === '-p' || arg.startsWith('--port='))
const panelArgs = [
  'exec',
  'tsx',
  'watch',
  'src/cli.ts',
  'up',
  '--foreground',
  ...(named ? options.passthrough : ['--port', String(options.panelPort), ...options.passthrough]),
  // Passed to the panel explicitly as well as through the environment, so the state directory is
  // visible in the argv of the process a person sees in `ps` when something is writing where it
  // should not.
  '--home',
  stateDir,
]

const children = []

function run(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: childPath, ...env },
    // Only Windows needs it, and only for the `.cmd` shim; a shell here on POSIX would re-parse
    // the argv and mangle a path containing a space.
    shell: windows,
  })
  child.stdout.on('data', chunk => process.stdout.write(`[${label}] ${chunk}`))
  child.stderr.on('data', chunk => process.stderr.write(`[${label}] ${chunk}`))
  /**
   * A command that cannot be spawned at all fires `error`, not `exit`.
   *
   * Without this listener node treats it as an unhandled 'error' event and rethrows it, so the
   * whole dev run died with a raw stack trace (`spawn pnpm ENOENT`) instead of saying which
   * process failed and why — from a bare `PATH`, which is exactly when the message matters most.
   */
  child.on('error', (error) => {
    process.stderr.write(`[${label}] could not start \`${command}\`: ${error.message}\n`)
    if (error.code === 'ENOENT' && command === pnpm)
      process.stderr.write(`[${label}] pnpm was not found. Run \`pnpm install\` in ${root} first, or put pnpm on PATH.\n`)
    stopAll(1)
  })
  child.on('exit', (code) => {
    console.log(`[${label}] exited with code ${code}`)
    stopAll(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function stopAll(code) {
  if (stopping)
    return
  stopping = true
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    }
    catch {
      // already gone
    }
  }
  setTimeout(() => process.exit(code), 500)
}

process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))

// `.dev-state/` unless `--home` said otherwise. `HHOSTED_PROJECT` is pinned to the repo for the
// same reason as the state: a relative entry path in a demo config should resolve against this
// checkout, not wherever the shell happened to be.
const devEnv = {
  HHOSTED_HOME: stateDir,
  HHOSTED_PROJECT: root,
  HHOSTED_DEV_UI_PORT: String(options.uiPort),
  HHOSTED_DEV_PANEL: `http://127.0.0.1:${options.panelPort}`,
}

process.stdout.write(`panel    http://127.0.0.1:${options.panelPort}\n`)
process.stdout.write(`${options.ui.padEnd(8)} http://127.0.0.1:${options.uiPort}\n`)
process.stdout.write(`state    ${stateDir}\n`)
if (seeded)
  process.stdout.write(`account  ${DEV_ACCOUNT} / ${DEV_PASSWORD} (seeded for this dev state) — sign in at the URL below\n`)
else
  process.stdout.write(`account  ${DEV_ACCOUNT} / ${DEV_PASSWORD} unless changed in the UI\n`)
if (options.home === undefined && process.env.HHOSTED_HOME !== undefined)
  process.stdout.write(`         (HHOSTED_HOME=${process.env.HHOSTED_HOME} is set and ignored — pass --home to use it)\n`)

/**
 * A custom UI installed in this state silently shadows `uis/stock/dist`.
 *
 * The panel serves `.ui/` whenever it holds a complete UI and only falls back to the stock build
 * when it does not, so a `pnpm run build:ui` here is invisible: measured on a dev state, the build
 * wrote `index-BiD989Sc.js` while `:6600` kept serving `index-Bwwrw1n-.js` from `.dev-state/.hh/.ui/`.
 * The rebuild is not broken, it is shadowed, and nothing on screen says so. Say so here, where the
 * confusion starts.
 */
const installedUi = path.join(stateDir, '.hh', '.ui', 'index.html')
if (fs.existsSync(installedUi)) {
  process.stdout.write(
    `ui       a custom UI is installed in this state and shadows uis/${options.ui}/dist\n`
    + `         the panel at / serves .hh/.ui — \`home-hosted --home '${stateDir}' ui-revert\` to see the stock build\n`,
  )
}

run('control', pnpm, panelArgs, devEnv)
run(`${options.ui} ui`, pnpm, ['exec', 'vite', '--config', path.relative(root, path.join(uiDir, 'vite.config.ts'))], devEnv)
