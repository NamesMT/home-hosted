#!/usr/bin/env node
/**
 * Dev runner: the control plane (tsx watch) and the Vite dev server for one UI,
 * so UI edits hot-reload while the API keeps running.
 *
 * Both default to the 6xxx range (panel 6000, UI 6001): an installed panel or
 * another dev instance may already hold 3999, and the panel's port preflight runs
 * before it refuses a broken config, so a busy default port fails unrelated tests
 * for the wrong reason.
 *
 *   pnpm dev                          # panel 6000 + stock UI 6001
 *   pnpm dev --ui noc-console         # panel 6000 + noc-console on 6001
 *   pnpm dev --port 6010 --ui-port 6011
 *   pnpm dev --home /tmp/hh-dev       # a state directory of your own
 *   HHOSTED_DEV_PANEL_PORT=6010 pnpm dev
 *
 * **State is `.dev-state/` unless you say otherwise, and never inherited silently.** An exported
 * `HHOSTED_HOME` (a shell profile, a container image) used to win here, so `pnpm dev` ran against
 * the real panel's state: with that panel stopped it would have booted on the live config and
 * rewritten its persisted listener to the dev port. `--home` is the explicit way to point it
 * somewhere else, and the default state may not be `~/.home-hosted` at all.
 */
// @ts-check
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

const DEFAULT_PANEL_PORT = 6000
const DEFAULT_UI_PORT = 6001
/** `resolveDataRoot()`'s own default: the one directory dev must never touch on its own. */
const REAL_STATE = path.join(os.homedir(), '.home-hosted')

function parseArgs(argv) {
  const options = { ui: 'stock', panelPort: undefined, uiPort: undefined, home: undefined, passthrough: [] }
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
    options.passthrough.push(arg)
  }
  options.uiPort ??= Number(process.env.HHOSTED_DEV_UI_PORT ?? DEFAULT_UI_PORT)
  options.panelPort ??= Number(process.env.HHOSTED_DEV_PANEL_PORT ?? DEFAULT_PANEL_PORT)
  return options
}

const options = parseArgs(process.argv.slice(2))

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

// `pnpm` is a `.cmd` shim on Windows and cannot be spawned without a shell. `scripts/build-uis.mjs`
// resolves the same way for the same reason.
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const children = []

function run(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    // Only Windows needs it, and only for the `.cmd` shim; a shell here on POSIX would re-parse
    // the argv and mangle a path containing a space.
    shell: process.platform === 'win32',
  })
  child.stdout.on('data', chunk => process.stdout.write(`[${label}] ${chunk}`))
  child.stderr.on('data', chunk => process.stderr.write(`[${label}] ${chunk}`))
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
if (options.home === undefined && process.env.HHOSTED_HOME !== undefined)
  process.stdout.write(`         (HHOSTED_HOME=${process.env.HHOSTED_HOME} is set and ignored — pass --home to use it)\n`)

run('control', pnpm, panelArgs, devEnv)
run(`${options.ui} ui`, pnpm, ['exec', 'vite', '--config', path.relative(root, path.join(uiDir, 'vite.config.ts'))], devEnv)
