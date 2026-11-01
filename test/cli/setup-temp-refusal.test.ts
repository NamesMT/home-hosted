import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { isWsl } from '#src/providers/wsl-temperature'
import { stripComments } from '../helpers/strip-comments'

/**
 * A refusal is one sentence on one stream, and `fail()` never returns.
 *
 * `setup-temp --wsl` ends with a probe, and the line that reported a failed probe built its
 * sentence as `` `${fail('not set up')} — …${probe.error}` ``. `fail()` writes its own line and
 * calls `process.exit(1)`, so the template was never finished: measured with a helper that printed
 * no number, stderr held `error not set up`, the reason (`the script printed no number — is
 * LibreHardwareMonitor installed?`) appeared nowhere, and the helper line meant for stdout landed
 * on stdout first. A person was told that setup failed and not one word about why.
 *
 * Same shape as the download-failure line below it, where the install's own error was dropped.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const onWsl = isWsl()

/** Where the fake Windows host keeps ProgramData; the provider maps `C:\…` onto `/mnt/c`. */
const programData = `C:\\ProgramData\\hh-refusal-test-${process.pid}`
const guestData = path.join('/mnt/c/ProgramData', `hh-refusal-test-${process.pid}`)
/** Every scratch directory this file makes, removed however the test ends. */
const scratch: string[] = []

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

afterAll(() => {
  fs.rmSync(guestData, { recursive: true, force: true })
  for (const dir of scratch.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * A `powershell.exe` that answers the one query the provider makes and prints nothing for the
 * helper itself — the real shape of "LibreHardwareMonitor is not installed".
 */
function fakePowershell(): string {
  const dir = scratchDir('hh-fake-ps-')
  fs.writeFileSync(path.join(dir, 'powershell.exe'), [
    '#!/bin/sh',
    `# ProgramData lookup only; every other invocation prints nothing, like a helper with no library.`,
    `case "$*" in`,
    `  *env:ProgramData*) printf '%s\\n' "${programData}";;`,
    'esac',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  return dir
}

function runSetup(home: string, pathPrefix: string): Promise<{ code: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), 'setup-temp', '--wsl', '--no-download', '--home', home], {
      cwd: root,
      env: { ...process.env, HHOSTED_HOME: home, PATH: `${pathPrefix}${path.delimiter}${process.env.PATH ?? ''}`, NO_COLOR: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

describe('setup-temp reports a failed probe as one refusal', () => {
  it.runIf(onWsl)('names the reason the helper did not answer, on stderr alone', async () => {
    const home = scratchDir('hh-setup-refusal-')
    const result = await runSetup(home, fakePowershell())

    expect(result.code, 'a helper that does not answer is a failure').toBe(1)
    // The whole refusal on stderr: its label, the reason the probe gave, and where the helper is.
    expect(result.stderr).toContain('not set up')
    expect(result.stderr, 'the probe\'s own reason must survive the refusal').toContain('printed no number')
    expect(result.stderr, 'the refusal says what it left alone').toContain('left unchanged')
    // And never split across streams: no half of the sentence on stdout.
    expect(result.stdout).not.toContain('printed no number')
    expect(result.stdout).not.toContain('not set up')
  }, 180_000)
})

/**
 * The class, on every platform: `fail()` is a statement, never a value.
 *
 * A template literal, an assignment or a ternary reads it as one, and the exit happens before the
 * sentence around it is built. The scan reads every CLI source through `stripComments`, so a
 * `fail(` inside a string or a comment is not mistaken for the real call.
 */
describe('no CLI file reads a refusal as a value', () => {
  /**
   * A `fail(` is a statement of its own only when what precedes it has already ended one — a
   * semicolon, a closing brace or paren, an `else`. `${` is not a `{`: a template literal reads the
   * call as a value, which is the defect.
   */
  function isStatementPosition(prefix: string): boolean {
    const trimmed = prefix.trimEnd()
    if (trimmed.length === 0 || /\bfunction\s*$/.test(trimmed))
      return true
    const last = trimmed.at(-1)
    if (last === '{')
      return trimmed.at(-2) !== '$'
    return last === ';' || last === '}' || last === ')' || /\belse\s*$/.test(trimmed)
  }

  function expressionUses(source: string, file: string): string[] {
    const found: string[] = []
    const text = stripComments(source, file)
    for (const [index, line] of text.split('\n').entries()) {
      let at = line.indexOf('fail(')
      while (at !== -1) {
        if (!isStatementPosition(line.slice(0, at)))
          found.push(`${file}:${index + 1}: ${line.trim()}`)
        at = line.indexOf('fail(', at + 1)
      }
    }
    return found
  }

  it('finds no refusal used where a value is expected', () => {
    const files = [
      ...fs.readdirSync(path.join(root, 'src', 'cli')).filter(name => name.endsWith('.ts')).map(name => path.join(root, 'src', 'cli', name)),
      path.join(root, 'src', 'cli.ts'),
    ]
    const offenders = files.flatMap(file => expressionUses(fs.readFileSync(file, 'utf8'), path.relative(root, file)))
    expect(offenders).toEqual([])
  })
})
