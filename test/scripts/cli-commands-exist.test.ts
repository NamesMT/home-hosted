import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

/**
 * No script may invoke a CLI command this release does not have.
 *
 * `scripts/dev.mjs` seeded the dev login by spawning `home-hosted set-password`. The accounts refactor
 * **deleted** that command, and nothing noticed: the spawn answered "unknown command", the seed
 * function returned false, and the script printed the failure to stderr while carrying on — so a
 * wiped `.dev-state/` came up on a **random** first-run secret while the banner still promised `dev`.
 * Everything that already had state kept working, which is why it survived: the broken path is the one
 * a person hits exactly once, on a fresh checkout.
 *
 * The same sweep in `test/services/init.test.ts` covers the *scaffold* it generates; it did not reach
 * `scripts/`. A source scan is what makes the next deletion safe here, because the failure is a
 * spawn whose non-zero status is only printed.
 */
const root = process.cwd()
const SCRIPTS = path.join(root, 'scripts')

/** Commands this release really has, read from the CLI's own dispatch table rather than restated. */
function knownCommands(): Set<string> {
  const source = fs.readFileSync(path.join(root, 'src', 'cli.ts'), 'utf8')
  // `SYNOPSIS` is the reference table: one entry per top-level command, which is what a script names.
  const block = /const SYNOPSIS: Record<string, string> = \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
  const names = [...block.matchAll(/^\s{2}'?([a-z][a-z-]*)'?:/gm)].map(match => match[1]!)
  expect(names.length, 'the SYNOPSIS table must be readable, or this scan proves nothing').toBeGreaterThan(10)
  return new Set(names)
}

describe('scripts/ only names CLI commands that exist', () => {
  it('does not spawn a removed command', () => {
    const known = knownCommands()
    // Every `src/cli.ts`, `<command>` pair a script passes to a spawn. The command is the first
    // bare word after the entry path; `--home <dir>` and friends are flags, so they are skipped by
    // the `--` test rather than by position.
    const offenders: string[] = []
    for (const file of fs.readdirSync(SCRIPTS).filter(name => /\.(?:mjs|js|ts)$/.test(name))) {
      const source = fs.readFileSync(path.join(SCRIPTS, file), 'utf8')
      for (const line of source.split('\n')) {
        if (!/src\/cli\.ts/.test(line) || line.trimStart().startsWith('*') || line.trimStart().startsWith('//'))
          continue
        // The argv array on this line, e.g. `['exec','tsx','src/cli.ts','set-password']`.
        const words = [...line.matchAll(/'([^']+)'/g)].map(match => match[1]!)
        const at = words.indexOf('src/cli.ts')
        if (at === -1)
          continue
        const command = words.slice(at + 1).find(word => !word.startsWith('-'))
        if (command === undefined)
          continue
        if (!known.has(command))
          offenders.push(`${file}: \`${command}\` is passed to src/cli.ts but is not a command this release has`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * The scan must see the shape it claims to, or it would pass on a broken script too.
   *
   * The line below is the one that was actually there; the mutation check is what makes the guard
   * load-bearing rather than merely present.
   */
  it('catches the removed command it was written for', () => {
    const known = knownCommands()
    const line = '  const result = spawnSync(pnpm, [\'exec\', \'tsx\', \'src/cli.ts\', \'set-password\'], {'
    const words = [...line.matchAll(/'([^']+)'/g)].map(match => match[1]!)
    const at = words.indexOf('src/cli.ts')
    const command = words.slice(at + 1).find(word => !word.startsWith('-'))!
    expect(command).toBe('set-password')
    expect(known.has(command), 'set-password is gone, so this script would fail silently').toBe(false)
  })
})
