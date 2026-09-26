#!/usr/bin/env node
/** Validates the version a release workflow was dispatched with. */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const requested = (process.argv[2] ?? '').trim()
const { version: current } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Z.-]+)?$/i.test(requested)) {
  console.error(`[release] "${requested}" is not a version — expected 1.2.3 or 1.2.3-rc.1`)
  process.exit(1)
}

function compare(left, right) {
  const a = left.split('-')[0].split('.').map(Number)
  const b = right.split('-')[0].split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1
  }
  return left === right ? 0 : left.includes('-') ? -1 : 1
}

if (compare(requested, current) <= 0) {
  console.error(`[release] "${requested}" is not greater than the current ${current}`)
  process.exit(1)
}

/**
 * Below 1.0 the *minor* is the breaking channel, so the channel has to agree with the
 * commits being shipped: a patch carrying a `!`/`BREAKING CHANGE` publishes a breaking
 * change as a fix, and a minor with none is the usual sign that a patch was meant.
 * Returns the subjects of the breaking commits since the last tag.
 */
function breakingCommits() {
  let range = 'HEAD'
  try {
    const lastTag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: root, encoding: 'utf8' }).trim()
    if (lastTag.length > 0)
      range = `${lastTag}..HEAD`
  }
  catch {
    // No tag yet: every commit counts as pending.
  }

  let log = ''
  try {
    log = execFileSync('git', ['log', range, '--format=%s%x00%b%x01'], { cwd: root, encoding: 'utf8' })
  }
  catch {
    return []
  }

  const subjects = []
  for (const entry of log.split('\x01')) {
    const [subject = '', body = ''] = entry.split('\x00')
    if (subject.trim().length === 0)
      continue
    if (/^[a-z]+(?:\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(body))
      subjects.push(subject.trim())
  }
  return subjects
}

const [requestedMajor, requestedMinor] = requested.split('-')[0].split('.').map(Number)
const [currentMajor, currentMinor] = current.split('-')[0].split('.').map(Number)
const breaking = breakingCommits()
const isPatch = requestedMajor === currentMajor && requestedMinor === currentMinor

if (isPatch && breaking.length > 0) {
  console.error(`[release] "${requested}" is a patch, but ${breaking.length} breaking commit(s) are pending:`)
  for (const subject of breaking)
    console.error(`[release]   ${subject}`)
  console.error('[release] below 1.0 the minor is the breaking channel — dispatch a 0.Y.0 release instead')
  process.exit(1)
}

if (!isPatch && requestedMajor === 0 && breaking.length === 0) {
  console.warn(`[release] "${requested}" is a minor with no breaking commit pending; below 1.0 that channel means "read the release notes" — a patch may be what you meant`)
}

console.log(`[release] ${current} -> ${requested}`)
