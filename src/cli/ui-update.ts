import type { UiSourceContext } from '#src/providers/ui-release'
import fs from 'node:fs'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { defineCommand } from 'citty'
import { prompt, style } from '#src/cli/io'
import {
  assetDownloadUrl,
  compareTags,
  DEFAULT_REPO,
  downloadToTemp,
  fetchRelease,
  fetchReleases,
  isOwnRepo,
  isUiAsset,
  matchAsset,
  parseRepoSlug,
  repoSlug,
} from '#src/providers/ui-release'

/**
 * `home-hosted ui-update` keeps an installed UI in step with the panel it talks to.
 *
 * Three cases, in the order they are decided:
 *   the stock UI is always current by definition — nothing to do;
 *   a UI from our own repo is *paired* with a release, so it is updated to the tag
 *     of the running panel without asking (that pairing is the whole point);
 *   anyone else's UI declares its own `repo`, and the person picks from the releases
 *     that actually carry the asset they are using — newer ones, or `--old` for older.
 */

interface UpdateContext extends UiSourceContext {
  /** null when the session cannot be asked (not a TTY, or `--yes`). */
  ask: ((question: string) => Promise<string>) | null
}

/** The identity an installed UI declared about itself, when it declared one. */
export interface UiIdentity {
  name: string
  version: string | null
  repo: string | null
  tag: string | null
  asset: string | null
  unix: number | null
}

export type UiUpdatePlan
  /** Nothing installed: the stock UI is served, and it is always current. */
  = { kind: 'stock' }
  /** Installed, but it never said where it came from, so there is nothing to follow. */
    | { kind: 'unidentifiable', identity: UiIdentity }
    /** Ours: paired with this panel's release. `target` already matches when current. */
    | { kind: 'official', identity: UiIdentity, target: string }
    /** Someone else's: the person chooses from `candidates`. */
    | { kind: 'choice', identity: UiIdentity, asset: string, candidates: UpdateCandidate[] }

export interface UpdateCandidate {
  tag: string
  asset: string
}

/**
 * Which of a release list applies to what is installed. A candidate is only offered when
 * its assets carry the asset the person is actually using, so a UI is never swapped for a
 * different flavour by an update.
 */
export function usableCandidates(
  releases: Array<{ tag: string, assets: Array<{ name?: string }> }>,
  asset: string,
  order: 'newer' | 'older',
  currentTag: string | null,
): UpdateCandidate[] {
  const found: UpdateCandidate[] = []

  for (const release of releases) {
    const names = release.assets.map(entry => entry.name ?? '').filter(isUiAsset)
    const matched = matchAsset(names, asset)
    if (!matched.ok)
      continue
    if (currentTag !== null) {
      const difference = compareTags(release.tag, currentTag)
      if (order === 'newer' && difference <= 0)
        continue
      if (order === 'older' && difference >= 0)
        continue
    }
    found.push({ tag: release.tag, asset: matched.name })
  }

  return found
}

/** What the asset the UI is using is likely called, when it never declared one. */
export function impliedAsset(identity: UiIdentity): string | null {
  if (identity.asset !== null && identity.asset.length > 0)
    return identity.asset
  if (identity.name.length > 0)
    return `${identity.name}.zip`
  return null
}

/**
 * The decision, with no I/O in it: given what is installed and this panel's release,
 * what should `ui-update` do? `releases` is only consulted for someone else's UI.
 */
export function planUiUpdate(
  installed: UiIdentity | null,
  runningTag: string,
  releases: Array<{ tag: string, assets: Array<{ name?: string }> }> = [],
  order: 'newer' | 'older' = 'newer',
): UiUpdatePlan {
  if (installed === null)
    return { kind: 'stock' }

  const repo = installed.repo === null ? null : parseRepoSlug(installed.repo)
  if (repo === null)
    return { kind: 'unidentifiable', identity: installed }

  if (isOwnRepo(repo))
    return { kind: 'official', identity: installed, target: runningTag }

  const asset = impliedAsset(installed)
  if (asset === null)
    return { kind: 'unidentifiable', identity: installed }

  return { kind: 'choice', identity: installed, asset, candidates: usableCandidates(releases, asset, order, installed.tag) }
}

