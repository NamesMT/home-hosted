import type { WslTemperatureStatus } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import cp from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { logger } from '#src/helpers/logger'

const execFileAsync = promisify(cp.execFile)

/**
 * The WSL2 temperature bridge: a PowerShell helper that becomes `host.tempCommand`.
 *
 * A WSL2 guest has no sensor the kernel can read, and Windows' own ACPI class answers a constant
 * 20 °C whatever the load. LibreHardwareMonitor reads the real value. Opt-in and reversible.
 */

/** The script that prints the CPU temperature, written beside the panel's own state. */
const SCRIPT_NAME = 'cpu-temp.ps1'

/**
 * `%ProgramData%`, not `%LOCALAPPDATA%`: a boot-started panel is SYSTEM in session 0, whose per-user
 * path differs. Not the drive root either — that clutters every account's Explorer.
 */
export const LHM_SUBDIR = 'home-hosted\\LibreHardwareMonitor'

/**
 * The last successful read of the Windows side, kept for this process's life.
 *
 * A **success** is permanent because `%ProgramData%` is a property of the host and cannot move under
 * a running panel. A failure is never stored: `powershell.exe` missing from this process's `PATH`, or
 * a transient interop hiccup, says nothing about the machine, and caching it would make one bad
 * moment permanent. A failed read costs an `ENOENT` — the 360 ms is the successful spawn.
 */
let windowsBase: string | null = null

/**
 * `$env:ProgramData` from the Windows side, read **once**.
 *
 * `powershell.exe` across the 9p mount measured ~360 ms here, and this is a **synchronous** spawn: it
 * stops the whole event loop, so the tick, the SSE hub and every in-flight request wait behind it.
 * Every bridge-state read did it twice — once for the install directory, once for the library — which
 * made `GET /api/host/temperature` block the panel for ~720 ms, on a route the settings page calls
 * whenever it opens. Same rule as `lanAddress()`: a host read on a request path is cached, never
 * paid per call.
 */
function windowsProgramData(): string | null {
  if (windowsBase !== null)
    return windowsBase

  try {
    const base = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$env:ProgramData'], { timeout: 10_000, windowsHide: true, encoding: 'utf8' }).trim()
    if (base.length > 0)
      windowsBase = base
  }
  catch {
    // Not cached: see above.
  }
  return windowsBase
}

/** The install directory in Windows terms, read from the environment (the system drive may not be `C:`). */
export function lhmDirectoryWindows(): string | null {
  const base = windowsProgramData()
  return base === null ? null : path.win32.join(base, LHM_SUBDIR)
}

/** Forgets the cached Windows path. A test that simulates the Windows side calls this first. */
export function forgetWslPaths(): void {
  windowsBase = null
}

/** A Windows path as a path this process can read: `C:\x` -> `/mnt/c/x`. */
export function toGuestPath(windowsPath: string): string | null {
  const match = /^([a-z]):\\(.*)$/i.exec(windowsPath)
  if (match === null)
    return null
  // `path.posix`, not `path.join`: this is always a *Linux guest* path, and on a Windows checkout
  // `path.join` would build it with backslashes — which is how the Windows gate caught this.
  return path.posix.join('/mnt', match[1]!.toLowerCase(), ...match[2]!.split('\\'))
}

/**
 * A guest directory standing in for `%ProgramData%`, set by the test setup for every test file and
 * every CLI it spawns. The helper and library live there machine-wide, shared by every home, so a
 * test run that reached the real one wrote over — and `--clear` deleted — a person's working bridge.
 */
function programDataOverride(): string | null {
  const dir = process.env.HHOSTED_TEST_PROGRAMDATA?.trim()
  return dir === undefined || dir.length === 0 ? null : dir
}

/** The install directory as a guest path, or null when the Windows side cannot be reached. */
export function lhmDirectory(): string | null {
  const override = programDataOverride()
  if (override !== null)
    return path.join(override, ...LHM_SUBDIR.split('\\'))
  const windows = lhmDirectoryWindows()
  return windows === null ? null : toGuestPath(windows)
}

/**
 * Whether this process is a WSL2 guest.
 *
 * `os.release()` carries `microsoft-standard-WSL2`, and `/proc/version` the same — checked on both
 * because a future WSL may rename the release while the version line keeps the vendor.
 */
export function isWsl(): boolean {
  if (process.platform !== 'linux')
    return false
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'))
  }
  catch {
    return false
  }
}

/** A `/mnt/c/...` path as the `C:\...` path `powershell.exe` needs. Untranslatable paths pass through. */
export function windowsScriptPath(scriptPath: string): string {
  // `/mnt/c/Users/me/x.ps1` is `C:\Users\me\x.ps1` to powershell.exe.
  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(scriptPath)
  if (match === null)
    return scriptPath
  return `${match[1]!.toUpperCase()}:\\${match[2]!.replaceAll('/', '\\')}`
}

/** The helper script, written beside the library so every account resolves the same file. */
export function wslScriptPath(): string | null {
  if (!isWsl())
    return null
  const override = programDataOverride()
  if (override !== null)
    return path.join(override, 'home-hosted', SCRIPT_NAME)
  const base = lhmDirectoryWindows()
  const guest = base === null ? null : toGuestPath(path.win32.dirname(base))
  if (guest === null)
    return null
  return path.join(guest, SCRIPT_NAME)
}

