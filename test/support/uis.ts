import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * Every UI in this repository, discovered rather than listed.
 *
 * Fourteen guards under `test/shared/` carried `['stock', 'noc-console']` inline — **23 sites across eight
 * files**. That is correct today and has two problems: a **third** UI would be silently unguarded by all of
 * them, and the lists could drift from `uis/` without anything noticing. The same shape has bitten this repo
 * repeatedly — `SHIPPED`, `IN_REPO`, `SOURCES`, `stateSignature`, the `windowsHide` scan, the patch-pair
 * list — and the answer each time was to discover the set instead of writing it down.
 *
 * The first pass over this converted **five** files and called the class fixed. It was not: eleven sites in
 * four more files were still literals, which is the recurring failure of fixing the instances in front of
 * you and naming it a sweep.
 *
 * The predicate is the one `scripts/build-uis.mjs` uses: a directory under `uis/` holding a
 * `vite.config.ts`. Matching it means a UI the build would ship is a UI the guards check.
 */
export function uiNames(): string[] {
  const root = path.join(process.cwd(), 'uis')
  const names = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'vite.config.ts')))
    .map(entry => entry.name)
    .sort()
  if (names.length === 0)
    throw new Error(`no UIs found under ${root} — a guard over "every UI" would pass for free`)
  return names
}

/** A UI's `src` directory, absolute. */
export function uiSrcDir(name: string): string {
  return path.join(process.cwd(), 'uis', name, 'src')
}

/**
 * Every `.vue` file in every UI, as `{ ui, file, body }` with the path relative to the repository.
 *
 * Reading the file here rather than in each guard keeps the "which files" question in one place.
 */
export function uiTemplates(): Array<{ ui: string, file: string, body: string }> {
  const out: Array<{ ui: string, file: string, body: string }> = []
  for (const ui of uiNames()) {
    const src = uiSrcDir(ui)
    for (const entry of fs.readdirSync(src, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.vue'))
        continue
      const full = path.join(entry.parentPath, entry.name)
      out.push({
        ui,
        file: path.relative(process.cwd(), full).replaceAll('\\', '/'),
        body: fs.readFileSync(full, 'utf8'),
      })
    }
  }
  return out.sort((left, right) => left.file.localeCompare(right.file))
}

/**
 * Every line of the contract sources: the barrel and each module under `src/shared/contracts/`.
 *
 * A scan that read only `contracts.ts` silently stopped covering whatever had been moved out of it — the
 * schemas' floors and trailers went unchecked while the tests stayed green. A split must widen the scan,
 * not shrink it.
 */
export function contractsSource(root: string): string {
  const dir = path.join(root, 'src', 'shared')
  const files = [path.join(dir, 'contracts.ts')]
  const sub = path.join(dir, 'contracts')
  if (fs.existsSync(sub)) {
    for (const entry of fs.readdirSync(sub)) {
      if (entry.endsWith('.ts'))
        files.push(path.join(sub, entry))
    }
  }
  return files.map(file => fs.readFileSync(file, 'utf8')).join('\n')
}
