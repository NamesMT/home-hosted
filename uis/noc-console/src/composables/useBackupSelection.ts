import type { BackupSelection } from '@shared/contracts'
import { errorMessage } from '@shared/error-message'
import { onScopeDispose, ref } from 'vue'
import * as api from '@/lib/api'

/**
 * The backup selection model — every entry a capture could include, and every archive on disk.
 *
 * It is not part of the state frame any more: building it reads every workspace's `.secrets.json`
 * and stats every archive, and the frame is rebuilt about thirteen times a second. So it is fetched
 * when a dialog opens and refetched after anything that changes it.
 *
 * `entries === null` means "not asked yet"; the tree renders a loading state rather than an empty
 * one, because an empty capture tree reads as "there is nothing to back up" — a claim this hook is
 * in no position to make before the answer arrives.
 */
export function useBackupSelection() {
  const selection = ref<BackupSelection | null>(null)
  const error = ref<string | null>(null)
  const loading = ref(false)
  let inFlight: Promise<void> | null = null

  /**
   * Fetch, or join the fetch already running.
   *
   * Two dialogs can open from one page and both ask; the second should not queue a second read of
   * every secrets file.
   */
  function load(): Promise<void> {
    inFlight ??= (async () => {
      loading.value = true
      try {
        selection.value = await api.fetchBackups()
        error.value = null
      }
      catch (caught) {
        error.value = errorMessage(caught)
      }
      finally {
        loading.value = false
        inFlight = null
      }
    })()
    return inFlight
  }

  /** Drop what we have so the next `load()` refetches; used after a create or a delete. */
  function invalidate(): void {
    selection.value = null
  }

  onScopeDispose(() => {
    inFlight = null
  })

  return { selection, error, loading, load, invalidate }
}
