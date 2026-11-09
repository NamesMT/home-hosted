import type { Directive } from 'vue'

/**
 * `v-focus-trap` on a modal panel: focus moves into it when it opens, Tab and Shift+Tab cycle
 * inside it, and focus returns to whatever had it when the panel closes.
 *
 * Every overlay here is a `v-if`, so mount and unmount are open and close. Without this, focus
 * stayed on the button behind the overlay, Tab walked the page underneath, and closing left focus
 * on `<body>` — a keyboard user lost their place twice per dialog.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

interface TrapState {
  restore: HTMLElement | null
  onKeydown: (event: KeyboardEvent) => void
}

const traps = new WeakMap<HTMLElement, TrapState>()
/** A Tab the innermost trap already handled: an enclosing dialog's trap must not act on it too. */
const handled = new WeakSet<Event>()

function focusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => !element.closest('[inert]'))
}

export const vFocusTrap: Directive<HTMLElement> = {
  mounted(panel) {
    const active = document.activeElement
    const restore = active instanceof HTMLElement && !panel.contains(active) ? active : null
    if (!panel.hasAttribute('tabindex'))
      panel.setAttribute('tabindex', '-1')

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || handled.has(event))
        return
      handled.add(event)
      const items = focusables(panel)
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement
      if (first === undefined || last === undefined) {
        event.preventDefault()
        panel.focus()
        return
      }
      const inside = current instanceof Node && panel.contains(current)
      if (event.shiftKey && (!inside || current === first || current === panel)) {
        event.preventDefault()
        last.focus()
      }
      else if (!event.shiftKey && (!inside || current === last)) {
        event.preventDefault()
        first.focus()
      }
    }
    panel.addEventListener('keydown', onKeydown)
    traps.set(panel, { restore, onKeydown })

    // A dialog that already focused its own field keeps it.
    if (!panel.contains(document.activeElement))
      (panel.querySelector<HTMLElement>('[autofocus]') ?? focusables(panel)[0] ?? panel).focus()
  },
  unmounted(panel) {
    const state = traps.get(panel)
    if (!state)
      return
    traps.delete(panel)
    panel.removeEventListener('keydown', state.onKeydown)
    if (state.restore?.isConnected === true)
      state.restore.focus()
  },
}
