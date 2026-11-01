import cp from 'node:child_process'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetWslPaths, isWsl, LHM_RELEASE, LHM_SUBDIR, lhmDirectoryWindows, lhmInstalled, tempCommandFor, toGuestPath, windowsScriptPath, wslScriptPath, wslTemperatureStatus } from '#src/providers/wsl-temperature'

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
/** Decided once: a guest is a guest for the whole file. */
const onWsl = isWsl()

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

  /**
   * The path decision is WSL-only, so each platform gets its own case.
   *
   * An early `return` here reported a **pass** on Linux CI for a case that never ran — the shape
   * `.agentDocs/RELEASING.md` warns about. `it.runIf` over a condition computed once at module load
   * says "skipped", which is the truth.
   */
  it.runIf(onWsl)('writes the helper under /mnt/c on a WSL guest', () => {
    const target = wslScriptPath()
    expect(target).not.toBeNull()
    // The whole point: powershell.exe must be able to read it.
    expect(target!.startsWith('/mnt/')).toBe(true)
  })

  it.runIf(!onWsl)('answers null where there is no Windows drive to write to', () => {
    expect(wslScriptPath()).toBeNull()
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

/**
 * The pinned download, and where it lands.
 *
 * `%ProgramData%`, not `C:\Tools` and not `%LOCALAPPDATA%`. The first two were both wrong for the
 * same reason in opposite directions: a folder at the drive root clutters Explorer for every account,
 * while a per-user directory is *invisible to a service* — and the panel is documented as something
 * that starts on boot, which on Windows means session 0, usually SYSTEM, whose `%LOCALAPPDATA%` is
 * `C:\Windows\system32\config\systemprofile\AppData\Local`. ProgramData is the one path every account
 * on the box resolves the same way.
 */
describe('the LibreHardwareMonitor install', () => {
  it('pins a version and a sha256, not just a URL', () => {
    // A pinned version alone is not enough for a binary that is executed on every sample: the URL is a
    // redirect to a third-party CDN, and the digest is what makes a swapped asset fail closed.
    expect(LHM_RELEASE.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(LHM_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(LHM_RELEASE.url).toContain(LHM_RELEASE.version)
    expect(LHM_RELEASE.asset).toBe('LibreHardwareMonitor.zip')
  })

  it('installs under ProgramData, never at the drive root or in a per-user directory', () => {
    // The directory is read from the environment, so this asserts the *shape*: one `home-hosted`
    // segment under ProgramData. Asserting the absolute path would pin this machine's drive.
    expect(LHM_SUBDIR.startsWith('home-hosted')).toBe(true)
    expect(LHM_SUBDIR).not.toMatch(/^[A-Z]:/i)
  })

  it('locates the library in exactly one place', () => {
    // Two copies of "where is the DLL" is how the page came to say "not installed" right after the
    // installer had put it in `%ProgramData%`: `wslTemperatureStatus` kept a hardcoded `C:\Tools`
    // path while the installer wrote elsewhere. One predicate, or the two drift the moment one moves.
    const source = readFileSync(new URL('../../src/providers/wsl-temperature.ts', import.meta.url), 'utf8')
    const hardcoded = /['"]\/mnt['"]\s*,\s*['"]c['"]\s*,\s*['"]Tools['"]/.test(source)
    expect(hardcoded, 'no call site may rebuild the install path by hand').toBe(false)
    // The one lookup is `lhmInstalled`, and it must be what status reports.
    expect(source).toMatch(/const libraryPresent = lhmInstalled\(\)/)
  })

  it('translates a Windows path to one this process can read', () => {
    expect(toGuestPath('C:\\ProgramData\\home-hosted\\LibreHardwareMonitor')).toBe('/mnt/c/ProgramData/home-hosted/LibreHardwareMonitor')
    // The separator must be `/` on **this** platform too. Asserted as a string comparison that does
    // not go through `path`, because the bug this pins was `path.join` building the guest path with
    // the *host's* separator: green on Linux, `\\mnt\\c\\...` on the Windows gate.
    expect(toGuestPath('C:\\x')!.includes('\\')).toBe(false)
    expect(toGuestPath('C:\\x')!.startsWith('/mnt/')).toBe(true)
    // A system drive that is not C: is translatable too.
    expect(toGuestPath('D:\\ProgramData\\x')).toBe('/mnt/d/ProgramData/x')
    // A UNC path has no `/mnt` equivalent, so it is refused rather than guessed.
    expect(toGuestPath('\\\\server\\share\\x')).toBeNull()
  })
})

/**
 * The Windows side is read once, not once per request.
 *
 * Reaching it means spawning `powershell.exe` across the 9p mount — measured at ~360 ms here, and
 * spent **synchronously**, so the whole event loop stops: the tick, the SSE hub and every in-flight
 * response wait behind it. A bridge-state read did it twice, once for the install directory and once
 * inside `lhmInstalled`, so `GET /api/host/temperature` — a route the settings page calls whenever it
 * opens — blocked the panel for ~720 ms. Measured on this guest: 2 spawns, 719 ms, one request.
 *
 * This is the `lanAddress()` rule applied to a worse call: cache the host read on its own clock. The
 * counter is the seam, because no test can time a syscall reliably, but a spawn count is exact.
 */
describe('the Windows path is read once, not per request', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    forgetWslPaths()
  })

  /** Counts `execFileSync` calls and answers the fake Windows side. */
  function installWindows(programData: string | null): { calls: () => number } {
    let calls = 0
    vi.spyOn(cp, 'execFileSync').mockImplementation((() => {
      calls += 1
      if (programData === null)
        throw new Error('powershell.exe is not available')
      return programData
    }) as never)
    return { calls: () => calls }
  }

  it('reads %ProgramData% once however many times the status is asked for', () => {
    forgetWslPaths()
    const windows = installWindows('C:\\ProgramData')

    // A settings page load, a sample, and a second page load: one read between them.
    for (let index = 0; index < 20; index++)
      wslTemperatureStatus(wslScriptPath(), '')

    expect(windows.calls()).toBe(1)
    // The path itself is a WSL-only translation; the *count* above is the rule this pins.
    if (onWsl)
      expect(wslScriptPath()).toBe('/mnt/c/ProgramData/home-hosted/cpu-temp.ps1')
  })

  it('keeps the answer `lhmInstalled` shares, so a status read spawns nothing at all', () => {
    forgetWslPaths()
    const windows = installWindows('D:\\ProgramData')

    const first = wslTemperatureStatus(wslScriptPath(), '')
    const callsAfterFirst = windows.calls()

    // Everything a second request does, including the library check the status reads.
    wslTemperatureStatus(wslScriptPath(), '')
    lhmInstalled()
    lhmDirectoryWindows()

    expect(windows.calls()).toBe(callsAfterFirst)
    if (onWsl)
      expect(wslScriptPath()).toBe('/mnt/d/ProgramData/home-hosted/cpu-temp.ps1')
    expect(first.supported).toBe(onWsl)
  })

  it('does not cache a failed read, so one interop hiccup is not permanent', () => {
    forgetWslPaths()
    // A first failure: `powershell.exe` was not on PATH for this process.
    let calls = 0
    vi.spyOn(cp, 'execFileSync').mockImplementation((() => {
      calls += 1
      if (calls === 1)
        throw new Error('spawnSync powershell.exe ENOENT')
      return 'C:\\ProgramData'
    }) as never)

    expect(lhmDirectoryWindows()).toBeNull()
    // The retry is what makes a transient failure survivable: `%ProgramData%` never changes, so a
    // cached *success* is safe forever, but a cached failure would outlive its cause.
    expect(lhmDirectoryWindows()).toBe('C:\\ProgramData\\home-hosted\\LibreHardwareMonitor')
    expect(calls).toBe(2)
  })

  it('reports no library when the Windows side cannot be reached', () => {
    forgetWslPaths()
    installWindows(null)
    // A guest with no `powershell.exe` on PATH is a real state (interop disabled), and `n/a` is the
    // honest answer rather than a throw from a settings route.
    expect(lhmDirectoryWindows()).toBeNull()
    expect(lhmInstalled()).toBe(false)
  })
})
