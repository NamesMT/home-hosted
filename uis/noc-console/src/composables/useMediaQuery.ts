import type { Ref } from 'vue'
import { onScopeDispose, ref } from 'vue'

/** Reactive `matchMedia`, cleaned up with the calling scope. */
export function useMediaQuery(query: string): Ref<boolean> {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return ref(false)

  const list = window.matchMedia(query)
  const matches = ref(list.matches)
  const onChange = (event: MediaQueryListEvent): void => {
    matches.value = event.matches
  }

  list.addEventListener('change', onChange)
  onScopeDispose(() => list.removeEventListener('change', onChange))
  return matches
}
