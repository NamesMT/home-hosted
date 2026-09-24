import { computed, ref } from 'vue'

export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'hh.theme'

function readStored(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system')
      return value
  }
  catch {
    // Private mode: fall back to following the OS.
  }
  return 'system'
}

const preference = ref<ThemePreference>(readStored())
const systemDark = ref(typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches)

let listening = false

function ensureSystemListener(): void {
  if (listening || typeof matchMedia === 'undefined')
    return
  listening = true
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    systemDark.value = event.matches
    apply()
  })
}

const isDark = computed(() => (preference.value === 'system' ? systemDark.value : preference.value === 'dark'))

function apply(): void {
  if (typeof document === 'undefined')
    return
  document.documentElement.classList.toggle('dark', isDark.value)
}

export function useTheme() {
  ensureSystemListener()
  apply()

  function setPreference(next: ThemePreference): void {
    preference.value = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    }
    catch {
      // Storage is optional; the session still follows the choice.
    }
    apply()
  }

  return {
    preference,
    isDark,
    setPreference,
    /** Cycle light → dark → system, which is what the top-bar button does. */
    cycle(): void {
      setPreference(preference.value === 'light' ? 'dark' : preference.value === 'dark' ? 'system' : 'light')
    },
  }
}
