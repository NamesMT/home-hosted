/**
 * This UI's view of the panel API.
 *
 * The calls are the shared client's — `@shared/api-client` holds the workspace-scoped wrappers and
 * their validation now. What is genuinely this UI's is the resolver: the console lets a call omit
 * the workspace and falls back to whatever the shell has selected, which is a reactive ref it owns.
 * `src/shared` may not import Vue, so that ref cannot move into the shared client — this short
 * adapter is the seam instead.
 */
import type { SettingsSaved, UiMeta, WorkspaceSettingsView } from '@shared/contracts'
import { useWorkspaceResolver } from '@shared/api-client'
import { selectedWorkspaceId } from '@/lib/selection'

export * from '@shared/api-client'
// Named rather than left to the star export: these are the two helpers a settings page reaches for,
// and the scan that keeps them shared (`test/shared/ui-parity.test.ts`) reads this file by name.
export { restoreStoredBackup, restoreUploadedBackup, uploadUi } from '@shared/api-client'
export type { RestoreOptions } from '@shared/api-client'

useWorkspaceResolver(() => selectedWorkspaceId.value)

// The contract types a view names through this barrel rather than reaching for `@shared/contracts`.
export type {
  BackupEntry,
  BackupFile,
  BackupsView,
  RestorePlan,
  SettingsSaved,
  SettingsView,
  UiMeta,
  WorkspaceSettingsView,
  WorkspaceView,
} from '@shared/contracts'

/** The shared saved answer, under the name this UI's views already import. */
export type SettingsSaveResult = SettingsSaved

/** `GET /api/settings/workspace`: what the pinned workspace owns on its own. */
export type WorkspaceSettings = WorkspaceSettingsView

/**
 * The installed UI's identity. The contract keeps every field optional (a hand-written `ui.json` has
 * no `uploadedAt`/`files`); a panel that installs one always fills them in, and the settings page
 * reads them as present.
 */
export interface UiStatus {
  custom: boolean
  dir: string
  meta: (UiMeta & { name: string, version: string | null, uploadedAt: number, files: number }) | null
}

/** A data path a backup would capture, flattened out of the entry tree. */
export interface BackupPathEntry {
  path: string
  /** Which leaf this path is in a backup's `include`; older panels omit it. */
  id?: string
  origin: string
  included: boolean
  note: string | null
}
