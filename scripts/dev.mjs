#!/usr/bin/env node
/**
 * Dev runner: the control plane (tsx watch) and the Vite dev server for the SPA,
 * so UI edits hot-reload while the API keeps running on 3999.
 */
// @ts-check
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const passthrough = process.argv.slice(2)

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
}

run('control', 'pnpm', ['exec', 'tsx', 'watch', 'src/cli.ts', 'up', '--foreground', ...passthrough], devEnv)
run('stock ui', 'pnpm', ['exec', 'vite', '--config', 'uis/stock/vite.config.ts'], devEnv)
