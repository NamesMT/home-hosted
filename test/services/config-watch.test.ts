import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigWatch } from '#src/services/config-watch'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function makeFile(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-watch-'))
  dirs.push(dir)
  const file = path.join(dir, 'servers.config.json')
  await fs.promises.writeFile(file, '{ "servers": [] }\n')
  return file
}

/** Polls until the expectation holds, so a test never guesses at a sleep. */
async function until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate())
      return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for the watcher')
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('configWatch', () => {
  it('sees a hand edit of the file it was pointed at', async () => {
    const file = await makeFile()
    let calls = 0
    const watch = new ConfigWatch({ file, onChange: () => calls++, debounceMs: 20, pollMs: 0 })
    watch.start()

    try {
      await fs.promises.writeFile(file, '{ "servers": [{ "id": "added" }] }\n')
      await until(() => calls > 0)
    }
    finally {
      watch.dispose()
    }
  })

  /** The poll is what carries a file on a mount where `fs.watch` never fires. */
  it('checks on demand, exactly what the poll does', async () => {
    const file = await makeFile()
    let calls = 0
    const watch = new ConfigWatch({ file, onChange: () => calls++, debounceMs: 20, pollMs: 0 })

    try {
      expect(calls).toBe(0)
      watch.check()
      await until(() => calls === 1)
    }
    finally {
      watch.dispose()
    }
  })

  /** An editor writing in pieces, or a burst of them, is one edit. */
  it('coalesces a burst into a single callback', async () => {
    const file = await makeFile()
    let calls = 0
    const watch = new ConfigWatch({ file, onChange: () => calls++, debounceMs: 30, pollMs: 0 })

    try {
      watch.check()
      watch.check()
      watch.check()
      await until(() => calls === 1)
      await wait(120)
      expect(calls).toBe(1)

      // …and a later change is a new one.
      watch.check()
      await until(() => calls === 2)
    }
    finally {
      watch.dispose()
    }
  })

  it('stops watching once disposed', async () => {
    const file = await makeFile()
    let calls = 0
    const watch = new ConfigWatch({ file, onChange: () => calls++, debounceMs: 20, pollMs: 0 })
    watch.start()
    watch.dispose()

    await fs.promises.writeFile(file, '{ "servers": [{ "id": "added" }] }\n')
    watch.check()
    await wait(150)

    expect(calls).toBe(0)
  })

  it('reports a watch it cannot establish instead of throwing', async () => {
    const missing = path.join(os.tmpdir(), 'hh2-watch-nonexistent', 'servers.config.json')
    const errors: unknown[] = []
    const watch = new ConfigWatch({
      file: missing,
      onChange: () => {},
      pollMs: 0,
      onError: error => errors.push(error),
    })

    watch.start()
    watch.dispose()

    expect(errors).toHaveLength(1)
  })
})
