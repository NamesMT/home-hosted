import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyTree } from '#src/helpers/copy-tree'
import { errorHandler } from '#src/helpers/error'

/**
 * A restore copy that cannot land is the API's refusal, not a Node errno.
 *
 * `copyTree` refuses to copy a directory over a non-directory — a restore onto a path a person has
 * since replaced with a file, say — and it threw `code: 'ERR_FS_CP_DIR_TO_NON_DIR'`. That is `fs`'s
 * own vocabulary, and it reached clients in the same `{ message, code }` envelope as every code the
 * API defines: a generated client cannot branch on it, `docs/API.md` never listed it, and it named
 * the implementation rather than the problem. It answers `400 CONFIG_COPY_CONFLICT` now, which is
 * what the catalogue says it means.
 */

const dirs: string[] = []

beforeEach(() => {
  dirs.length = 0
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-copy-tree-'))
  dirs.push(dir)
  return dir
}

describe('copyTree refusing a directory over a file', () => {
  it('answers an API code, not the Node one it used to leak', async () => {
    const dir = await scratch()
    const source = path.join(dir, 'source')
    const target = path.join(dir, 'target')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'inside.txt'), 'x')
    // The target is a *file*: the copy cannot make it a directory.
    fs.writeFileSync(target, 'in the way')

    await expect(copyTree(source, target, () => true)).rejects.toMatchObject({ code: 'CONFIG_COPY_CONFLICT' })
  })

  /** What a client actually receives: the envelope, through the one error handler. */
  it('reaches a client as a 400 in the usual envelope', async () => {
    const dir = await scratch()
    const source = path.join(dir, 'source')
    const target = path.join(dir, 'target')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'inside.txt'), 'x')
    fs.writeFileSync(target, 'in the way')

    const app = new Hono()
      .onError(errorHandler)
      .post('/', async (c) => {
        await copyTree(source, target, () => true)
        return c.json({ ok: true })
      })

    const response = await app.request('/', { method: 'POST' })
    expect(response.status).toBe(400)
    const body = await response.json() as { code: string, message: string }
    expect(body.code).toBe('CONFIG_COPY_CONFLICT')
    expect(body.code, 'a Node errno must not reach a client').not.toMatch(/^ERR_/)
    expect(body.message).toContain('cannot overwrite non-directory')
  })
})
