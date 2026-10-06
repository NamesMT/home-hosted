#!/usr/bin/env node
/**
 * Prints the CHANGELOG.md section for one version — the body of the GitHub release.
 * changelogen generates the content (`npx changelogen --release -r <version>`), this
 * only lifts the section back out for `gh release create --notes-file`.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const version = (process.argv[2] ?? '').trim().replace(/^v/, '')
// Validated rather than escaped: escaping only the dots left every other metacharacter live, so
// `0.7.18)` threw `Unmatched ')'` as a stack trace instead of the one-line usage error. Unreachable
// from the workflow — `check-release-version.mjs` runs earlier in the same job and refuses this first
// — but the script is runnable by hand, and a stack trace names the wrong problem.
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Z.-]+)?$/i.test(version)) {
  console.error(`usage: release-notes.mjs <version>   (e.g. 0.7.18 or 0.7.18-rc.1)`)
  process.exit(1)
}

const file = path.join(fileURLToPath(new URL('..', import.meta.url)), 'CHANGELOG.md')
const lines = fs.readFileSync(file, 'utf8').split('\n')
const heading = new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}\\s*$`)
// module scope: some repos enable e18e/prefer-static-regex, which flags a regex
// literal that would be re-created on every callback invocation
const nextHeading = /^##\s/
const start = lines.findIndex(line => heading.test(line))

if (start === -1) {
  console.error(`[release] no "## v${version}" section in CHANGELOG.md`)
  process.exit(1)
}

let end = lines.findIndex((line, index) => index > start && nextHeading.test(line))
if (end === -1)
  end = lines.length

process.stdout.write(`${lines.slice(start + 1, end).join('\n').trim()}\n`)
