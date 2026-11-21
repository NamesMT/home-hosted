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
// Split on any line ending. With CR-only the file is one line, so the anchored `^##` never matches
// and this reports a missing section for a version that exists. Latent rather than live — CI is Linux
// and a Windows `core.autocrlf` checkout gives CRLF, which works — but the failure is silent and
// blames the changelog rather than the ending.
const lines = fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/)
const heading = new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}\\s*$`)
// module scope: some repos enable e18e/prefer-static-regex, which flags a regex
// literal that would be re-created on every callback invocation
const nextHeading = /^##\s/
const start = lines.findIndex(line => heading.test(line))

if (start === -1) {
  console.error(
    `[release] no "## v${version}" section in CHANGELOG.md — the body cannot be built.\n`
    + `This script runs after changelogen in the release workflow, so an absent section means the`
    + ` changelog step did not write one for ${version}: check that its --release succeeded and that`
    + ` the tag it wrote is the version being published.`,
  )
  process.exit(1)
}

let end = lines.findIndex((line, index) => index > start && nextHeading.test(line))
if (end === -1)
  end = lines.length

const changelog = lines.slice(start + 1, end).join('\n').trim()

/**
 * Every migration a person upgrading to this version has to read.
 *
 * The CHANGELOG is derived from commit subjects, so it names *what changed* and never *what to do
 * about it* — a `fix(auth):` line with no `!` does not even read as breaking, and a BREAKING CHANGE
 * footer's prose stays in git. A release body is what most people read, so the migrations are lifted
 * from `.agentDocs/UPGRADING.md` and put above the commit list rather than left behind.
 *
 * **All of them up to this version, not only the one whose number matches.** This branch had
 * accumulated three releases' worth of breaking work — the account model, the 12-character exposure
 * bar, and jobs leaving the server entry — with a section written for each of `0.14.0`, `0.15.0` and
 * `0.16.0`, as though they would ship one after another. They will not: `package.json` was still at
 * `0.13.0`, so whichever single version gets dispatched ships all three changes while the body
 * printed the migration for **one** of them. The two it dropped are precisely the ones a person must
 * act on, which makes this worse than printing nothing.
 *
 * Sections are picked by comparing version triples numerically, so the order they appear in the file
 * does not matter and `0.14.0` sorts below `0.16.0` however the file is arranged.
 */
function migrationsTo(version) {
  const upgrading = path.join(fileURLToPath(new URL('..', import.meta.url)), '.agentDocs', 'UPGRADING.md')
  if (!fs.existsSync(upgrading))
    return []
  const source = fs.readFileSync(upgrading, 'utf8').split(/\r\n|\r|\n/)
  const headings = source
    .map((line, index) => ({ line, index }))
    .map(({ line, index }) => ({ matched: /^##\s+v?(\d+(?:\.\d+){2}(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(line), index }))
    .filter(entry => entry.matched !== null)
    .map(entry => ({ index: entry.index, version: entry.matched[1] }))

  const triples = text => text.split('.').slice(0, 3).map(part => Number.parseInt(part, 10))
  const target = triples(version)
  const earlier = headings.filter((heading) => {
    const candidate = triples(heading.version)
    for (let index = 0; index < 3; index += 1) {
      if (candidate[index] !== target[index])
        return candidate[index] < target[index]
    }
    // Equal triples: this is the version being released, and its own section belongs in the body.
    // Returning `false` here is what dropped it — the first version of this only ever printed the
    // sections *below* the target, so a release whose migration was written for exactly its own
    // number shipped without it.
    return true
  })

  return earlier
    .map((heading) => {
      const next = headings.find(other => other.index > heading.index)
      const body = source.slice(heading.index + 1, next === undefined ? source.length : next.index).join('\n').trim()
      return { version: heading.version, body }
    })
    .filter(entry => entry.body.length > 0)
    .sort((left, right) => {
      const a = triples(left.version)
      const b = triples(right.version)
      for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index])
          return a[index] - b[index]
      }
      return 0
    })
}

const migrations = migrationsTo(version)
/**
 * Oldest first, which is the order they must be applied in. One section needs no sub-heading; several
 * do, or a reader cannot tell which release each paragraph belongs to.
 */
const migration = migrations.length === 0
  ? null
  : migrations
      .map(entry => (migrations.length === 1 ? entry.body : `### ${entry.version}\n\n${entry.body}`))
      .join('\n\n')

process.stdout.write(migration === null
  ? `${changelog}\n`
  : `## Upgrading\n\n${migration}\n\n---\n\n${changelog}\n`)
