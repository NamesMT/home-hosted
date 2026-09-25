import type { UiSourceContext } from '#src/providers/ui-release'
import type { UiService } from '#src/services/ui'
import { logger } from '#src/helpers/logger'
import { appVersion } from '#src/helpers/version'
import {
  assetDownloadUrl,
  DEFAULT_REPO,
  downloadToTemp,
  fetchRelease,
  isOwnRepo,
  isUiAsset,
  matchAsset,
  parseRepoSlug,
} from '#src/providers/ui-release'

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
    token: null,
    quiet: true,
  }

  try {
    const release = await fetchRelease(repo, target, context)
    const names = release.assets.map(asset => asset.name ?? '').filter(isUiAsset)
    if (names.length === 0)
      throw new Error(`no UI asset in ${DEFAULT_REPO}@${release.tag}`)

    // The asset this UI came from, or the only one on offer when it never said.
    const wanted = meta.asset ?? ''
    const matched = wanted.length > 0 ? matchAsset(names, wanted) : { ok: true as const, name: names[0]! }
    if (!matched.ok)
      throw new Error(matched.error)

    const asset = release.assets.find(entry => entry.name === matched.name)
    if (asset === undefined)
      throw new Error(`no asset named ${matched.name} in ${release.tag}`)

    const download = await downloadToTemp(assetDownloadUrl(asset), {
      'accept': 'application/octet-stream',
      'user-agent': `home-hosted/${runningVersion}`,
    }, context)

    try {
      const result = await ui.install(download.file, matched.name.replace(/\.zip$/i, ''))
      if (!result.ok)
        throw new Error(result.error)
    }
    finally {
      const fs = await import('node:fs')
      fs.rmSync(download.dir, { recursive: true, force: true })
    }

    return { kind: 'updated', tag: release.tag }
  }
  catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
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
    logger.warn(`ui:      could not update: ${error instanceof Error ? error.message : String(error)}`)
  })
}
