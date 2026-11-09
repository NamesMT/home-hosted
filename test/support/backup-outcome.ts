/** Homes, archives and workspaces for the `backup restore` outcome suites (`test/cli/backup-restore-*.test.ts`). */
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { expect } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { createZip, extractZip, listZip } from '#src/providers/archive'
import { runCli } from './run-cli'

const dirs: string[] = []

/** Removes every scratch dir made since the last call; each test file runs it `afterEach`. */
export function cleanScratch(): void {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
}

export function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Builds a zip by hand, for the entries a real archive can never carry. */
export async function makeZip(file: string, entries: Record<string, string>): Promise<void> {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  for (const [name, content] of Object.entries(entries))
    await writer.add(name, new Uint8ArrayReader(Buffer.from(content)))
  fs.writeFileSync(file, await writer.close())
}

/** A home the CLI can act on, with the `.backups` directory a person drops an archive into. */
export function makeHome(): { home: string, backups: string } {
  const home = scratch('hh-outcome-')
  const backups = path.join(home, '.hh', '.backups')
  fs.mkdirSync(backups, { recursive: true })
  return { home, backups }
}

/** A real archive taken on this home — the shape a valid DR archive has. */
export function takeArchive(home: string): string {
  const created = runCli(['backup', 'create', '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
  expect(created.status, created.output).toBe(0)
  const name = fs.readdirSync(path.join(home, '.hh', '.backups')).find(entry => entry.endsWith('.zip'))
  expect(name).toBeDefined()
  return name!
}

/**
 * Rewrite one file inside an archive, through the same provider the service uses.
 *
 * Reached only by this test: nothing in the product rewrites an archive, and no real archive can
 * carry a manifest from a release that has not shipped yet.
 */
export async function rewriteArchive(archivePath: string, file: string, contents: string): Promise<void> {
  const work = scratch('hh-outcome-rewrite-')
  const entries = await listZip(archivePath)
  await extractZip(archivePath, work, { names: entries.map(entry => entry.name) })
  fs.writeFileSync(path.join(work, file), contents)
  fs.rmSync(archivePath)
  await createZip(work, archivePath)
}

/**
 * One workspace whose entry declares `dump` and never `load`.
 *
 * That is the shape a real home has after someone adds a dump hook and forgets the load half: the
 * archive carries a dump, and the restore stages one nothing will replay.
 */
export function writeDumpingWorkspace(home: string): void {
  const dir = path.join(home, '.hh', 'default')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = { writtenBy: 'test', schema: CONFIG_SCHEMA }
  fs.writeFileSync(path.join(home, '.hh', 'settings.json'), `${JSON.stringify({ meta: stamp, backups: { dir: '.backups', keep: 5, enabled: true } }, null, 2)}\n`)
  fs.writeFileSync(path.join(home, '.hh', 'workspaces.json'), `${JSON.stringify({ workspaces: [{ id: 'default', label: 'Default' }] })}\n`)
  fs.writeFileSync(path.join(dir, 'settings.json'), `${JSON.stringify({ meta: stamp, logs: {} }, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, 'servers.config.json'), `${JSON.stringify({
    meta: stamp,
    servers: [{
      id: 'app',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      dump: { command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1] + "/db.archive", "D")', '{dumpDir}'] },
    }],
  }, null, 2)}\n`)
}
