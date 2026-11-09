import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { smokeRunner } from '../support/cli-smoke'
import { devPortAllocator } from '../support/dev-port'

/** This file's own slice of the dev range; every other `cli-status*` / `cli-print-config` file holds its own. */
const freeDevPort = devPortAllocator(6900, 6999)

/**
 * `--print-config` promises to print and exit, so it must not leave anything behind — and it must
 * answer on the one home a person most wants to inspect: a running panel's.
 *
 * Both halves were wrong. It ran *after* the boot-password branch, so asking a fresh home what it
 * would read wrote `.control-secrets.json` with the default `hh` in it; the next real `up` then
 * started on the boot password, and `set-password` was the only way back. And it ran *after* the
 * live-record guard, so `up --print-config` on a running panel answered "already running" and
 * exited 1 — for a command that starts nothing and whose whole purpose is reading.
 *
 * Both are asserted by observable file state and exit code, not by the sentence: a test that only
 * grepped the message would pass again the moment the write moved.
 */
describe('print-config leaves the home alone', () => {
  it('writes no credential on a home that has none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-print-config-'))
    try {
      const printed = smokeRunner(dir)(['up', '--print-config'])

      expect(printed.status, printed.stderr).toBe(0)
      // It really did print the config, so the assertion below is not "it did nothing".
      expect(() => JSON.parse(printed.stdout)).not.toThrow()
      expect(
        fs.existsSync(path.join(dir, '.hh', '.control-secrets.json')),
        'a read-only command must not arm a password',
      ).toBe(false)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers while a panel is running, instead of refusing as a second instance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-print-config-'))
    const port = await freeDevPort()
    try {
      const started = smokeRunner(dir)(['up', '--port', String(port), '--no-autostart'])
      expect(started.status, started.stderr).toBe(0)

      const printed = smokeRunner(dir)(['up', '--print-config'])

      expect(printed.stderr, 'a read-only command is not the second panel to refuse').not.toContain('already running')
      expect(printed.status, printed.stderr).toBe(0)
      expect(() => JSON.parse(printed.stdout), printed.stdout).not.toThrow()
    }
    finally {
      smokeRunner(dir)(['down'])
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
