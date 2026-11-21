/**
 * Every Windows helper process this panel starts must hide its console window.
 *
 * **The bug this pins, seen by a person:** starting the panel made a console window flash, and then
 * keep flashing. `node:child_process` on Windows gives a console-subsystem child a **window** unless
 * `windowsHide: true` is passed — `timeout`, `maxBuffer` and `stdio` say nothing about it. The
 * supervisor ticks every second (`TICK_INTERVAL_MS`) and samples resources every five
 * (`RESOURCE_SAMPLE_INTERVAL_MS`), and that sample scans the process table with
 * `powershell.exe` / `wmic`, so a window appeared about every five seconds for as long as the panel
 * ran.
 *
 * `providers/port.ts` and `providers/identity.ts` already passed it, which is exactly why this went
 * unnoticed: the same call next door was correct, so the omission looked intentional.
 *
 * Read from the source rather than exercised, because the defect is in an **option bag beside a
 * spawn** — an injected fake or a mocked `execFile` never looks at it, and the real spawn's window is
 * not observable from a test. That is the same reason the state-layout test reads `paths.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Windows executables this panel shells out to, and so must launch hidden. */
const WINDOWS_PROGRAMS = [
  'powershell.exe',
  'powershell',
  'wmic',
  'taskkill',
  'netstat',
  'cmd.exe',
  'reg.exe',
  'schtasks.exe',
  'where.exe',
  'wscript.exe',
  'cscript.exe',
  'icacls',
] as const

/**
 * **Every** source file, discovered rather than listed.
 *
 * This was a hand-written array. Three files were added to it after the guard was written, each time
 * because a reviewer noticed — and the array still missed whatever came next: a new
 * `src/providers/zz-probe.ts` that spawned `powershell.exe` with no `windowsHide` passed this test,
 * which I checked before replacing the list. A guard over a list of files somebody remembered protects
 * exactly those files, which is the same failure mode as the missing flag it is meant to catch.
 *
 * Reading all of `src/` costs a few milliseconds and cannot fall behind.
 */
function sources(): string[] {
  const root = fileURLToPath(new URL('../../src', import.meta.url))
  const found: string[] = []
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts'))
      continue
    const relative = path.relative(path.join(root, '..'), path.join(entry.parentPath, entry.name))
    found.push(relative.split(path.sep).join('/'))
  }
  return found.sort()
}

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

/**
 * The **whole call** whose `program` argument starts at `at`, by matching parentheses.
 *
 * A fixed character window does not work and hid this bug once already: the first version read 600
 * characters past the program name, which ran past the end of a pretty-printed options bag into the
 * next* call — and that neighbour's `windowsHide` satisfied the assertion. Deleting the flag from
 * the periodic scan then left this test green, which is the failure mode a guard must not have.
 *
 * So the call is delimited properly: back up to its opening paren, then forward to the paren that
 * closes it, counting depth and skipping string literals.
 */
function callAround(source: string, at: number): string {
  // Back up from the program name to the `(` that opens *this* call. `lastIndexOf('(')` is wrong:
  // the argument list itself contains parens (`['-NoProfile', …]`), and the nearest one before the
  // name can be inside the array, which yielded the degenerate `()` and failed for the wrong reason.
  // The call's own paren is the nearest one preceded by the function name and any whitespace.
  // Any `exec*`/`spawn*` call: `execFileAsync`, `execFile`, `execFileSync`, `spawn`, … listed by
  // hand, `execFileSync` was missed and the scan then blamed a call that was already correct.
  const identifier = /(exec[A-Za-z]*|spawn[A-Za-z]*)\(/g
  let callStart = -1
  for (const match of source.matchAll(identifier)) {
    if ((match.index ?? 0) > at)
      break
    callStart = match.index ?? -1
  }
  if (callStart === -1)
    return ''
  const open = source.indexOf('(', callStart)
  if (open === -1)
    return ''
  let depth = 0
  let quote: string | null = null
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== null) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote)
        quote = null
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '(') {
      depth += 1
    }
    else if (char === ')') {
      depth -= 1
      if (depth === 0)
        return source.slice(open, index + 1)
    }
  }
  return source.slice(open)
}

describe('every Windows helper process is launched hidden', () => {
  it('passes windowsHide wherever a Windows program is started', () => {
    const offenders: string[] = []
    let seen = 0
    for (const relative of sources()) {
      const source = read(relative)
      for (const program of WINDOWS_PROGRAMS) {
        // `'name'` as a call argument: a mention in a comment or a type does not count.
        const pattern = new RegExp(`[\\s(]'${program.replace(/\./g, '\\.')}'`, 'g')
        for (const match of source.matchAll(pattern)) {
          seen += 1
          const call = callAround(source, match.index ?? 0)
          if (!call.includes('windowsHide'))
            offenders.push(`${relative}: ${program} at offset ${match.index}`)
        }
      }
    }
    // Anti-vacuity: the scan must have found the calls it is guarding.
    expect(seen, 'the Windows spawns must have been parsed').toBeGreaterThanOrEqual(4)
    expect(offenders).toEqual([])
  })

  it('keeps the periodic process scan hidden, which is the one a person watches', () => {
    // The scan runs on the resource-sample interval, so this is the window that kept appearing.
    const proc = read('src/providers/proc.ts')
    const start = proc.indexOf('execFileAsync(\'powershell.exe\'')
    expect(start, 'the Windows process scan must still be there').toBeGreaterThan(-1)
    expect(callAround(proc, start)).toContain('windowsHide: true')
    // And its fallback, which runs when PowerShell is unavailable.
    const fallback = proc.indexOf('execFileAsync(\'wmic\'')
    expect(fallback).toBeGreaterThan(-1)
    expect(callAround(proc, fallback)).toContain('windowsHide: true')
  })
})
