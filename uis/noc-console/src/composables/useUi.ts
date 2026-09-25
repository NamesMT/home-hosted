import { ref } from 'vue'

/**
 * Console-wide UI state that several views and the shell share: which server is
 * selected, the list filter, the overlays, the live-log drawer and the toast.
 */

export const selectedId = ref<string | null>(null)
export const filter = ref('')
export const helpOpen = ref(false)
export const addOpen = ref(false)
export const drawerOpen = ref(false)
/** The settings change review and the server-config save review. */
export const changesOpen = ref(false)
export const configChangesOpen = ref(false)
/** First key of a two-key chord (`g`), shown in the status line while pending. */
export const keyPrefix = ref<string | null>(null)
export const toast = ref<{ text: string, kind: 'info' | 'error' } | null>(null)

let toastTimer: ReturnType<typeof setTimeout> | null = null

export function flash(text: string, kind: 'info' | 'error' = 'info'): void {
  toast.value = { text, kind }
  if (toastTimer)
    clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 4200)
}

export function toggleDrawer(): void {
  drawerOpen.value = !drawerOpen.value
}

export function closeOverlays(): void {
  helpOpen.value = false
  addOpen.value = false
  drawerOpen.value = false
  changesOpen.value = false
  configChangesOpen.value = false
  keyPrefix.value = null
}

export function useUi() {
  return {
    selectedId,
    filter,
    helpOpen,
    addOpen,
    drawerOpen,
    changesOpen,
    configChangesOpen,
    keyPrefix,
    toast,
    flash,
    toggleDrawer,
    closeOverlays,
  }
}
