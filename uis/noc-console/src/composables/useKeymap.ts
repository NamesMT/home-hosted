import { onScopeDispose, shallowReactive } from 'vue'

export type KeyHandler = (key: string, event: KeyboardEvent) => boolean

const handlers: KeyHandler[] = []

/**
 * A view registers a handler for single-key actions (`j`, `s`, `x`, ...). The
 * most recently registered handler gets first refusal, so a focused pane wins
 * over the shell defaults.
 */
export function useKeyHandler(handler: KeyHandler): void {
  handlers.push(handler)
  onScopeDispose(() => {
    const index = handlers.indexOf(handler)
    if (index !== -1)
      handlers.splice(index, 1)
  })
}

/**
 * One shortcut a view can perform, as the status bar should word it.
 *
 * The bar used to carry a fixed sentence — `j k move · s start · x stop · r restart · l logs ·
 * e edit · / filter · ? keys` — on **every** route, so on seven of the eight pages it advertised
 * keys that do nothing there (`s`/`x`/`r`/`c`/`l` live only in `ServersView`, `/` only where a
 * `[data-filter]` field exists, `v`/`R` only in `LogsView`). Measured in Chromium by pressing
 * each key on each route and diffing the DOM: on `/global/overview`, `/global/settings`,
 * `/w/default/jobs`, `/w/default/settings` and `/proxy` **all nine** of those keys changed
 * nothing, while `/w/default/logs` responded to `/`, `v` and `R` — two of which the bar never
 * named. A hint that describes another page's keyboard is worse than no hint: it teaches a key
 * that silently does nothing.
 */
export interface KeyHint {
  /** The keys, as the bar draws them (`['j', 'k']` or `['g', 's']`). */
  keys: string[]
  /** What they do, in the console's lowercase voice. */
  label: string
}

/**
 * Reactive, so the status bar follows a **mount** rather than a navigation.
 *
 * A plain module array is invisible to Vue: the shell's computed only re-ran on `route.fullPath`,
 * which changes *before* the incoming view mounts and *after* the outgoing one unmounts — so the
 * bar rendered the previous page's keys. Measured in Chromium after an SPA click from Servers to
 * Logs: the bar showed `j k move selection · s start …` on the logs page, and clicking back to
 * Servers showed the logs page's `v / R`. A direct load showed only `? keys`, because nothing
 * re-triggered the read at all. `shallowReactive` tracks the registrations themselves.
 */
const hints = shallowReactive<KeyHint[][]>([])

/**
 * A view's own shortcuts, registered beside its handler so the two cannot drift.
 *
 * `useKeyHandler` gets the behaviour and this gets the words; a view that registers one without
 * the other is the drift the old fixed sentence already had. Registration is scoped like the
 * handler, so a route that unmounts takes its hints with it.
 */
export function useKeyHints(viewHints: KeyHint[]): void {
  hints.push(viewHints)
  onScopeDispose(() => {
    const index = hints.indexOf(viewHints)
    if (index !== -1)
      hints.splice(index, 1)
  })
}

/** The shortcuts the mounted views can perform, in registration order. */
export function currentKeyHints(): KeyHint[] {
  return hints.flat()
}

export function runKeyHandlers(key: string, event: KeyboardEvent): boolean {
  for (let index = handlers.length - 1; index >= 0; index -= 1) {
    const handler = handlers[index]
    if (handler?.(key, event))
      return true
  }
  return false
}

/** True when a bare letter would be text rather than a shortcut. */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement))
    return false
  if (target.isContentEditable)
    return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}
