/**
 * Writing to the clipboard, on the origins this panel actually runs on.
 *
 * `navigator.clipboard` exists only in a **secure context** — https, or a loopback
 * origin. The panel is documented to be reached over plain `http://` on a LAN
 * (`docs/UI_CREATION.md` point 7), and there the whole `navigator.clipboard`
 * object is `undefined`: measured on the built panel from `http://192.168.1.201:6181`,
 * `typeof navigator.clipboard === 'undefined'` while the same page on
 * `http://127.0.0.1:6181` has it. The button's `await navigator.clipboard.writeText(…)`
 * therefore threw a `TypeError` into a `catch {}` that did nothing — a dead button
 * with no feedback on the one surface a phone uses.
 *
 * So: use the modern API where it exists, and fall back to the `execCommand('copy')`
 * path, which works on an insecure origin inside a user gesture. Report whether the
 * text really reached the clipboard; the caller decides what to say.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text)
      return true
    }
    catch {
      // Permission denied or an insecure context that still exposes the object:
      // fall through to the legacy path rather than failing the click.
    }
  }
  return legacyCopy(text)
}

/**
 * The pre-Clipboard-API copy: a selected, off-screen textarea plus `execCommand`.
 *
 * Deprecated but universally implemented, and the only thing that works on plain
 * http. It needs the call to sit inside the user gesture, which it does — the click
 * handler is the caller.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function')
    return false

  const area = document.createElement('textarea')
  area.value = text
  // Read-only and off-screen: a mobile keyboard must not open and the page must not
  // jump. `position: fixed` keeps it out of the scroll box on iOS.
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  }
  catch {
    return false
  }
  finally {
    area.remove()
  }
}