/** `home-hosted ui-update` — see the module comment for the three cases. */
export async function uiUpdate(argv: string[], io: { write: (text: string) => void, prompt: (question: string) => Promise<string>, style: { bold: (text: string) => string, dim: (text: string) => string, green: (text: string) => string } }): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: 'string' },
      asset: { type: 'string' },
      token: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      old: { type: 'boolean' },
      check: { type: 'boolean' },
      repo: { type: 'string' },
    },
    allowPositionals: false,
  })

  const { appVersion } = await import('#src/helpers/version')
  const { dataRoot } = await import('#src/helpers/paths')
  const { UiService } = await import('#src/services/ui')

  const context: UpdateContext = {
    io: { write: io.write, style: io.style },
    ask: process.stdin.isTTY === true && values.yes !== true ? io.prompt : null,
    version: appVersion(),
    token: values.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null,
  }

  const ui = new UiService({ dataRoot })
  const status = ui.status()
  const installed = identityOf(status.meta)

  if (installed === null) {
    io.write(`${io.style.dim('the stock UI is in use — it ships with the panel and is always current')}\n`)
    return
  }

  // `--repo` makes a UI that never declared one updateable, without reinstalling by hand.
  if (values.repo !== undefined) {
    const repo = parseRepoSlug(values.repo)
    if (repo === null)
      throw new Error(`invalid --repo "${values.repo}" — expected an "owner/name" slug, e.g. ${DEFAULT_REPO}`)
    installed.repo = repoSlug(repo)
  }

  const order = values.old === true ? 'older' : 'newer'
  const repo = installed.repo === null ? null : parseRepoSlug(installed.repo)

  // `--tag` names the release outright, so nothing has to be listed or chosen.
  if (values.tag !== undefined && repo !== null) {
    await installTag(repo, values.asset ?? installed.asset ?? null, values.tag, context)
    return
  }

  let releases: Array<{ tag: string, assets: Array<{ name?: string }> }> = []
  if (repo !== null && !isOwnRepo(repo))
    releases = await fetchReleases(repo, context)

  const plan = planUiUpdate(installed, `v${context.version}`, releases, order)
  if (plan.kind === 'stock')
    return

  if (plan.kind === 'unidentifiable') {
    io.write(`${io.style.bold('this UI does not say where it came from')} — nothing to follow automatically\n`)
    printIdentity(io, plan.identity)
    io.write(`  ${io.style.dim('point it at a repo to make this work: home-hosted ui-update --repo owner/name')}\n`)
    return
  }

  if (plan.kind === 'official') {
    if (values.check === true) {
      printCheck(io, plan.identity, plan.target)
      return
    }
    if (plan.identity.tag === plan.target) {
      io.write(`${io.style.green('already current')} — ${io.style.bold(plan.identity.name)} is at ${plan.target}\n`)
      return
    }

    io.write(`${io.style.bold(`${plan.identity.name} ${plan.identity.version ?? ''}`.trim())} is on ${plan.identity.tag ?? 'an unknown tag'}; this panel is ${plan.target} — updating\n`)
    await installTag(repo!, plan.identity.asset ?? values.asset ?? null, plan.target, context)
    return
  }

  // Someone else's UI: show what is installed, then what is actually available.
  if (values.check === true) {
    printCheck(io, plan.identity, null, plan.candidates)
    return
  }

  io.write(`${io.style.bold(plan.identity.name)} ${plan.identity.version ?? ''} — ${repoSlug(repo!)}@${plan.identity.tag ?? 'unknown tag'}\n`)
  io.write(`  ${io.style.dim(`asset: ${plan.asset}`)}\n`)

  if (plan.candidates.length === 0) {
    const direction = order === 'newer' ? 'newer' : 'older'
    io.write(`no ${direction} releases carry ${plan.asset}\n`)
    if (order === 'newer')
      io.write(`  ${io.style.dim('list older releases with: home-hosted ui-update --old')}\n`)
    return
  }

  const chosen = await chooseCandidate(plan.candidates, context, order)
  if (chosen === null) {
    io.write('cancelled — nothing was installed\n')
    return
  }

  await installTag(repo!, chosen.asset, chosen.tag, context)
}

function identityOf(meta: { name: string, version: string | null, repo?: string, tag?: string, asset?: string, unix?: number } | null): UiIdentity | null {
  if (meta === null)
    return null
  return {
    name: meta.name,
    version: meta.version,
    repo: meta.repo ?? null,
    tag: meta.tag ?? null,
    asset: meta.asset ?? null,
    unix: meta.unix ?? null,
  }
}

function printIdentity(io: { write: (text: string) => void }, identity: UiIdentity): void {
  io.write(`  name     ${identity.name}\n`)
  io.write(`  version  ${identity.version ?? 'unspecified'}\n`)
  io.write(`  repo     ${identity.repo ?? 'unspecified'}${identity.tag === null ? '' : ` @ ${identity.tag}`}\n`)
  if (identity.unix !== null)
    io.write(`  built    ${new Date(identity.unix * 1000).toISOString()}\n`)
}

