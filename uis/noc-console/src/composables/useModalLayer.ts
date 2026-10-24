import { onScopeDispose, ref, watch } from 'vue'

/**
 * One place that knows a modal overlay is open, and which one is on top.
 *
 * The console's overlays are markup — an `.overlay` div with `role="dialog"` — so each one used to
 * be its own island. Four of them drew an `esc` keycap and did nothing when it was pressed, and the
 * shell's single-key shortcuts kept firing *through* every one of them: the shell decided from a
 * hand-maintained list of its own flags (`helpOpen`, `addOpen`, …), which cannot see a dialog whose
 * open state lives in the component. With the "stop all" sheet open, `x` stopped the selected
 * server behind it and `j` moved that selection.
 *
 * The shell owns the window listener, so registration is only a list: Escape asks for the topmost
 * layer (`closeTopModal`) and every other shortcut is refused while one is up (`modalOpen`).
 * Two listeners would be two chances to close the wrong dialog.
 */

interface Layer {
  close: () => void
}

/** Registration order; the last entry is the topmost overlay. */
const layers: Layer[] = []

/** A reactive depth, so the shell's refusal to route shortcuts re-renders with the stack. */
export const modalDepth = ref(0)

function sync(): void {
  modalDepth.value = layers.length
}

/** True while any overlay is open: the shell must not act on a page behind one. */
export function modalOpen(): boolean {
  return layers.length > 0
}

/**
 * Closes the topmost overlay. Returns true when something was closed, so the caller knows Escape
 * was consumed by a dialog rather than by the page.
 */
export function closeTopModal(): boolean {
  const top = layers[layers.length - 1]
  if (top === undefined)
    return false
  top.close()
  return true
}

/**
 * Registers `close` for as long as `isOpen` is true. Call it once in setup: the layer follows the
 * state itself, so a dialog closed by a save, a backdrop click or a navigation unregisters the same
 * way, and `onScopeDispose` covers the component going away while still open.
 */
export function useModalLayer(isOpen: () => boolean, close: () => void): void {
  const layer: Layer = { close }
  let registered = false

  function register(): void {
    if (registered)
      return
    registered = true
    layers.push(layer)
    sync()
  }

  function unregister(): void {
    if (!registered)
      return
    registered = false
    const at = layers.indexOf(layer)
    if (at !== -1)
      layers.splice(at, 1)
    sync()
  }

  watch(isOpen, (open) => {
    if (open)
      register()
    else
      unregister()
  }, { immediate: true })

  onScopeDispose(unregister)
}
