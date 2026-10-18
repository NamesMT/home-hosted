#!/usr/bin/env node
/**
 * Checks that each UI whose *shipped* files this commit changes had its `ui.json` version raised.
 *
 * The version is a deliberate choice — patch for a fix, minor for a feature, major only for
 * a rewrite or a restyle — so this never guesses one. Nothing here writes: `tag` and `unix`
 * describe the *build*, and `build-uis.mjs` stamps them into `dist/`, never into the source.
 *
 * Runs from the pre-commit hook, after `lint-staged`. A UI's `test/` and its own `README.md` are not
 * part of the built asset, so changing only those needs no bump; the built `dist/` is not committed
 * at all.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
  .split('\n')
  .filter(line => line.trim().length > 0)

/**
 * The UIs this commit changes something shipped by.
 *
 * Two paths under a UI are not in the built asset, so editing one ships nothing and needs no bump:
 * `test/`, and the UI's own `README.md` — a person's notes about the UI, not a file it serves.
 * Everything else is a build input: `src/`, `public/`, `index.html`, `vite.config.ts`, and the
 * `i18n/` sheet the catalogs are generated from.
 */
const NOT_SHIPPED = [/^test\//, /^README\.md$/]
const touched = new Set()
for (const file of staged) {
  const match = /^uis\/([^/]+)\/(.+)$/.exec(file)
  if (match === null)
    continue
  const [, name, relative] = match
  if (!NOT_SHIPPED.some(pattern => pattern.test(relative)))
    touched.add(name)
}

if (touched.size === 0)
  process.exit(0)

const problems = []
for (const name of [...touched].sort()) {
  const metaPath = path.join(root, 'uis', name, 'public', 'ui.json')
  if (!fs.existsSync(metaPath))
    continue

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  let committed = null
  try {
    committed = JSON.parse(git('show', `HEAD:uis/${name}/public/ui.json`)).version
  }
  catch {
    // A UI this commit adds has nothing to compare against.
  }

  if (committed === meta.version) {
    problems.push(`uis/${name}/public/ui.json is still ${meta.version}, but this commit changes what that UI ships`)
    continue
  }

  process.stdout.write(`[uis] ${name}: ${committed ?? '(new)'} -> ${meta.version}\n`)
}

if (problems.length > 0) {
  for (const problem of problems)
    process.stderr.write(`[uis] ${problem}\n`)
  process.stderr.write('[uis] raise the version first — patch for a fix, minor for a feature, major only for a rewrite or a restyle\n')
  process.exit(1)
}
