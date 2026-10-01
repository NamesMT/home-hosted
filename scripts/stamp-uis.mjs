#!/usr/bin/env node
/**
 * Stamps each UI's `ui.json` when the commit that changes it is made.
 *
 * The version is a deliberate choice — patch for a fix, minor for a feature, major only for
 * a rewrite or a restyle — so this never guesses one. It checks that a UI whose *shipped*
 * files this commit touches had its version raised, and stamps `unix` with the commit's own
 * epoch. Doing that here rather than at each edit is what keeps the number meaningful:
 * `unix` is when the asset was committed, not when somebody happened to open the file.
 *
 * Runs from the pre-commit hook, after `lint-staged`. `uis/<name>/test/**` is not part of the
 * built asset, so a test-only change needs no bump; the built `dist/` is not committed at all.
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

/** The UIs this commit changes something shipped by. */
const touched = new Set()
for (const file of staged) {
  const name = /^uis\/([^/]+)\//.exec(file)?.[1]
  // Tests are not in the asset, so changing one does not ship a new UI.
  if (name !== undefined && !file.startsWith(`uis/${name}/test/`))
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

  meta.unix = Math.floor(Date.now() / 1000)
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  git('add', path.relative(root, metaPath))
  process.stdout.write(`[uis] ${name}: ${committed ?? '(new)'} -> ${meta.version}, unix stamped\n`)
}

if (problems.length > 0) {
  for (const problem of problems)
    process.stderr.write(`[uis] ${problem}\n`)
  process.stderr.write('[uis] raise the version first — patch for a fix, minor for a feature, major only for a rewrite or a restyle\n')
  process.exit(1)
}
