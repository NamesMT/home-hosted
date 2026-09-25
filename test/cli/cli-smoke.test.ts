import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * One cheap spawned-process guard: the curated `--help` still lists every
 * command and flag, and an unknown command still exits 1 with the old text.
 * `--help` is answered before any state module resolves, and the throwaway home
 * keeps the suite away from a real one.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-cli-smoke-'))

function runCli(args: string[]): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HHOSTED_HOME: home, HHOSTED_PROJECT: home },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('cli smoke', () => {
  it('--help exits 0 and still lists every command and curated flag', () => {
    const help = runCli(['--help'])
    expect(help.status).toBe(0)

    for (const command of ['up', 'down', 'restart', 'status', 'set-password', 'set-token', 'migrate', 'init', 'ui-switch', 'ui-revert'])
      expect(help.stdout, command).toContain(command)

    for (const flag of ['--config', '--port', '--host', '--open', '--no-autostart', '--foreground', '--print-config', '--home', '--project'])
      expect(help.stdout, flag).toContain(flag)

    expect(help.stdout).toContain('Options for up/restart')
    expect(help.stdout).toContain('Environment')
  })

  it('an unknown command exits 1 with the usage and the old wording', () => {
    const result = runCli(['nonsense'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unknown command: nonsense')
    expect(result.stderr).toContain('home-hosted — a control panel')
  })

  it('--version prints the package version', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
    const result = runCli(['--version'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(manifest.version)
  })
})
