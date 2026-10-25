import type { WslTemperatureStatus } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { logger } from '#src/helpers/logger'

const execFileAsync = promisify(execFile)

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

/** The install directory in Windows terms, read from the environment (the system drive may not be `C:`). */
export function lhmDirectoryWindows(): string | null {
  try {
    const base = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$env:ProgramData'], { timeout: 10_000, windowsHide: true, encoding: 'utf8' }).trim()
    return base.length === 0 ? null : path.win32.join(base, LHM_SUBDIR)
  }
  catch {
    return null
  }
}

/** A Windows path as a path this process can read: `C:\x` -> `/mnt/c/x`. */
export function toGuestPath(windowsPath: string): string | null {
  const match = /^([a-z]):\\(.*)$/i.exec(windowsPath)
  if (match === null)
    return null
  return path.join('/mnt', match[1]!.toLowerCase(), ...match[2]!.split('\\'))
}

/** The install directory as a guest path, or null when the Windows side cannot be reached. */
export function lhmDirectory(): string | null {
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
  const base = lhmDirectoryWindows()
  const guest = base === null ? null : toGuestPath(path.win32.dirname(base))
  if (guest === null)
    return null
  return path.join(guest, SCRIPT_NAME)
}

/** Where the helper is, in Windows terms — what the command line has to say. */
export function wslScriptPathWindows(): string | null {
  const base = lhmDirectoryWindows()
  return base === null ? null : path.win32.join(path.win32.dirname(base), SCRIPT_NAME)
}

/** The `powershell.exe` invocation that runs `scriptPath` and prints the temperature. */
export function tempCommandFor(scriptPath: string): string {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${windowsScriptPath(scriptPath)}"`
}

/** The command for a path already expressed in Windows terms. */
export function tempCommandForWindows(windowsPath: string): string {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${windowsPath}"`
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
$out
`
}

/** `configured` (pointed at a command) and `libraryPresent` are separate, so the UI can say "set up, but the library is missing". */
export function wslTemperatureStatus(scriptPath: string | null, tempCommand: string): WslTemperatureStatus {
  const wsl = isWsl()
  const scriptWritten = scriptPath !== null && fs.existsSync(scriptPath)
  const configured = tempCommand.trim().length > 0
  // LibreHardwareMonitor lives on the Windows side, so its presence is a Windows-path check from the
  // guest: look for the DLL the script loads.
  let libraryPresent = false
  try {
    libraryPresent = fs.existsSync(path.join('/mnt', 'c', 'Tools', 'LibreHardwareMonitor', 'LibreHardwareMonitorLib.dll'))
  }
  catch {
    libraryPresent = false
  }
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
          : 'the script printed no number — is LibreHardwareMonitor installed at C:\\Tools\\LibreHardwareMonitor?',
      }
    }
    const celsius = Number.parseFloat(match[0])
    if (!Number.isFinite(celsius) || celsius <= 0 || celsius >= 150)
      return { celsius: null, error: `the script printed ${match[0]}, which is not a temperature` }
    return { celsius, error: null }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`the WSL temperature probe failed: ${message}`)
    return { celsius: null, error: message }
  }
}
