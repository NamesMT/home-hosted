import { describe, expect, it } from 'vitest'
import { parseNetstatListeners, parsePids } from '#src/providers/port'
import { parsePsOutput, parseWindowsCsv } from '#src/providers/proc'

describe('posix ps parsing', () => {
  it('reads pid, ppid, rss and cpu columns', () => {
    const rows = parsePsOutput([
      '    1     0   4096  0.0',
      '  512     1  18432  2.5',
      '',
      'garbage line',
    ].join('\n'))

    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ pid: 512, ppid: 1, rssKb: 18432, cpuPercent: 2.5 })
  })

  it('tolerates a non-numeric cpu column', () => {
    const rows = parsePsOutput('  7     1   1024  -\n')
    expect(rows[0]?.pid).toBe(7)
    expect(rows[0]?.cpuPercent).toBeUndefined()
  })
})

describe('windows process csv', () => {
  it('reads a quoted ConvertTo-Csv table', () => {
    const rows = parseWindowsCsv([
      '"ProcessId","ParentProcessId","WorkingSetSize","KernelModeTime","UserModeTime"',
      '"100","4","10485760","10000000","20000000"',
      '"200","100","5242880","0","0"',
    ].join('\r\n'))

    expect(rows).toHaveLength(2)
    // WorkingSetSize is bytes; the sampler works in kilobytes.
    expect(rows[0]).toMatchObject({ pid: 100, ppid: 4, rssKb: 10240 })
    // Kernel + user are 100ns units, so 3e7 == 3 seconds.
    expect(rows[0]?.cpuSeconds).toBeCloseTo(3, 5)
    expect(rows[1]?.cpuSeconds).toBe(0)
  })

  it('reads wmic style csv without quotes', () => {
    const rows = parseWindowsCsv([
      'Node,ProcessId,ParentProcessId,WorkingSetSize',
      'HOST,42,4,2048',
    ].join('\n'))

    expect(rows[0]).toMatchObject({ pid: 42, ppid: 4, rssKb: 2 })
    expect(rows[0]?.cpuSeconds).toBeUndefined()
  })

  it('returns nothing for an empty table', () => {
    expect(parseWindowsCsv('')).toEqual([])
    expect(parseWindowsCsv('ProcessId,ParentProcessId')).toEqual([])
  })
})

describe('windows netstat parsing', () => {
  it('picks only listeners on the requested port', () => {
    const output = [
      '  TCP    0.0.0.0:4010           0.0.0.0:0              LISTENING       4242',
      '  TCP    127.0.0.1:4010         0.0.0.0:0              LISTENING       4242',
      '  TCP    127.0.0.1:3999         0.0.0.0:0              LISTENING       1111',
      '  TCP    127.0.0.1:50000        127.0.0.1:4010         ESTABLISHED     9999',
      '  TCP    [::]:4010              [::]:0                 LISTENING       4242',
    ].join('\r\n')

    expect(parseNetstatListeners(output, 4010)).toEqual([4242])
    expect(parseNetstatListeners(output, 3999)).toEqual([1111])
    expect(parseNetstatListeners(output, 6000)).toEqual([])
  })
})

/**
 * The two shapes `listPortHolders` actually receives.
 *
 * `lsof -ti` prints one pid per line; `fuser <port>/tcp` prints them space-separated on a single
 * line, with a leading space (both confirmed against the real binaries on this machine). The
 * parser splits on `\s+` so one branch covers both — and this feeds `killPortHolders`, which sends
 * SIGKILL, so a shape it mis-read would target an unrelated process.
 */
describe('port-holder pid parsing', () => {
  const self = process.pid

  it('reads lsof output, one pid per line', () => {
    expect(parsePids('1718640\n')).toEqual([1718640])
    expect(parsePids('1718640\n1718641\n')).toEqual([1718640, 1718641])
  })

  it('reads fuser output, space-separated with a leading space', () => {
    expect(parsePids(` ${1718746}\n`)).toEqual([1718746])
    expect(parsePids(` ${1718746} 1718747\n`)).toEqual([1718746, 1718747])
  })

  it('drops the empty leading cell, pid 0, and our own process', () => {
    // The leading space is what produces an empty first element — it must not become a pid.
    expect(parsePids('  123\n')).toEqual([123])
    expect(parsePids('0\n')).toEqual([])
    expect(parsePids(`${self}\n`)).toEqual([])
    expect(parsePids('')).toEqual([])
  })

  it('never returns a pid it invented from a partial or negative number', () => {
    // No decimal pid appears in these, so nothing may be returned — a stray `1` here would be a
    // real process. (A digit-leading token *is* parsed: `12abc` -> 12, but that shape is not
    // something lsof or fuser emit, and the callers only ever pass real pids to `kill`.)
    for (const bogus of ['abc', '0x1F', '-1234', '   '])
      expect(parsePids(bogus), `"${bogus}" must not yield a pid`).toEqual([])
  })
})
