#!/usr/bin/env node
/**
 * The published entry point. It prefers the built CLI and falls back to the
 * TypeScript sources, so a linked checkout works before its first build.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Refuse clearly on an old Node, before anything imports the sources.
 *
 * `package.json#engines` says `>=24`, but npm only *warns* by default and `--engine-strict=false` is
 * common; `pnpm dlx` and a global install can both land on whatever `node` is first on `PATH`. Without
 * this the failure is whatever the first modern-API call throws — a `SyntaxError` deep in `dist/`, or
 * `Unknown option --import` from `tsx` — which says nothing about the actual cause.
 *
 * Checked here rather than in `src/` because `src/` is TypeScript: on an old Node it cannot be parsed
 * to run the check. Kept as a literal, matching `package.json#engines`, and
 * `test/scripts/node-floor.test.ts` fails if the two disagree — reading `package.json` at startup would
 * mean an `fs` call before the check that exists to report a missing runtime.
 */
const REQUIRED_MAJOR = 24
const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
if (!(major >= REQUIRED_MAJOR)) {
  process.stderr.write(
    `home-hosted needs Node ${REQUIRED_MAJOR} or newer — this is ${process.versions.node}.\n`
    + `Install a newer Node (https://nodejs.org) or run it with \`npx node@${REQUIRED_MAJOR} bin/home-hosted.mjs\`.\n`,
  )
  process.exit(1)
}

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const built = path.join(root, 'dist', 'cli.js')
const args = process.argv.slice(2)
const hasBuild = fs.existsSync(built)

const commandArgs = hasBuild
  ? [built, ...args]
  : ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args]

const child = spawn(process.execPath, commandArgs, {
  // The caller's directory is the project: relative entry paths resolve there.
  cwd: hasBuild ? process.cwd() : root,
  env: { ...process.env, HHOSTED_PROJECT: process.env.HHOSTED_PROJECT ?? process.cwd() },
  stdio: 'inherit',
})

child.once('error', (error) => {
  process.stderr.write(`home-hosted could not start: ${error.message}\n`)
  process.exit(1)
})
child.once('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1))
})
