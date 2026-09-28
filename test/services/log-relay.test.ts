import type { LogLine } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LogRelay } from '#src/services/log-relay'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function tempFile(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-relay-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'entry.log')
}

function write(file: string, text: string, stream: LogLine['stream'] = 'stdout'): void {
  fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), stream, text })}\n`)
}

describe('log relay', () => {
  it('hands back the lines a file gained after the last poll', async () => {
    // A nanny writes its final lines and exits between two polls; the panel only
    // learns of the exit afterwards, so those lines exist nowhere but the file.
    const file = await tempFile()
    const seen: LogLine[] = []
    const relay = new LogRelay({ onLines: (_id, lines) => seen.push(...lines), intervalMs: 60_000 })
    cleanups.push(() => relay.dispose())

    relay.follow('keep', file)
    write(file, 'last words before the crash', 'stderr')

    const rest = relay.unfollow('keep')

    expect(rest.map(line => line.text)).toEqual(['last words before the crash'])
    expect(seen).toEqual([])
  })

  it('reads a live tail without waiting for an unfollow', async () => {
    const file = await tempFile()
    const seen: LogLine[] = []
    const relay = new LogRelay({ onLines: (_id, lines) => seen.push(...lines), intervalMs: 10 })
    cleanups.push(() => relay.dispose())

    relay.follow('keep', file)
    write(file, 'hello')

    const deadline = Date.now() + 5000
    while (seen.length === 0 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10))

    expect(seen.map(line => line.text)).toEqual(['hello'])
    // Already read, so an unfollow has nothing left over.
    expect(relay.unfollow('keep')).toEqual([])
  })
})
