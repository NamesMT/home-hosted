import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { identifyHolders, matchesSpawn, splitCommandLine } from '#src/providers/identity'

const cwd = process.cwd()
const entrySpawn = { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd }

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL')
    }
    catch {
      // already gone
    }
  }
})

/** A live process whose argv is this entry's, with the env marker deliberately scrubbed. */
function successorWithoutMarker(args: string[] = entrySpawn.args): Promise<number> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env.HHOSTED_SERVER_ID
    const child = spawn(process.execPath, args, { env, stdio: 'ignore' })
    children.push(child)
    if (child.pid === undefined)
      reject(new Error('could not spawn the successor'))
    else
      resolve(child.pid)
  })
}

describe('splitCommandLine', () => {
  it('keeps a quoted argument with spaces as one word', () => {
    expect(splitCommandLine('"C:\\Program Files\\node.exe" -e "a b c"')).toEqual(['C:\\Program Files\\node.exe', '-e', 'a b c'])
  })

  it('splits an unquoted path that has no spaces', () => {
    expect(splitCommandLine('/usr/bin/node --port 4000')).toEqual(['/usr/bin/node', '--port', '4000'])
  })

  it('treats quotes as delimiters, not content', () => {
    expect(splitCommandLine('node "" --x')).toEqual(['node', '', '--x'])
  })
})

describe('matchesSpawn', () => {
  it('accepts the image path when the argv follows it directly', () => {
    // The image spelling differs from the resolved command, which is exactly the case the
    // `imagePath` branch exists for: Windows reports both `ExecutablePath` and CommandLine.
    const argv = [process.execPath, '-e', 'setInterval(()=>{},1000)']
    expect(matchesSpawn({ words: argv, imagePath: process.execPath }, entrySpawn)).toBe(true)
  })

  it('matches a bare basename against a resolved image', () => {
    expect(matchesSpawn({ words: [path.basename(process.execPath), '-e', 'setInterval(()=>{},1000)'] }, entrySpawn)).toBe(true)
  })

  it('accepts the entry args as the opening words, so a wrapper may add more', () => {
    expect(matchesSpawn({ words: [process.execPath, '-e', 'setInterval(()=>{},1000)', '--extra'] }, entrySpawn)).toBe(true)
  })

  it('refuses another program that merely shares the flags', () => {
    expect(matchesSpawn({ words: ['/usr/bin/other', '-e', 'setInterval(()=>{},1000)'] }, entrySpawn)).toBe(false)
  })

  it('refuses the right image with a different argv', () => {
    expect(matchesSpawn({ words: [process.execPath, '-e', 'other script'] }, entrySpawn)).toBe(false)
  })

  it('refuses a shorter argv that the args would otherwise prefix', () => {
    expect(matchesSpawn({ words: [process.execPath, '-e'] }, entrySpawn)).toBe(false)
  })

  it('accepts the image-path spelling against the command line spelling', () => {
    // Windows reports `ExecutablePath` and `CommandLine` in different cases, and the
    // extension is optional in the config. Both spellings have to satisfy `sameWord`.
    const argv = ['c:\\node\\NODE.EXE', '-e', 'setInterval(()=>{},1000)']
    expect(matchesSpawn({ words: argv }, { ...entrySpawn, command: 'C:\\Node\\node.exe' })).toBe(process.platform === 'win32')
    expect(matchesSpawn({ words: argv }, { ...entrySpawn, command: 'node' })).toBe(process.platform === 'win32')
  })

  it('never matches on the image alone when the args differ', () => {
    expect(matchesSpawn({ words: ['other.exe', '--different'], imagePath: process.execPath }, entrySpawn)).toBe(false)
  })

  it('keeps a whitespace argument distinct from a missing one', () => {
    // Regression: comparing used to trim, so a lone-space argument matched a process
    // with no argument there at all — a false positive that `reclaim` would act on.
    const spacey = { ...entrySpawn, args: [' '] }
    expect(matchesSpawn({ words: [process.execPath] }, spacey)).toBe(false)
    expect(matchesSpawn({ words: [process.execPath, ''] }, spacey)).toBe(false)
    expect(matchesSpawn({ words: [process.execPath, ' '] }, spacey)).toBe(true)
  })

  it('never lets an argument be satisfied by a word that is not there', () => {
    // The empty-argument trap: a config arg of `''` (or a missing one) must not be
    // matched by a process that simply has no word in that position.
    const withEmpty = { ...entrySpawn, args: ['--flag', ''] }
    expect(matchesSpawn({ words: [process.execPath, '--flag'] }, withEmpty)).toBe(false)
    expect(matchesSpawn({ words: [process.execPath, '--flag', ''] }, withEmpty)).toBe(true)
  })

  it('refuses an argument that merely shares a basename', () => {
    // Regression: `sameWord`'s basename folding used to apply to arguments, so the
    // entry's script matched a stranger's script in another directory — and `reclaim`
    // kills what it matches.
    const scripted = { command: 'node', args: ['/srv/web/build/server.js', '--port', '4000'], cwd: '.' }
    expect(matchesSpawn({ words: ['/usr/bin/node', '/tmp/evil/build/server.js', '--port', '4000'] }, scripted)).toBe(false)
    expect(matchesSpawn({ words: ['/usr/bin/node', '/srv/web/build/server.js', '--port', '4000'] }, scripted)).toBe(true)
    expect(matchesSpawn({ words: ['/usr/bin/node', 'server.js', '--port', '4000'] }, scripted)).toBe(false)
  })
})

describe('identifyHolders', () => {
  it('recognizes a real successor that lost the environment marker', async () => {
    // This is the Windows case in miniature: no per-process environment, so the
    // entry's own argv is all the panel has to go on.
    const pid = await successorWithoutMarker()
    expect(await identifyHolders('web', entrySpawn, [pid])).toEqual([pid])
  })

  it('does not recognize a process that only looks similar', async () => {
    const pid = await successorWithoutMarker(['-e', 'setInterval(()=>{},2000)'])
    expect(await identifyHolders('web', entrySpawn, [pid])).toEqual([])
  })

  it('reports every match, so the caller can refuse an ambiguous takeover', async () => {
    const first = await successorWithoutMarker()
    const second = await successorWithoutMarker()
    expect(await identifyHolders('web', entrySpawn, [first, second])).toEqual([first, second])
  })
})
