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
