import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describeNannyExit, describeSpawnError } from '#src/providers/nanny'

/**
 * How a child's exit is described in the log and in history.
 *
 * `code 137` used to be the whole message, and that is the one an operator most wants explained —
 * it is what a container limit or the kernel OOM killer produces. The hint is deliberately worded
 * as a possibility: 128+N is a shell convention, and a program may exit 137 for its own reasons (a
 * JVM reports OOM that way itself). 126 and 127 are firmer, because the shell sets those when it
 * cannot run the command at all.
 */
describe('describing a child exit', () => {
  it('names the signal when the process was signalled', () => {
    // This is the common case: Node reports a kill as a signal, not as 128+N.
    expect(describeNannyExit({ code: null, signal: 'SIGKILL' } as never)).toBe('signal SIGKILL')
    expect(describeNannyExit({ code: null, signal: 'SIGTERM' } as never)).toBe('signal SIGTERM')
  })

  it('leaves an ordinary code alone', () => {
    expect(describeNannyExit({ code: 0, signal: null } as never)).toBe('code 0')
    expect(describeNannyExit({ code: 1, signal: null } as never)).toBe('code 1')
    // Above 128+64 there is no signal it could name, so nothing is guessed.
    expect(describeNannyExit({ code: 200, signal: null } as never)).toBe('code 200')
  })

  it('explains the shell codes that have a firm meaning', () => {
    expect(describeNannyExit({ code: 126, signal: null } as never)).toContain('not executable')
    expect(describeNannyExit({ code: 127, signal: null } as never)).toContain('not found')
  })

  it('hints at the likely signal for 128+N, without asserting it', () => {
    expect(describeNannyExit({ code: 137, signal: null } as never)).toContain('SIGKILL')
    expect(describeNannyExit({ code: 137, signal: null } as never)).toContain('memory')
    // 143 = 128+15. Worded as what the shell would report, not as a certainty.
    const term = describeNannyExit({ code: 143, signal: null } as never)
    expect(term).toContain('SIGTERM')
    expect(term).toContain('if the shell reported')
  })
})

/**
 * A spawn failure is where a non-technical user's first attempt ends.
 *
 * Node's `spawn java -jar server.jar ENOENT` names the whole command line, so it reads as "the
 * program is missing" even when the user pasted a command *line* into the `command` field and the
 * program is installed. The message a person sees has to name the program and what to check.
 */
describe('describeSpawnError', () => {
  const enoent = Object.assign(new Error('spawn java -jar server.jar ENOENT'), { code: 'ENOENT' })

  it('names a bare command as a missing program, not a missing file', () => {
    const message = describeSpawnError(enoent as NodeJS.ErrnoException, 'java')
    expect(message).toContain('`java`')
    expect(message).toContain('not found')
    expect(message).toContain('PATH')
    // It must not repeat the raw errno text the user cannot act on.
    expect(message).not.toContain('ENOENT')
  })

  it('points at the path when the command names one', () => {
    const missing = Object.assign(new Error('spawn /opt/app/server ENOENT'), { code: 'ENOENT' })
    const message = describeSpawnError(missing as NodeJS.ErrnoException, '/opt/app/server')
    expect(message).toContain('/opt/app/server')
    expect(message).toContain('does not exist')
  })

  it('treats a permission failure as its own, actionable case', () => {
    const denied = Object.assign(new Error('spawn ./run.sh EACCES'), { code: 'EACCES' })
    const message = describeSpawnError(denied as NodeJS.ErrnoException, './run.sh')
    expect(message).toContain('not executable')
    expect(message).toContain('chmod')
  })

  it('falls back to the original message for anything else', () => {
    const other = Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })
    const message = describeSpawnError(other as NodeJS.ErrnoException, 'node')
    expect(message).toContain('EMFILE')
    expect(message).toContain('node')
  })

  /**
   * The third cause of `ENOENT`, and the one a deployment hits.
   *
   * `spawn` resolves `cwd` *before* it looks for the program, so an entry whose working directory
   * does not exist under the launch directory fails with exactly the errno a missing program does.
   * Measured on a real panel started from `/` with `cwd: "./apps/web"`: the log read "`node` was
   * not found — is it installed, and is it on PATH" while `node` was installed and only the
   * relative path was wrong. Naming the program there sends the person to the wrong fix.
   */
  describe('a spawn failure whose real cause is the working directory', () => {
    const enoent = () => Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException

    it('names the missing directory instead of the program', () => {
      const message = describeSpawnError(enoent(), 'node', '/tmp/hh-no-such-dir-here/apps/web')
      expect(message).toContain('/tmp/hh-no-such-dir-here/apps/web')
      expect(message).toContain('does not exist')
      // The wrong diagnosis is what cost the time; it must not appear at all.
      expect(message).not.toContain('PATH')
      expect(message).not.toContain('is it installed')
    })

    it('says where a relative path came from, because that is the fix', () => {
      const message = describeSpawnError(enoent(), 'node', '/tmp/hh-no-such-dir-here/apps/web')
      // A unit file with no `WorkingDirectory=` or a container started from `/` is the usual cause.
      expect(message).toMatch(/started from/)
    })

    it('names a path that exists but is not a directory', () => {
      const message = describeSpawnError(enoent(), 'node', fileURLToPath(import.meta.url))
      expect(message).toContain('is not a directory')
    })

    it('still blames the program when the directory is fine', () => {
      // The guard must not swallow the case it already handled correctly.
      const message = describeSpawnError(enoent(), 'node', process.cwd())
      expect(message).toContain('not found')
      expect(message).toContain('PATH')
    })

    it('leaves a non-ENOENT failure alone, whatever the directory', () => {
      // A missing directory cannot explain EACCES, and rewriting it would hide a permission problem.
      const denied = Object.assign(new Error('spawn ./run.sh EACCES'), { code: 'EACCES' }) as NodeJS.ErrnoException
      const message = describeSpawnError(denied, './run.sh', '/tmp/hh-no-such-dir-here')
      expect(message).toContain('not executable')
    })
  })
})
