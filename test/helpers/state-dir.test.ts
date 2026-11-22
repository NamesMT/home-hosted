import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { writeFileAtomic } from '#src/helpers/atomic'
import { ensureStateDir, hhDir } from '#src/helpers/paths'

/**
 * `.hh` is the owner's alone, whichever command creates it.
 *
 * Only `up` used to set `0700`; anything else that got there first (`backup list`, a first
 * `set-password`) made it with a bare recursive `mkdir`, so `.hh` was `0755` until the first `up`.
 * Every creator goes through `ensureStateDir`, including `writeFileAtomic`.
 */
describe.skipIf(process.platform === 'win32')('ensureStateDir', () => {
  it('creates .hh at 0700 when a file deep inside it is the first thing written', () => {
    fs.rmSync(hhDir, { recursive: true, force: true })
    writeFileAtomic(path.join(hhDir, 'default', 'settings.json'), '{}\n')
    expect(fs.statSync(hhDir).mode & 0o777).toBe(0o700)
  })

  it('creates a directory outside .hh as asked, without touching .hh', () => {
    fs.rmSync(hhDir, { recursive: true, force: true })
    const outside = path.join(path.dirname(hhDir), 'elsewhere', 'deep')
    ensureStateDir(outside)
    expect(fs.existsSync(outside)).toBe(true)
    expect(fs.existsSync(hhDir)).toBe(false)
  })

  /**
   * A directory whose own contents are secret keeps its `0700` as well.
   *
   * The proxy's `bin/`, its engine data and `.proxy/state` (which holds `admin.json` and
   * `challenge.json`) used to call `fs.mkdirSync(..., { mode: 0o700 })` directly, to get that mode. The
   * bare call is not equivalent: with `recursive: true` it creates every missing parent at the umask
   * default, so `.hh` came out `0755` — world-readable — whenever the proxy got there before `up` did.
   * Measured both ways: bare `.hh` is `755`, `ensureStateDir` gives `700`.
   *
   * The argument exists so the fix does not trade the parent's mode for the child's.
   */
  it('honours an explicit mode for the directory itself', () => {
    const secret = path.join(hhDir, '.proxy', 'bin')
    fs.rmSync(hhDir, { recursive: true, force: true })
    ensureStateDir(secret, 0o700)
    expect((fs.statSync(hhDir).mode & 0o777).toString(8), '.hh must not be world-readable').toBe('700')
    expect((fs.statSync(secret).mode & 0o777).toString(8), 'the proxy bin holds a downloaded engine').toBe('700')

    // Without the argument nothing changes for ordinary state directories.
    const plain = path.join(hhDir, 'plain')
    ensureStateDir(plain)
    expect((fs.statSync(plain).mode & 0o777).toString(8)).toBe('755')
  })

  /**
   * And nothing under `src/` reaches around the helper for a directory inside `.hh`.
   *
   * The argument above fixes three call sites; this stops the fourth. A bare
   * `mkdirSync(x, { recursive: true })` looks correct and silently leaves `.hh` at the umask default —
   * which is exactly how the proxy kept doing it, with `mode: 0o700` on the child and no idea that the
   * parent* it created was 0755. Three of these had accumulated before anyone checked.
   */
  /**
   * The names a state directory goes by in this codebase, as one alternation.
   *
   * Hoisted out of the loop so the regex is written once: the linter reads a capturing group used only
   * inside `\b…\b` as unused, and a non-capturing form is what it wants anyway.
   */
  const STATE_NAMES = /\b(?:hhDir|workspaceDir|workspaceJobsPath|proxyStateDir|proxyBinDir|proxyEngineDir|stateDir)\b/

  it('no src module creates a directory inside .hh without the helper', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const entry of fs.readdirSync(path.join(process.cwd(), 'src'), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts'))
        continue
      // `paths.ts` *is* the helper; its own two calls are the implementation, not a bypass.
      if (entry.name === 'paths.ts')
        continue
      scanned += 1
      const file = path.join(entry.parentPath, entry.name)
      const relative = path.relative(process.cwd(), file).replaceAll(String.fromCharCode(92) + String.fromCharCode(92), '/')
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.matchAll(/fs\.mkdirSync\([^,)]+/g)) {
        const argument = match[0].trim()
        /**
         * Only a directory that is *state* is the rule. `init` scaffolds a person's project and
         * `cli/service` writes a unit file — both outside `.hh`, where a bare call is correct.
         *
         * The shapes that are state: a `workspaceDir`/`hhDir` descendant, a `this.options.*Dir` the panel
         * owns, or a file path whose parent is one — which is how `openOutput` and the challenge file
         * were reaching it.
         */
        /**
         * "State" is decided by the *argument* or by a state-named parameter in the enclosing
         * function — `outputFiles(stateDir, id)` is the case that first slipped through: the call reads
         * `path.dirname(files.stdout)` and nothing in the text says `.hh`.
         */
        /**
         * The two files that legitimately create a directory **outside** `.hh` — a person's project
         * (`init`) and a systemd unit for them (`cli/service`). Named explicitly rather than inferred:
         * every heuristic I tried either missed `output.ts` (whose state directory arrives as a
         * parameter 60 lines above the call) or wrongly flagged `cli/service.ts` (which mentions a state
         * directory but writes a unit file). An allow-list of two cannot over-reach, and a fourth
         * bypass has to be added to it deliberately.
         */
        if (relative === 'src/services/init.ts' || relative === 'src/cli/service.ts')
          continue
        const isState = /this\.options\.\w*Dir/.test(argument)
          || STATE_NAMES.test(source)
        if (isState)
          offenders.push(`${path.relative(process.cwd(), file)}: ${match[0].trim()}`)
      }
    }
    expect(scanned, 'the scan found no sources — a broken glob would pass for free').toBeGreaterThan(50)
    expect(offenders, 'use ensureStateDir(), which also fixes .hh itself').toEqual([])
  })
})
