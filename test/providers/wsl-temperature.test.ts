import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isWsl, tempCommandFor, windowsScriptPath, wslScriptPath } from '#src/providers/wsl-temperature'

/**
 * The WSL2 temperature bridge.
 *
 * The trap here is a path that looks right in the guest and is invisible to `powershell.exe`: the
 * first version wrote the helper into `$HHOSTED_HOME/.hh` (a Linux path) and built the command from
 * it. It appeared to work, because a stale copy existed elsewhere; on a clean machine the command
 * named a path Windows cannot resolve, and the tile stayed `n/a` for a reason nothing printed.
 *
 * So the *translation* is what these cases pin, not the string concatenation.
 */
describe('the WSL temperature bridge', () => {
  it('translates a /mnt path to the Windows path powershell.exe needs', () => {
    expect(windowsScriptPath('/mnt/c/Tools/home-hosted/cpu-temp.ps1')).toBe('C:\\Tools\\home-hosted\\cpu-temp.ps1')
    // A drive other than C works the same way — the letter is captured, not assumed.
    expect(windowsScriptPath('/mnt/d/work/x.ps1')).toBe('D:\\work\\x.ps1')
  })

  it('leaves an untranslatable path alone rather than inventing a drive', () => {
    // A Linux home is not on a Windows drive. Returning it unchanged is honest; pretending it is
    // `C:\tmp\...` is how the original bug read as success.
    expect(windowsScriptPath('/tmp/x.ps1')).toBe('/tmp/x.ps1')
    expect(windowsScriptPath('/home/me/.hh/cpu-temp.ps1')).toBe('/home/me/.hh/cpu-temp.ps1')
  })

  it('builds the command from the translated path', () => {
    expect(tempCommandFor('/mnt/c/Tools/home-hosted/cpu-temp.ps1')).toBe(
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Tools\\home-hosted\\cpu-temp.ps1"',
    )
  })

  it('writes the helper under /mnt/c on this WSL guest, and nowhere else', () => {
    if (!isWsl()) {
      // The rest of the suite runs on Linux CI and macOS; the path decision is WSL-only.
      expect(wslScriptPath()).toBeNull()
      return
    }
    const target = wslScriptPath()
    expect(target).not.toBeNull()
    // The whole point: powershell.exe must be able to read it.
    expect(target!.startsWith('/mnt/')).toBe(true)
  })
})

/**
 * A setup that cannot work must not look configured.
 *
 * The first version saved `tempCommand` *before* probing the helper, so on a machine without
 * LibreHardwareMonitor the config claimed a temperature source while every sample ran a failing
 * PowerShell and the tile stayed `n/a`. That is the one state a person cannot diagnose: the settings
 * page says "configured", the tile says "n/a", and nothing connects them.
 *
 * The rule is order, and order is what a source scan can see.
 */
describe('setup probes before it saves', () => {
  it('writes the command only after the helper answered', () => {
    const source = readFileSync(new URL('../../src/api/wsl-temperature.ts', import.meta.url), 'utf8')
    const post = source.slice(source.indexOf('.post('), source.indexOf('.delete('))
    const probeAt = post.indexOf('probeWslTemperature')
    const saveAt = post.indexOf('updateHost')
    expect(probeAt, 'the POST route must probe').toBeGreaterThan(-1)
    expect(saveAt, 'the POST route must save').toBeGreaterThan(-1)
    expect(probeAt, 'probing must come before saving, or a broken setup reads as configured').toBeLessThan(saveAt)
  })

  it('the CLI does the same', () => {
    const source = readFileSync(new URL('../../src/cli/setup-temp.ts', import.meta.url), 'utf8')
    const wsl = source.slice(source.indexOf('source === \'wsl\''))
    expect(wsl.indexOf('probeWslTemperature'), 'the CLI must probe').toBeGreaterThan(-1)
    expect(wsl.indexOf('updateHost'), 'the CLI must save').toBeGreaterThan(-1)
    expect(wsl.indexOf('probeWslTemperature'), 'a broken setup must not reach the config').toBeLessThan(wsl.indexOf('updateHost'))
  })
})
