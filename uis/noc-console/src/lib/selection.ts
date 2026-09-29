import { ref } from 'vue'

/**
 * The workspace every scoped API call defaults to. It lives here rather than in
 * `useWorkspaces` so `lib/api.ts` can read it without importing the composable
 * that itself imports the api.
 */
const STORAGE_KEY = 'noc.workspace'

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  }
  catch {
    return null
  }
}

export const selectedWorkspaceId = ref<string | null>(readStored())

/** Persist the selection; storage being unavailable never blocks the shell. */
export function rememberWorkspace(id: string | null): void {
  selectedWorkspaceId.value = id
  try {
    if (id === null)
      localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  }
  catch {
    // A browser with storage disabled still works; the selection just is not kept.
  }
}
