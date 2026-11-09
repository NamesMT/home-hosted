import { describe, expect, it } from 'vitest'
import { backupArgsCli } from '../support/backup-args'

const { home, run, runSplit } = backupArgsCli()

/** The scope guards, and why they exist, are in `backup-args.test.ts`; these are the archive and output ones. */
describe('backup flag guards', () => {
  it('refuses restore with no archive, and names both ways to give one', () => {
    const missing = run(['backup', 'restore'])
    expect(missing.status, missing.output).toBe(1)
    expect(missing.output).toContain('needs an archive')
    // A person on a blank host has no name to pass: the refusal must mention `--from`.
    expect(missing.output).toContain('--from')
  })

  it('refuses an archive name together with --from', () => {
    // Two different archives named at once: picking one silently is the wrong guess on the
    // command that overwrites live data.
    const both = run(['backup', 'restore', 'x.zip', '--from', '/tmp/x.zip'])
    expect(both.status, both.output).toBe(1)
    expect(both.output).toContain('not both')
  })

  it('refuses --from on an action that cannot read an archive', () => {
    // A flag silently ignored is a flag the person believed worked.
    const created = run(['backup', 'create', '--all', '--from', '/tmp/x.zip'])
    expect(created.status, created.output).toBe(1)
    expect(created.output).toContain('--from does nothing for `backup create`')

    const listed = run(['backup', 'list', '--from', '/tmp/x.zip'])
    expect(listed.status, listed.output).toBe(1)
    expect(listed.output).toContain('--from does nothing for `backup list`')
  })

  /** Every flag an action cannot honour, not only `--from`: each was parsed and silently dropped. */
  it('refuses any flag the action cannot honour, and an archive name outside restore', () => {
    for (const extra of [['--all'], ['--include', 'global'], ['--exclude', 'global'], ['--password', 'x'], ['--confirm']]) {
      const listed = run(['backup', 'list', ...extra])
      expect(listed.status, `${extra.join(' ')}\n${listed.output}`).toBe(1)
      expect(listed.output).toContain(`${extra[0]} does nothing for \`backup list\``)
    }

    // `create foo --all` archived everything and never mentioned `foo`.
    const named = run(['backup', 'create', 'foo', '--all', '--confirm'])
    expect(named.status, named.output).toBe(1)
    expect(named.output).toContain('takes no archive name ("foo")')
    expect(named.output).not.toContain('backup created')
  })

  /**
   * A session that cannot be asked is not consent, and not a success either.
   *
   * It printed the plan and exited 0, so `backup create --all` in a cron job never took a backup and
   * nothing in its exit status said so. `--json` without `--confirm` is the explicit plan request and
   * stays 0.
   */
  it('refuses to apply without --confirm when it cannot ask, and exits 1', () => {
    const split = runSplit(['backup', 'create', '--all'])
    expect(split.status, split.stderr).toBe(1)
    expect(split.stderr).toContain('--confirm')
    expect(split.stdout).toContain('Plan')

    const plan = runSplit(['backup', 'create', '--all', '--json'])
    expect(plan.status, plan.stderr).toBe(0)
    expect(JSON.parse(plan.stdout)).toMatchObject({ action: 'create', apply: false })
  })

  /**
   * A path is a *file* question before it is a scope question.
   *
   * `restore --from /media/usb` (no `--all`, no `--include`) answered "name what to act on" to
   * someone who had already named their archive, hiding the real problem — a directory, or a typo.
   * Measured: the good sentence existed only one flag away, so it read as a scope mistake.
   */
  it('names a missing or non-file --from path before complaining about the scope', () => {
    const missing = run(['backup', 'restore', '--from', '/definitely/not/here.zip'])
    expect(missing.status, missing.output).toBe(1)
    expect(missing.output).toContain('no file at /definitely/not/here.zip')
    expect(missing.output).not.toContain('name what to act on')

    // A directory is the case `existsSync` alone says yes to.
    const dir = run(['backup', 'restore', '--from', home])
    expect(dir.status, dir.output).toBe(1)
    expect(dir.output).toContain(`no file at ${home}`)
    expect(dir.output).not.toContain('name what to act on')
  })

  /**
   * A refusal is one message, and it belongs on the stream a reader is watching.
   *
   * Measured on the built CLI: `backup create --json` wrote `  global` / `    - global:settings` to
   * **stdout** and `error name what to act on` to **stderr**. A `--json` caller therefore got
   * neither a document nor a reason — the ids are not JSON — and a terminal that filters stderr saw
   * a list with nothing saying what was wrong. The sentence and the ids it introduces are one
   * refusal, so they travel together.
   */
  it('writes a whole refusal to stderr, leaving stdout for the answer', () => {
    const split = runSplit(['backup', 'create', '--json'])
    expect(split.status, split.stderr).toBe(1)
    expect(split.stdout, 'a refused --json run has no answer to print on stdout').toBe('')
    expect(split.stderr).toContain('name what to act on')
    // The ids are part of the refusal, not a document.
    expect(split.stderr).toContain('global:settings')
  })

  it('refuses an unknown action instead of guessing', () => {
    const unknown = run(['backup', 'destroy'])
    expect(unknown.status, unknown.output).toBe(1)
    expect(unknown.output).toContain('unknown action')
  })
})