function printCheck(
  io: { write: (text: string) => void, style: { dim: (text: string) => string, green: (text: string) => string } },
  identity: UiIdentity,
  target: string | null,
  candidates: UpdateCandidate[] = [],
): void {
  if (target !== null) {
    if (identity.tag === target) {
      io.write(`${io.style.green('up to date')} — ${identity.version ?? identity.name} at ${target}\n`)
      return
    }
    io.write(`update available: ${identity.tag ?? 'unknown'} → ${target}\n`)
    return
  }
  if (candidates.length === 0) {
    io.write(`up to date — no release carries ${identity.asset ?? identity.name}.zip\n`)
    return
  }
  io.write(`${candidates.length} release(s) available:\n`)
  for (const candidate of candidates)
    io.write(`  ${candidate.tag}  ${io.style.dim(candidate.asset)}\n`)
}

async function chooseCandidate(candidates: UpdateCandidate[], context: UpdateContext, order: 'newer' | 'older'): Promise<UpdateCandidate | null> {
  const headline = order === 'newer' ? 'Newer releases' : 'Older releases'
  const { io } = context
  io.write(`${io.style.bold(headline)}\n`)
  for (const [index, candidate] of candidates.entries())
    io.write(`  ${index + 1}) ${candidate.tag}\n`)

  if (context.ask === null) {
    if (candidates.length === 1)
      return candidates[0]!
    throw new Error([
      `${candidates.length} releases are available and this session cannot ask which one:`,
      ...candidates.map(candidate => `  ${candidate.tag}`),
      '  run it in a terminal, or pass --tag <tag>',
    ].join('\n'))
  }

  for (;;) {
    const answer = (await context.ask(`Select a release [1-${candidates.length}] (empty to cancel) `)).trim()
    if (answer.length === 0)
      return null
    if (/^\d+$/.test(answer)) {
      const index = Number.parseInt(answer, 10)
      if (index >= 1 && index <= candidates.length)
        return candidates[index - 1]!
    }
    const byTag = candidates.find(candidate => candidate.tag === answer)
    if (byTag !== undefined)
      return byTag
    io.write(`  ${io.style.dim(`no such choice — enter 1-${candidates.length} or a tag`)}\n`)
  }
}

/** Fetches one release's asset and installs it, reporting what landed. */
async function installTag(
  repo: { owner: string, name: string },
  wantedAsset: string | null,
  tag: string,
  context: UpdateContext,
): Promise<void> {
  const release = await fetchRelease(repo, tag, context)
  const names = release.assets.map(asset => asset.name ?? '').filter(isUiAsset)

  let assetName: string
  if (wantedAsset !== null && wantedAsset.length > 0) {
    const matched = matchAsset(names, wantedAsset)
    if (!matched.ok)
      throw new Error(`${matched.error}\n  in ${repo.owner}/${repo.name}@${release.tag}`)
    assetName = matched.name
  }
  else if (names.length === 1) {
    assetName = names[0]!
  }
  else {
    throw new Error(`${names.length} UI assets in ${repo.owner}/${repo.name}@${release.tag} — name one with --asset`)
  }

  const asset = release.assets.find(entry => entry.name === assetName)!
  const download = await downloadToTemp(assetDownloadUrl(asset), {
    'accept': 'application/octet-stream',
    'user-agent': `home-hosted/${context.version}`,
    ...(context.token !== null && context.token.length > 0 ? { authorization: `Bearer ${context.token}` } : {}),
  }, context)

  try {
    const { UiService } = await import('#src/services/ui')
    const { dataRoot } = await import('#src/helpers/paths')
    const result = await new UiService({ dataRoot }).install(download.file, assetName)

    if (!result.ok)
      throw new Error(`nothing was installed: ${result.error}`)

    const { meta } = result
    const { io } = context
    io.write(`${io.style.green('UI updated')} — ${meta.name} ${meta.version ?? ''} at ${release.tag}\n`)
    io.write(`  ${io.style.dim('refresh the browser to see it')}\n`)
  }
  finally {
    fs.rmSync(download.dir, { recursive: true, force: true })
  }
}

/**
 * The citty entry. Like `ui-switch`, the parsing and the messages stay in the plain
 * function so they can be exercised without a terminal.
 */
export const uiUpdateCommand = defineCommand({
  meta: { name: 'ui-update', description: 'update the installed UI to match this panel, or pick a release' },
  run: async ({ rawArgs }) => {
    await uiUpdate(rawArgs, {
      write: text => process.stdout.write(text),
      prompt,
      style,
    })
  },
})
