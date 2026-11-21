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

  /**
   * Plus the **pseudo-commands** the dispatcher answers before the table is consulted.
   *
   * `home-hosted help <cmd>` and `home-hosted version` are real invocations that appear in no
   * `SYNOPSIS` entry — `args.ts` recognises them as tokens — so a scan built only from the table
   * would report a correct hint as naming a command that does not exist. Read from `args.ts` rather
   * than hardcoded, so the two stay in step.
   */
  const args = fs.readFileSync(path.join(root, 'src', 'cli', 'args.ts'), 'utf8')
  for (const match of args.matchAll(/const (?:HELP|VERSION)_TOKENS = new Set\(\[([^\]]+)\]\)/g)) {
    for (const token of [...(match[1] ?? '').matchAll(/'([a-z][a-z-]*)'/g)])
      names.push(token[1]!)
  }

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

/**
 * A message that tells a person to run a command must name one this release has.
 *
 * `src/middleware/auth.ts` answered `AUTH_DISABLED_REMOTE` with *"set a password
 * (`home-hosted set-password`) to reach it"* — a command the accounts refactor deleted. Nothing
 * caught it because the refusal is a string, not a spawn: the `scripts/` scan above only reads lines
 * that pass a command to `src/cli.ts`, and the docs links resolve whatever a message says.
 *
 * This is the user-facing half of the same deletion. A person reading it runs a command that is not
 * there, and the message that was supposed to unblock them is the thing that blocks them.
 */
describe('no user-facing message names a command this release does not have', () => {
  /**
   * A **backticked** `home-hosted <command>` hint.
   *
   * The backticks are load-bearing: without them the pattern matched prose — "is another home-hosted
   * running?", "no home-hosted state to migrate" — and reported fourteen offenders of which two were
   * real. A guard that cries wolf gets switched off, so this only reads what is formatted as a command.
   */
  const HINT = /`home-hosted\s+([a-z][a-z-]*)/g

  it('only names live commands in src/', () => {
    const known = knownCommands()
    const offenders: string[] = []
    for (const entry of fs.readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts'))
        continue
      const file = path.join(entry.parentPath, entry.name)
      const relative = path.relative(root, file)
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(HINT)) {
          const command = match[1]
          if (command === undefined || known.has(command))
            continue
          // `--version` and friends are flags the regex cannot see; a single-letter capture is not a
          // command name either.
          if (command.length < 3)
            continue
          offenders.push(`${relative}:${index + 1} names \`home-hosted ${command}\`, which is not a command`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('only names live commands in the shipped docs', () => {
    // The same class, one layer further out: a doc is what a person reads before typing anything.
    const known = knownCommands()
    const offenders: string[] = []
    for (const file of ['README.md', ...fs.readdirSync(path.join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => path.join('docs', name))]) {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n')
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(HINT)) {
          const command = match[1]
          if (command !== undefined && command.length >= 3 && !known.has(command))
            offenders.push(`${file}:${index + 1} names \`home-hosted ${command}\`, which is not a command`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('catches the message it was written for', () => {
    // The string that shipped. Kept as a literal so the regex is proven against real prose, not a shape
    // invented to fit it.
    const shipped = 'authentication is off — set a password (`home-hosted set-password`) to reach it'
    const known = knownCommands()
    const named = [...shipped.matchAll(HINT)].map(match => match[1])
    expect(named).toEqual(['set-password'])
    expect(known.has('set-password'), 'set-password is gone, so this hint sends a reader nowhere').toBe(false)
  })
})