/** The `powershell.exe` invocation that runs `scriptPath` and prints the temperature. */
export function tempCommandFor(scriptPath: string): string {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${windowsScriptPath(scriptPath)}"`
}

/** The script's body. Kept tiny: it runs on every host sample. */
function scriptBody(): string {
  return `# CPU temperature for home-hosted. Written by \`home-hosted setup-temp --wsl\`; safe to delete.
$dir = Join-Path $env:ProgramData 'home-hosted\\LibreHardwareMonitor'
if (-not (Test-Path (Join-Path $dir 'LibreHardwareMonitorLib.dll'))) {
  [Console]::Error.WriteLine("LibreHardwareMonitor not found in $dir")
  exit 1
}
[System.Reflection.Assembly]::LoadFrom("$dir\\System.Memory.dll") | Out-Null
[System.Reflection.Assembly]::LoadFrom("$dir\\System.Buffers.dll") | Out-Null
[System.Reflection.Assembly]::LoadFrom("$dir\\Microsoft.Bcl.AsyncInterfaces.dll") | Out-Null
Add-Type -Path "$dir\\LibreHardwareMonitorLib.dll"
$c = New-Object LibreHardwareMonitor.Hardware.Computer
$c.IsCpuEnabled = $true
$c.Open()
$out = $null
foreach ($hw in $c.Hardware) {
  $hw.Update()
  foreach ($s in $hw.Sensors) {
    if ($s.SensorType -eq 'Temperature' -and $s.Name -match 'Tctl|Package|Core') {
      $out = [math]::Round($s.Value, 1)
      break
    }
  }
  if ($null -ne $out) { break }
}
$c.Close()
if ($null -eq $out) { exit 2 }
# A sensor that matched but reads 0 was never sampled: LibreHardwareMonitor needs administrator
# rights for CPU temperature on most CPUs (its README says so), and a non-elevated caller gets 0
# rather than an error. Exit 3 so the panel can name the cause instead of reporting "0" as a value.
if ($out -le 0) { exit 3 }
$out
`
}

/** `configured` (pointed at a command) and `libraryPresent` are separate, so the UI can say "set up, but the library is missing". */
export function wslTemperatureStatus(scriptPath: string | null, tempCommand: string): WslTemperatureStatus {
  const wsl = isWsl()
  const scriptWritten = scriptPath !== null && fs.existsSync(scriptPath)
  const configured = tempCommand.trim().length > 0
  // `lhmInstalled`, not a second path of its own: this had a hardcoded `C:\Tools` copy, so it reported
  // "missing" after the installer had put the library in `%ProgramData%` — and the page told a person
  // to fix something that was already installed.
  const libraryPresent = lhmInstalled()
  return {
    wsl,
    supported: wsl,
    configured,
    scriptWritten,
    libraryPresent,
    scriptPath: wsl ? scriptPath : null,
    tempCommand: configured ? tempCommand : null,
  }
}

/** Write the helper script. Idempotent: re-running overwrites it with the current version. */
export function writeWslTemperatureScript(scriptPath: string): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
  fs.writeFileSync(scriptPath, scriptBody(), { mode: 0o600 })
}

/**
 * Delete the helper script. Answers **whether it is gone**, which is not the same as whether we tried.
 *
 * The one home for it, because `--clear` promises it in the CLI help and in `docs/SERVERS.md` — and
 * the CLI cleared `host.tempCommand` without ever removing the file, so the helper outlived the
 * setting that pointed at it.
 *
 * The boolean matters because deleting can genuinely fail and the failure is invisible: a helper
 * written by a previous run can be owned by another account, and `%ProgramData%` on a 9p mount maps
 * that to an ACL this process cannot remove the file under — so `rm` answers `EPERM` while the caller
 * reported success. Measured: `DELETE /api/host/temperature` answered `200` with `scriptWritten: true`
 * in the same body, and the next setup attempt then failed on the write.
 */
export function removeWslTemperatureScript(scriptPath: string | null): boolean {
  if (scriptPath === null)
    return true
  try {
    fs.rmSync(scriptPath, { force: true })
  }
  catch {
    // Reported by the caller; the command is cleared regardless, which is what stops it being used.
  }
  return !fs.existsSync(scriptPath)
}

/**
 * Pinned by version **and** sha256: this file is then executed on every sample, and the URL redirects
 * to a third-party CDN. Checked before anything is unpacked. Change all three fields together.
 */
export const LHM_RELEASE = {
  version: '0.9.6',
  asset: 'LibreHardwareMonitor.zip',
  /** From the release's asset `digest` field, `sha256:…`. */
  sha256: '086d9f1b5a99e643edc2cfaaac16051685b551e4c5ac0b32a57c58c0e529c001',
  url: 'https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v0.9.6/LibreHardwareMonitor.zip',
} as const

