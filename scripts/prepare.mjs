#!/usr/bin/env node
/**
 * `prepare`: set up a **checkout**, and never fail a **consumer's** install.
 *
 * `package.json#prepare` runs in three quite different situations, and the old one-liner
 * (`simple-git-hooks && pnpm run build:locales`) only suited the first:
 *
 *  1. `pnpm install` in this repository — the contributor case, where both halves are wanted:
 *     install the git hooks, and generate the i18n catalogs the stock suite imports.
 *  2. `npm install <tarball>` — `prepare` does **not** run from a registry tarball, but it does for a
 *     `file:` or git dependency. There is no `.git`, no `simple-git-hooks` binary (it is a
 *     devDependency, so absent), and quite possibly no `pnpm` on the machine.
 *  3. The release workflow's `prepack`, which is a different script entirely.
 *
 * Case 2 used to fail with `/bin/sh: simple-git-hooks: command not found`. npm 11 hides it behind its
 * "install scripts not yet approved" warning, so the breakage was invisible here and would have shown
 * up on an older npm as a failed install of a package whose only job is to be installed.
 *
 * So both halves are conditional and non-fatal: hooks only where there is a `.git` **and** the binary,
 * catalogs only where the sheets exist. `build-uis.mjs` already generates the catalogs itself before a
 * build, so nothing is lost for publishing.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

/**
 * The repository's own `node_modules/.bin`, so a dev tool resolves even when the shell's `PATH` has no
 * pnpm — the same trap `scripts/dev.mjs` was fixed for.
 */
function localBin(tool) {
  const name = process.platform === 'win32' ? `${tool}.cmd` : tool
  const candidate = path.join(root, 'node_modules', '.bin', name)
  return fs.existsSync(candidate) ? candidate : null
}

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined || result.status !== 0) {
    // Never fatal: a checkout that cannot install its hooks is still a working checkout, and a
    // consumer install must not be undone by a step that was for contributors.
    const why = result.error !== undefined ? result.error.message : `exited ${result.status}`
    process.stderr.write(`[prepare] skipped ${label} (${why})\n`)
    return false
  }
  return true
}

// 1. Git hooks — only in a checkout, and only when the tool is actually installed.
if (fs.existsSync(path.join(root, '.git'))) {
  const hooks = localBin('simple-git-hooks')
  if (hooks === null)
    process.stderr.write('[prepare] simple-git-hooks is not installed — no git hooks set up\n')
  else
    run('git hooks', hooks, [])
}

// 2. The generated i18n catalogs — only when the sheets they come from are here.
const sheets = path.join(root, 'uis', 'stock', 'i18n', 'sheets')
if (fs.existsSync(sheets))
  run('i18n catalogs', process.execPath, [path.join(root, 'scripts', 'build-locales.mjs')])
