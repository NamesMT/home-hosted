import { describe, expect, it } from 'vitest'
import { describeNannyExit } from '#src/providers/nanny'

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
