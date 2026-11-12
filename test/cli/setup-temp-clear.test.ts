import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearTemperatureSource } from '#src/cli/setup-temp'
import { GlobalSettingsStore } from '#src/config/settings'
import { tempCommandFor } from '#src/providers/wsl-temperature'
import { configJson } from '../support/config-fixture'

/**
 * `setup-temp --clear` and the machine-wide helper.
 *
 * The helper lives beside the library in a directory every account on the machine resolves, so a
 * second home may run it. `--clear` deleted it whenever it existed, and even when this home's
 * settings could not be read. Every path here is a temp file — never the real helper.
 */
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setup(tempCommand: string | null): { store: GlobalSettingsStore, helper: string, settings: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-setup-temp-clear-'))
  dirs.push(dir)
  const helper = path.join(dir, 'cpu-temp.ps1')
  fs.writeFileSync(helper, '# helper')
  const settings = path.join(dir, 'settings.json')
  fs.writeFileSync(settings, tempCommand === null ? '{ nope' : configJson({ host: { tempCommand } }))
  const store = new GlobalSettingsStore(settings)
  store.load({ write: false })
  return { store, helper, settings }
}

describe('setup-temp --clear', () => {
  it('deletes the helper when this home\'s command runs it', () => {
    const { store, helper } = setup('')
    store.updateHost({ tempCommand: tempCommandFor(helper) })

    const result = clearTemperatureSource(store, helper)

    expect(result.ok).toBe(true)
    expect(store.host.tempCommand).toBe('')
    expect(fs.existsSync(helper)).toBe(false)
  })

  it('leaves a helper another home may use, and says so', () => {
    const { store, helper } = setup('cat /sys/class/thermal/thermal_zone0/temp')

    const result = clearTemperatureSource(store, helper)

    expect(store.host.tempCommand).toBe('')
    expect(fs.existsSync(helper)).toBe(true)
    expect(result.ok && result.lines.join('\n')).toContain('left in place')
  })

  it('leaves the helper when no command is set at all', () => {
    const { store, helper } = setup('')

    const result = clearTemperatureSource(store, helper)

    expect(fs.existsSync(helper)).toBe(true)
    expect(result.ok && result.lines.join('\n')).toContain('nothing to clear')
  })

  it('refuses, and touches nothing, when this home\'s settings cannot be read', () => {
    const { store, helper, settings } = setup(null)

    const result = clearTemperatureSource(store, helper)

    expect(result.ok).toBe(false)
    expect(fs.existsSync(helper)).toBe(true)
    expect(fs.readFileSync(settings, 'utf8')).toBe('{ nope')
  })
})
