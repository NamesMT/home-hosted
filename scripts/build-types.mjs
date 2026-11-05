#!/usr/bin/env node
/**
 * Emits `dist/types/**` — the declarations `home-hosted/client` ships, so a client gets the server's
 * own route types (`AppType`) without the source tree.
 *
 * `#src/*` is this repository's import map (package.json `imports`), which points at `src/` — not in
 * the published package. Every specifier is rewritten to a relative `.js` path, which TypeScript
 * resolves to the `.d.ts` beside it under every module resolution mode.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, 'dist', 'types')

fs.rmSync(out, { recursive: true, force: true })
execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(root, 'tsconfig.types.json')], { stdio: 'inherit' })

/** `#src/a/b` → the emitted file it names, as a path relative to `from`. */
function rewrite(specifier, from) {
  const target = path.join(out, specifier.slice('#src/'.length))
  const file = fs.existsSync(`${target}.d.ts`) ? `${target}.js` : path.join(target, 'index.js')
  if (!fs.existsSync(file.replace(/\.js$/, '.d.ts')))
    throw new Error(`[types] ${path.relative(root, from)} names ${specifier}, which emitted no declaration`)
  const relative = path.relative(path.dirname(from), file).replaceAll('\\', '/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

/** Relative imports tsc kept extensionless (`./x`) get `.js` too, for node16/nodenext consumers. */
function withExtension(specifier, from) {
  if (/\.(?:js|json)$/.test(specifier))
    return specifier
  const target = path.resolve(path.dirname(from), specifier)
  return fs.existsSync(`${target}.d.ts`) ? `${specifier}.js` : `${specifier}/index.js`
}

let files = 0
for (const entry of fs.readdirSync(out, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.d.ts'))
    continue
  const file = path.join(entry.parentPath, entry.name)
  const text = fs.readFileSync(file, 'utf8')
  const next = text.replace(/(from\s+|import\()(['"])([^'"]+)\2/g, (whole, lead, quote, specifier) => {
    if (specifier.startsWith('#src/'))
      return `${lead}${quote}${rewrite(specifier, file)}${quote}`
    if (specifier.startsWith('./') || specifier.startsWith('../'))
      return `${lead}${quote}${withExtension(specifier, file)}${quote}`
    return whole
  })
  if (next !== text)
    fs.writeFileSync(file, next)
  files += 1
}

const leftover = fs.readdirSync(out, { recursive: true })
  .filter(name => String(name).endsWith('.d.ts'))
  .filter(name => fs.readFileSync(path.join(out, String(name)), 'utf8').includes('\'#src/'))
if (leftover.length > 0) {
  console.error(`[types] unrewritten #src specifiers in: ${leftover.join(', ')}`)
  process.exit(1)
}
console.log(`[types] ${files} declarations in dist/types`)
