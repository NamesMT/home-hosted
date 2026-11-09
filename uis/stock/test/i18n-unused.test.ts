import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every catalog row is a string someone reads.
 *
 * 54 rows (a whole telegram/webhook section superseded by `settings.destination.*`, a set of
 * `common.*` verbs, plural counters no view renders) were translated nine times over and shipped in
 * every catalog with nothing asking for them. A key is live when its exact text appears in the UI
 * or in the panel — the panel sends `labelKey`/`noteKey`/`reasonKey` for text it formats — or when
 * it starts with a prefix the code builds keys from (`` `status.${status}` ``).
 */
const root = fileURLToPath(new URL('../../..', import.meta.url))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'generated')
        out.push(...sourceFiles(full))
    }
    else if (/\.(?:ts|vue)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const corpus = [...sourceFiles(path.join(root, 'uis', 'stock', 'src')), ...sourceFiles(path.join(root, 'src'))]
  .map(file => fs.readFileSync(file, 'utf8'))
  .join('\n')

const sheets = path.join(root, 'uis', 'stock', 'i18n', 'sheets')
const keys = [...new Set(fs.readdirSync(sheets)
  .filter(name => name.endsWith('.csv'))
  .flatMap(name => fs.readFileSync(path.join(sheets, name), 'utf8').split('\n').slice(1))
  .map(line => line.split(',', 1)[0]!.replace(/\[\w+\]$/, ''))
  .filter(key => key.length > 0))]

/** Prefixes the code builds keys from: `` `status.${x}` `` and `` `proxy.retry.in${x}` ``. */
const builtPrefixes = [...corpus.matchAll(/`([a-z][\w.]*)\$\{/gi)].map(match => match[1]!).filter(prefix => prefix.includes('.'))

describe('the stock catalog', () => {
  it('has a row only for a key something reads', () => {
    expect(keys.length).toBeGreaterThan(1000)
    const quoted = (key: string): boolean => [`'${key}'`, `"${key}"`, `\`${key}\``].some(form => corpus.includes(form))
    const dead = keys.filter(key => !quoted(key) && !builtPrefixes.some(prefix => key.startsWith(prefix)))
    expect(dead, 'a catalog row nothing reads: wire it up or delete it from every sheet').toEqual([])
  })
})
