import type { WslTemperatureStatus } from '#src/shared/contracts'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { logger } from '#src/helpers/logger'

const execFileAsync = promisify(execFile)

/**
 * The WSL2 temperature bridge.
 *
 * A WSL2 guest has no sensor the kernel can read: `/sys/class/hwmon` is empty, there is no
 * `thermal_zone*`, and `sensors` says "No sensors found". The **Windows host** does have one, but
 * only through a driver-level reader — the ACPI class Windows exposes
 * (`MSAcpi_ThermalZoneTemperature`) answers a constant 20 °C at idle and under load alike, so
 * reporting it would be a fabricated number. LibreHardwareMonitor reads the real value (verified
 * on a Ryzen AI 9 HX 370: 63.9 °C idle, 75.2 °C under load).
 *
 * So the panel offers to set that up: it writes a small PowerShell script that prints one number,
 * and the `powershell.exe` call that runs it becomes `host.tempCommand`. Everything here is
 * **opt-in and reversible** — the person presses a button and can clear the field again.
 */

/** The script that prints the CPU temperature, written beside the panel's own state. */
const SCRIPT_NAME = 'cpu-temp.ps1'

/** Where LibreHardwareMonitor is expected on the Windows side when the operator unzips it there. */
const LHM_DIR = 'C:\\Tools\\LibreHardwareMonitor'

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

/**
 * Where the helper script goes: **on the Windows side**, under `%LOCALAPPDATA%`-style storage.
 *
 * This is the part that is easy to get wrong. `powershell.exe` reads a *Windows* path, so a script
 * written into the guest's Linux home (`/tmp`, `~/.home-hosted`) is invisible to it — the command
 * appears to work only while some stale copy exists, then fails with a path error that names nothing
 * useful. `/mnt/c` is the 9p mount of `C:`, so writing there gives both sides the same file.
 */
export function windowsScriptPath(scriptPath: string): string {
  // `/mnt/c/Users/me/x.ps1` is `C:\Users\me\x.ps1` to powershell.exe.
  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(scriptPath)
  if (match === null)
    return scriptPath
  return `${match[1]!.toUpperCase()}:\\${match[2]!.replaceAll('/', '\\')}`
}

/**
 * The Linux path the helper is written to: `C:\Tools\home-hosted\cpu-temp.ps1` on Windows.
 *
 * `user` is the Windows-side account, taken from the mount when it can be read. Falls back to the
 * user's home on the Windows drive, which is where a person can find and delete the file.
 */
export function wslScriptPath(): string | null {
  if (!isWsl())
    return null
  return path.join('/mnt/c/Tools/home-hosted', SCRIPT_NAME)
}

/** The `powershell.exe` invocation that runs `scriptPath` and prints the temperature. */
export function tempCommandFor(scriptPath: string): string {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${windowsScriptPath(scriptPath)}"`
}

/** The script's body. Kept tiny: it runs on every host sample. */
function scriptBody(lhmDir: string): string {
  return `# CPU temperature for home-hosted, read through LibreHardwareMonitor.
# Written by \`home-hosted host tempsetup\`; safe to delete, and the panel stops using it when the
# Temperature command field is cleared.
$dir = '${lhmDir}'
if (-not (Test-Path "$dir\\LibreHardwareMonitorLib.dll")) {
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

/**
 * Whether the setup is in place: the script exists, and the panel has been pointed at it.
 *
 * `configured` is what the panel *will do*; `ready` is whether it can work — the two are separate so
 * the UI can say "set up, but the library is missing" rather than only "not set up".
 */
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
  fs.writeFileSync(scriptPath, scriptBody(LHM_DIR), { mode: 0o600 })
}

/**
 * Run the helper once, to tell the person whether the setup works before they save a broken command.
 *
 * The answer is the reading, or a reason. A missing library and a library that returned nothing are
 * different problems and get different sentences — the first says where to put the download, the
 * second that the harness ran but found no sensor (a locked-down driver, a VM in a VM).
 */
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
