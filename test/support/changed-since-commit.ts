import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * `--sinceLastRun` for CI, where it cannot work as shipped.
 *
 * Vitest's flag is `--changed` + `experimental.recordDependencies` + the `mtime` provider, and it
 * forces the last one. A CI checkout writes every file fresh, so every mtime is newer than any record
 * and the whole suite runs. This provider keeps the other two parts and answers from git instead:
 * the files that differ from `HH_TEST_SINCE`, the commit the cached records were taken at (CI saves
 * them only after a green run, so that commit was green). Vitest maps the files to the test files
 * whose recorded imports reach them; a test file with no record runs anyway.
 *
 * Imports are not every dependency, so the selection is widened where they are known to be blind:
 */
const WIDEN: Array<{ when: RegExp, run: RegExp, why: string }> = [
  // The CLI suites spawn `src/cli.ts`; what the child loads is not recorded in the parent.
  { when: /^(?:src\/cli(?:\.ts|\/)|src\/index\.ts|src\/app\.ts|bin\/)/, run: /^test\/cli\/.+\.test\.ts$/, why: 'spawned CLI' },
  // Source scans read UI and shared files as text, which records nothing; they are cheap.
  { when: /^(?:uis\/|src\/shared\/)/, run: /^(?:test\/shared\/|uis\/[^/]+\/test\/).+\.test\.ts$/, why: 'source scans' },
]

/** A change here can move any test's outcome, so it runs everything. */
const GLOBAL = /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json|vitest\.config\.ts|test\/support\/|test\/helpers\/)/

function git(args: string[], cwd: string): string[] {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
}

function testFiles(root: string): string[] {
  return git(['ls-files', '-z', '--', 'test', 'uis'], root).filter(file => file.endsWith('.test.ts'))
}

export default {
  async findChangedFiles(options: { root: string }): Promise<string[]> {
    const root = git(['rev-parse', '--show-toplevel'], options.root)[0]!.trim()
    const since = process.env.HH_TEST_SINCE?.trim() ?? ''
    if (since.length === 0)
      throw new Error('HH_TEST_SINCE names no commit: run the whole suite instead')

    const changed = [...new Set([
      ...git(['diff', '--name-only', '-z', `${since}`, 'HEAD'], root),
      ...git(['diff', '--name-only', '-z', 'HEAD'], root),
    ])]

    if (changed.some(file => GLOBAL.test(file))) {
      process.stdout.write(`[changed-since] a global input changed since ${since.slice(0, 7)}: running everything\n`)
      return testFiles(root)
    }

    const widened = new Set<string>()
    const all = testFiles(root)
    for (const rule of WIDEN) {
      if (changed.some(file => rule.when.test(file))) {
        for (const file of all.filter(test => rule.run.test(test))) widened.add(file)
        process.stdout.write(`[changed-since] widened for ${rule.why}\n`)
      }
    }
    process.stdout.write(`[changed-since] ${changed.length} file(s) changed since ${since.slice(0, 7)}\n`)
    return [...changed, ...widened].filter(file => fs.existsSync(path.join(root, file)))
  },
}
