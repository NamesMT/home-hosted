import { onScopeDispose } from 'vue'

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
