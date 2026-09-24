#!/usr/bin/env node
/** Type-checks every UI under `uis/` — each one carries its own tsconfig. */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const uisDir = path.join(root, 'uis')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const uis = fs.readdirSync(uisDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(uisDir, entry.name, 'tsconfig.json')))
  .map(entry => entry.name)
  .sort()

if (uis.length === 0) {
  console.error(`[uis] no UI with a tsconfig.json under ${uisDir}`)
  process.exit(1)
}

for (const name of uis) {
  process.stdout.write(`[uis] vue-tsc ${name}\n`)
  execFileSync(pnpm, ['exec', 'vue-tsc', '--noEmit', '-p', path.join('uis', name, 'tsconfig.json')], {
    cwd: root,
    stdio: 'inherit',
  })
}
