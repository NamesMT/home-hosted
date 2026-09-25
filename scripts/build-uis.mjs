#!/usr/bin/env node
/**
 * Builds the UIs under `uis/` — all of them, or the ones named on the command line.
 *
 * With `--zip` each build also becomes `uis/dist/home-hosted-ui-<name>.zip`, the
 * artifact the release attaches (upload it from Settings → Interface, or drop it into
 * `$HHOSTED_HOME/.ui`). The stock UI is additionally shipped inside the package.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const uisDir = path.join(root, 'uis')
const artifactsDir = path.join(uisDir, 'dist')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const args = process.argv.slice(2)
const withZip = args.includes('--zip')
const wanted = args.filter(arg => !arg.startsWith('-'))

const available = fs.readdirSync(uisDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(uisDir, entry.name, 'vite.config.ts')))
  .map(entry => entry.name)

if (wanted.length === 0 && available.length === 0)
  throw new Error(`no UIs found under ${uisDir}`)

for (const name of (wanted.length > 0 ? wanted : available)) {
  if (!available.includes(name))
    throw new Error(`unknown UI "${name}" (available: ${available.join(', ')})`)
}

async function* walk(dir, prefix = '') {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory())
      yield* walk(path.join(dir, entry.name), relative)
    else if (entry.isFile())
      yield relative
  }
}

/** A plain zip of the built UI, at the root — the shape `POST /api/settings/ui` expects. */
async function zipDirectory(sourceDir, target) {
  const { ZipWriter } = await import('@zip.js/zip.js')
  const { Readable, Writable } = await import('node:stream')

  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  const writer = new ZipWriter(Writable.toWeb(fs.createWriteStream(target)))
  for await (const relative of walk(sourceDir))
    await writer.add(relative, Readable.toWeb(fs.createReadStream(path.join(sourceDir, relative))))
  await writer.close()
}

for (const name of (wanted.length > 0 ? wanted : available)) {
  const uiDir = path.join(uisDir, name)
  process.stdout.write(`[uis] build ${name}\n`)
  execFileSync(pnpm, ['exec', 'vite', 'build', '--config', path.join(uiDir, 'vite.config.ts')], {
    cwd: root,
    stdio: 'inherit',
  })
  await stampUiTag(path.join(uiDir, 'dist'))
  if (!withZip)
    continue
  const target = path.join(artifactsDir, `home-hosted-ui-${name}.zip`)
  await zipDirectory(path.join(uiDir, 'dist'), target)
  const { size } = await fs.promises.stat(target)
  process.stdout.write(`[uis] ${path.relative(root, target)} (${Math.round(size / 1024)} KB)\n`)
}

/**
 * Records the release this build belongs to inside the built `ui.json`.
 *
 * The tag cannot be trusted from the source file: a UI zip is built *before* the release
 * is cut, so the committed `tag` is always a release behind the asset it sits in. Leaving
 * it stale is what made `ui-update` re-install the same UI on every boot, since the
 * recorded tag could never reach the panel's own version. `HHOSTED_UI_TAG` wins when set,
 * because the release workflow knows the version before `package.json` is bumped.
 */
async function stampUiTag(distDir) {
  const metaPath = path.join(distDir, 'ui.json')
  if (!fs.existsSync(metaPath))
    return

  let meta
  try {
    meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'))
  }
  catch {
    process.stdout.write(`[uis] ${path.relative(root, metaPath)} is not valid JSON — left alone\n`)
    return
  }

  const version = process.env.HHOSTED_UI_TAG ?? `v${JSON.parse(await fs.promises.readFile(path.join(root, 'package.json'), 'utf8')).version}`
  meta.tag = version
  await fs.promises.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  process.stdout.write(`[uis] ui.json tag -> ${version}\n`)
}
