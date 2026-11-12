import type { UiSourceContext } from '#src/providers/ui-release'
import type { UiInstallResult, UiService } from '#src/services/ui'
import fs from 'node:fs'
import process from 'node:process'
import { logger } from '#src/helpers/logger'
import { appVersion } from '#src/helpers/version'
import {
  assetDownloadUrl,
  DEFAULT_REPO,
  downloadHeaders,
  downloadToTemp,
  fetchRelease,
  isOwnRepo,
  isUiAsset,
  matchAsset,
  parseRepoSlug,
  verifyAssetDigest,
} from '#src/providers/ui-release'
import { errorMessage } from '#src/shared/error-message'

/**
 * Keeping an *official* UI paired with the panel that serves it, without a person
 * having to notice. A UI from `NamesMT/home-hosted` is built for a release, and this
 * panel knows its own release, so "the wrong tag" is a fact rather than a preference —
 * unlike someone else's UI, where only the person can say what they want.
 *
 * Only ever installed by tag, never by guess, and every failure is a log line: this runs
 * at startup, and a UI problem must never stop a panel from serving.
 */

export type UiSyncResult = { kind: 'not-custom' }
  | { kind: 'foreign' }
  | { kind: 'no-identity' }
  | { kind: 'current', tag: string }
  | { kind: 'updated', tag: string }
  | { kind: 'failed', error: string }

/**
 * `ui.json` says which release this build came from. Anything else — an unofficial UI,
 * or one that never declared itself — is left for `home-hosted ui-update`.
 */
export function officialTagFor(
  meta: { repo?: string, tag?: string } | null,
  runningVersion: string,
): { tag: string, repo: string } | null {
  if (meta === null || typeof meta.repo !== 'string')
    return null
  const repo = parseRepoSlug(meta.repo)
  if (repo === null || !isOwnRepo(repo))
    return null
  return { tag: `v${runningVersion}`, repo: `${repo.owner}/${repo.name}` }
}

export interface ReleaseAssetInstall {
  url: string
  /** The install's name when the archive carries no `ui.json`. */
  fallbackName: string
  /** The release the asset came from, recorded instead of the one inside the archive. */
  tag?: string
  /** The asset's `digest` from the release metadata, verified when present. */
  digest?: string | null
  context: UiSourceContext
  unlessChanged?: () => string | null
}

/**
 * Downloads one UI archive and installs it: the one path `ui-switch`, `ui-update` and the startup
 * sync share, so the token scoping, the digest check and the temp cleanup cannot drift apart.
 */
export async function installReleaseAsset(ui: UiService, install: ReleaseAssetInstall): Promise<UiInstallResult> {
  const download = await downloadToTemp(install.url, downloadHeaders(install.url, install.context), install.context)
  try {
    await verifyAssetDigest(download.file, install.digest)
    return await ui.install(download.file, install.fallbackName, install.tag, { unlessChanged: install.unlessChanged })
  }
  finally {
    fs.rmSync(download.dir, { recursive: true, force: true })
  }
}

export async function syncOfficialUi(ui: UiService, runningVersion = appVersion()): Promise<UiSyncResult> {
  if (!ui.custom)
    return { kind: 'not-custom' }

  const meta = ui.readMeta()
  if (meta === null)
    return { kind: 'no-identity' }

  const repo = meta.repo === undefined ? null : parseRepoSlug(meta.repo)
  if (repo === null)
    return { kind: 'no-identity' }
  if (!isOwnRepo(repo))
    return { kind: 'foreign' }

  const target = `v${runningVersion}`
  if (meta.tag === target)
    return { kind: 'current', tag: target }

  const context: UiSourceContext = {
    io: { write: () => {}, style: { bold: (t: string) => t, dim: (t: string) => t, green: (t: string) => t } },
    version: runningVersion,
    // The one unattended call may use a token like the interactive commands do; without
    // one, a shared or CI address hits GitHub's 60/hour unauthenticated limit.
    token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null,
    quiet: true,
  }

  try {
    const release = await fetchRelease(repo, target, context)
    const names = release.assets.map(asset => asset.name ?? '').filter(isUiAsset)

    // Each of these is an answer, not an exception: the caller has no retry and no alternate
    // path, so a `throw` here only travelled ten lines to be turned back into this same object.
    const failure = (error: string): UiSyncResult => ({ kind: 'failed', error })

    if (names.length === 0)
      return failure(`no UI asset in ${DEFAULT_REPO}@${release.tag}`)

    // The asset this UI came from, or the only one on offer when it never said.
    const wanted = meta.asset ?? ''
    const matched = wanted.length > 0 ? matchAsset(names, wanted) : { ok: true as const, name: names[0]! }
    if (!matched.ok)
      return failure(matched.error)

    const asset = release.assets.find(entry => entry.name === matched.name)
    if (asset === undefined)
      return failure(`no asset named ${matched.name} in ${release.tag}`)

    // The UI this decision was made about. A person may upload or switch one while the asset
    // downloads; that choice wins, so the swap is refused unless the installed UI is still this one.
    const decidedOn = JSON.stringify(meta)
    const result = await installReleaseAsset(ui, {
      url: assetDownloadUrl(asset),
      fallbackName: matched.name.replace(/\.zip$/i, ''),
      // The tag is the release we just fetched, never what the archive claims.
      tag: release.tag,
      digest: asset.digest,
      context,
      unlessChanged: () => JSON.stringify(ui.readMeta()) === decidedOn ? null : 'the installed UI changed while the update downloaded — it was kept',
    })
    if (!result.ok)
      return failure(result.error)

    return { kind: 'updated', tag: release.tag }
  }
  catch (error) {
    // Only a real surprise reaches here now: a failed fetch, a download that died, an install that
    // threw. The expected outcomes are the returns above.
    return { kind: 'failed', error: errorMessage(error) }
  }
}

/**
 * The startup hook. Never awaited by the caller and never allowed to throw: the panel
 * serves the UI it already has while this runs, and the next request picks up the new
 * one, because `UiService.resolveDir()` is read per request.
 */
export function autoUpdateOfficialUi(ui: UiService, runningVersion = appVersion()): void {
  if (!ui.custom)
    return

  const meta = ui.readMeta()
  const plan = officialTagFor(meta, runningVersion)
  if (plan === null || meta?.tag === plan.tag)
    return

  logger.info(`ui:      ${meta?.name ?? 'custom UI'} ${meta?.version ?? ''} came from ${meta?.tag ?? 'an unknown release'}; this panel is ${plan.tag} — updating`)

  void syncOfficialUi(ui, runningVersion).then((result) => {
    if (result.kind === 'updated')
      logger.info(`ui:      updated to ${result.tag} — refresh the browser`)
    else if (result.kind === 'failed')
      logger.warn(`ui:      could not update to ${plan.tag}: ${result.error}`)
  }).catch((error: unknown) => {
    logger.warn(`ui:      could not update: ${errorMessage(error)}`)
  })
}
