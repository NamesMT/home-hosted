/**
 * This UI's view of the panel API.
 *
 * Every call is the shared client's — `@shared/api-client` holds the workspace-scoped wrappers and
 * their validation now, so nothing here is a second implementation. `stock` threads the workspace
 * explicitly at every call site, so it installs no resolver: the shared default (`null`) means "let
 * the panel pick", which is what an omitted argument has always meant.
 *
 * Kept as a module because the views import `* as api from '@/lib/api'`, and because this barrel is
 * where a view looks for the contract types it names.
 */
export * from '@shared/api-client'
// Named rather than left to the star export: these are the two helpers a settings page reaches for,
// and the scan that keeps them shared (`test/shared/ui-parity.test.ts`) reads this file by name.
export { restoreStoredBackup, restoreUploadedBackup, uploadUi } from '@shared/api-client'
export type { RestoreOptions } from '@shared/api-client'

// The contract types a view names through this barrel rather than reaching for `@shared/contracts`.
export type {
  BackupFile,
  BackupsView,
  ProxyView,
  RestoreItem,
  RestorePlan,
  SettingsView,
  UiStatus,
  WorkspaceSettingsView,
  WorkspaceView,
} from '@shared/contracts'
