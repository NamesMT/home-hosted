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
 *   HHOSTED_DEV_PANEL_PORT=6010 pnpm dev
 */
// @ts-check
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

const DEFAULT_PANEL_PORT = 6000
const DEFAULT_UI_PORT = 6001

function parseArgs(argv) {
  const options = { ui: 'stock', panelPort: undefined, uiPort: undefined, passthrough: [] }
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
]

const children = []

function run(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    shell: false,
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

// Dev state lives in `.dev-state/`, so trying things out never touches ~/.home-hosted.
const devEnv = {
  HHOSTED_HOME: process.env.HHOSTED_HOME ?? path.join(root, '.dev-state'),
  HHOSTED_PROJECT: process.env.HHOSTED_PROJECT ?? root,
  HHOSTED_DEV_UI_PORT: String(options.uiPort),
  HHOSTED_DEV_PANEL: `http://127.0.0.1:${options.panelPort}`,
}

process.stdout.write(`panel    http://127.0.0.1:${options.panelPort}\n`)
process.stdout.write(`${options.ui.padEnd(8)} http://127.0.0.1:${options.uiPort}\n`)

run('control', 'pnpm', panelArgs, devEnv)
run(`${options.ui} ui`, 'pnpm', ['exec', 'vite', '--config', path.relative(root, path.join(uiDir, 'vite.config.ts'))], devEnv)
