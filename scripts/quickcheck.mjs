#!/usr/bin/env node
/**
 * The static half of the gate — lint, both type-checks, doc links — run in parallel, each with its
 * own on-disk cache, so a rerun after a small edit costs seconds instead of the ~100 s the four steps
 * took back to back. Every tool is started as `node <its JS entry>`: no shell and no `.cmd` shim, so
 * it behaves the same on Windows.
 *
 * Caches live under `node_modules/.cache/quickcheck/` (git-ignored, dropped by a fresh install).
 * `--no-cache` runs everything from scratch, which is what CI does anyway.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cacheDir = path.join(root, 'node_modules', '.cache', 'quickcheck')
const useCache = !process.argv.includes('--no-cache')
const bin = (...parts) => path.join(root, 'node_modules', ...parts)

const uis = fs.readdirSync(path.join(root, 'uis'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, 'uis', entry.name, 'tsconfig.json')))
  .map(entry => entry.name)
  .sort()

/** `tsc`/`vue-tsc` skip what did not change since the last run when given a build-info file. */
const incremental = name => useCache ? ['--incremental', '--tsBuildInfoFile', path.join(cacheDir, `${name}.tsbuildinfo`)] : []

const tasks = [
  {
    name: 'eslint',
    args: [bin('eslint', 'bin', 'eslint.js'), '.', ...(useCache ? ['--cache', '--cache-strategy', 'content', '--cache-location', path.join(cacheDir, 'eslint')] : [])],
  },
  { name: 'tsc', args: [bin('typescript', 'bin', 'tsc'), '--noEmit', ...incremental('root')] },
  ...uis.map(ui => ({
    name: `vue-tsc ${ui}`,
    args: [bin('vue-tsc', 'bin', 'vue-tsc.js'), '--noEmit', '-p', path.join('uis', ui, 'tsconfig.json'), ...incremental(`ui-${ui}`)],
  })),
  { name: 'doc links', args: [path.join(root, 'scripts', 'check-doc-links.mjs')] },
]

fs.mkdirSync(cacheDir, { recursive: true })

function run(task) {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, task.args, { cwd: root, env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' } })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', (error) => {
      output += String(error)
    })
    child.on('close', code => resolve({ ...task, code: code ?? 1, output, seconds: (Date.now() - started) / 1000 }))
  })
}

const started = Date.now()
const results = await Promise.all(tasks.map(run))
let failed = 0
for (const result of results) {
  const ok = result.code === 0
  if (!ok)
    failed += 1
  process.stdout.write(`${ok ? '✓' : '✗'} ${result.name} (${result.seconds.toFixed(1)}s)\n`)
  // A passing step stays quiet; a failing one prints everything it said.
  if (!ok && result.output.trim().length > 0)
    process.stdout.write(`${result.output.trimEnd()}\n\n`)
}
process.stdout.write(`quickcheck: ${failed === 0 ? 'passed' : `${failed} step(s) failed`} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
process.exitCode = failed === 0 ? 0 : 1
