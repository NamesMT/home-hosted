import { exec } from 'node:child_process'
import process from 'node:process'

/** Best-effort browser launch; a headless host simply logs instead. */
export function openBrowser(url: string): void {
  const command = process.platform === 'darwin'
    ? `open "${url}"`
    : process.platform === 'win32'
      ? `start "" "${url}"`
      : `xdg-open "${url}"`

  exec(command, { windowsHide: true }, () => {
    // No display / no handler: the URL is already printed, so this is not an error.
  })
}