/** Whether the DLL the helper loads is installed where the helper expects it. */
export function lhmInstalled(): boolean {
  const dir = lhmDirectory()
  if (dir === null)
    return false
  try {
    return fs.existsSync(path.join(dir, 'LibreHardwareMonitorLib.dll'))
  }
  catch {
    return false
  }
}

/** Download, verify and unpack LibreHardwareMonitor. A failed attempt leaves nothing installed. */
export async function installLibreHardwareMonitor(options: { onProgress?: (message: string) => void } = {}): Promise<{ dir: string | null, error: string | null }> {
  const report = options.onProgress ?? (() => {})
  const targetWindows = lhmDirectoryWindows()
  const target = lhmDirectory()
  if (targetWindows === null || target === null)
    return { dir: null, error: 'the Windows ProgramData directory could not be read, so there is nowhere to install to' }

  let staging: string | null = null
  try {
    report(`downloading ${LHM_RELEASE.asset} (${LHM_RELEASE.version})…`)
    const response = await fetch(LHM_RELEASE.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
    if (!response.ok)
      return { dir: null, error: `the download answered ${response.status} for ${LHM_RELEASE.url}` }
    const bytes = Buffer.from(await response.arrayBuffer())

    // Verify before unpacking: this file becomes code that runs on every sample.
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== LHM_RELEASE.sha256) {
      return {
        dir: null,
        error: `the download did not match its published sha256 (got ${digest.slice(0, 16)}…, expected ${LHM_RELEASE.sha256.slice(0, 16)}…) — nothing was installed`,
      }
    }

    // Stage beside the target, on the **Windows** drive: `Expand-Archive` runs on the Windows side and
    // cannot open a Linux temp path. `/mnt/c` is shared, so both sides see the same file.
    const stagingRoot = path.join(path.dirname(target), '.staging')
    await fs.promises.mkdir(stagingRoot, { recursive: true })
    staging = await fs.promises.mkdtemp(path.join(stagingRoot, 'run-'))
    const archive = path.join(staging, LHM_RELEASE.asset)
    await fs.promises.writeFile(archive, bytes)

    report(`unpacking into ${targetWindows}…`)
    await fs.promises.rm(target, { recursive: true, force: true })
    await fs.promises.mkdir(target, { recursive: true })
    // Windows must unpack its own archive; `unzip` may not exist there.
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${windowsScriptPath(archive)}' -DestinationPath '${targetWindows}' -Force`],
      { timeout: 120_000, windowsHide: true },
    )

    if (!lhmInstalled()) {
      await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {})
      return { dir: null, error: `the archive unpacked but LibreHardwareMonitorLib.dll is not in ${targetWindows}` }
    }
    return { dir: targetWindows, error: null }
  }
  catch (error) {
    return { dir: null, error: error instanceof Error ? error.message : String(error) }
  }
  finally {
    // Ours, unlike the install: remove the `run-*` dir *and* its parent, or `.staging` lingers.
    if (staging !== null) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
      await fs.promises.rmdir(path.dirname(staging)).catch(() => {})
    }
  }
}

/**
 * The sentence for a helper that ran but read nothing, phrased so the next step is obvious.
 *
 * LibreHardwareMonitor's README: "Some sensors require administrator privileges to access the data."
 * A CPU's `Tctl`/`Package` sensor is one of them, so a panel started from a non-elevated shell gets
 * `0` from a sensor that exists — not an error, and not a missing install. Reporting that as
 * "the script printed 0, which is not a temperature" sent the reader to check an installation that
 * was already correct.
 */
export const PRIVILEGE_HINT = 'the sensor read 0 °C — LibreHardwareMonitor needs administrator rights for CPU temperature on this machine. Start the panel from an elevated (Administrator) shell, then set this up again'

/** Run the helper once, so a setup that cannot work is reported rather than saved. */
export async function probeWslTemperature(tempCommand: string, timeoutMs: number): Promise<{ celsius: number | null, error: string | null }> {
  try {
    const { stdout, stderr } = await execFileAsync(tempCommand, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, shell: true })
    const match = /-?\d+(?:\.\d+)?/.exec(stdout)
    if (match === null) {
      return {
        celsius: null,
        error: stderr.trim().length > 0
          ? stderr.trim()
          : 'the script printed no number — is LibreHardwareMonitor installed?',
      }
    }
    const celsius = Number.parseFloat(match[0])
    if (!Number.isFinite(celsius) || celsius <= 0 || celsius >= 150) {
      // Reached only when the helper printed a bad number but exited 0 — an older script, or a
      // command someone pointed at by hand. The privilege case exits 3 and lands in the catch below.
      return { celsius: null, error: `the script printed ${match[0]}, which is not a temperature` }
    }
    return { celsius, error: null }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // `execFile` rejects on a non-zero exit, and exit 3 is the privilege signal — so this branch, not
    // the one above, is where a sensor that read 0 actually lands.
    if ((error as { code?: unknown } | null)?.code === 3) {
      logger.warn(`the WSL temperature probe read 0 °C: ${PRIVILEGE_HINT}`)
      return { celsius: null, error: PRIVILEGE_HINT }
    }
    logger.warn(`the WSL temperature probe failed: ${message}`)
    return { celsius: null, error: message }
  }
}
