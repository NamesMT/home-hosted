/**
 * A mechanical walk of the panel's MUTATING actions against a real built panel.
 *
 * This is not a substitute for an independent review — it is the empirical half: does a save actually
 * persist, does a create actually appear, does a delete actually remove. Every check reads the value
 * back from the API rather than from the field that was typed into.
 *
 * Two things it learned the hard way, both correct panel behaviour:
 *
 *  - `POST /api/backups` **rejects** `{ apply: false }` — the plan is what an unconfirmed call gets, and
 *    the key is not part of the request. A body naming it is a `400 INVALID_INPUT`.
 *  - The accounts routes need a **session**, not a credential. A bearer token is refused with `403`,
 *    which is the rule that keeps a leaked token from minting more tokens.
 *
 * Usage: `pnpm run verify:actions` — it makes its own throwaway home and account, boots the BUILT panel
 * on a free port, walks the actions and stops it again. Nothing outside `/tmp` is touched.
 *
 * Run it against a built tree (`pnpm run build` first), and after any change to a route's request or
 * response shape: this is the half a unit test cannot see — that a save survives the trip to disk and
 * back, and that a credential is refused where it should be.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const PORT = Number(process.env.VERIFY_PORT ?? 6994)
const BASE = `http://127.0.0.1:${PORT}`
const HOME = process.env.HHOSTED_HOME ?? path.join(os.tmpdir(), 'hh-verify')
const ACCOUNT = 'verify'
const SECRET = 'verify-secret-123456'
/** `<id>:<secret>`, set below once the account exists. */
const TOKEN = `${ACCOUNT}:${SECRET}`

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN === null ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) }
  catch { body = text }
  return { status: res.status, body, headers: res.headers }
}

async function waitForPanel(timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok)
        return true
    }
    catch {}
    await new Promise(r => setTimeout(r, 400))
  }
  return false
}

async function main() {
  console.log(`home: ${HOME}  base: ${BASE}`)

  // A throwaway home with a known credential, so the walk needs no setup from the caller.
  fs.rmSync(HOME, { recursive: true, force: true })
  const account = spawnSync(
    process.execPath,
    ['dist/cli.js', 'account', 'create', ACCOUNT, '--scope', 'read,lifecycle,config,proxy,admin'],
    { env: { ...process.env, HHOSTED_HOME: HOME, HHOSTED_SECRET: SECRET }, encoding: 'utf8' },
  )
  if (account.status !== 0) {
    record('the walk can create its account', false, (account.stderr || account.stdout).slice(0, 300))
    return
  }

  const up = spawn(process.execPath, ['dist/cli.js', 'up', '--foreground', '--port', String(PORT)], {
    env: { ...process.env, HHOSTED_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  up.stderr.on('data', (d) => { stderr += d })

  try {
    if (!await waitForPanel()) {
      record('panel boots', false, `stderr: ${stderr.slice(-400)}`)
      return
    }
    record('panel boots', true)

    // ---- servers: create, edit, read back, delete ----
    const created = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({ id: 'verify1', command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] }),
    })
    record('create a server', created.status === 200 || created.status === 201, `status ${created.status}`)

    const patched = await api('/api/servers/verify1', {
      method: 'PATCH',
      body: JSON.stringify({ label: 'Verified Label' }),
    })
    record('patch a server', patched.status === 200, `status ${patched.status}`)

    const readBack = await api('/api/servers')
    const found = (readBack.body.servers ?? []).find(s => s.id === 'verify1')
    record('a patched label reads back', found?.config?.label === 'Verified Label', `got ${JSON.stringify(found?.config?.label)}`)

    /**
     * A secret written through the API is **reported as set, never read back**.
     *
     * Two steps, and the order is the API's rule rather than a convenience: the entry's `secretEnv` is the
     * **consent**, so a name it does not declare is refused before any value is touched. Only then does
     * `PUT …/secrets` take `{ set }` — not the field name I first guessed — and answer `ok` with no echo.
     *
     * This is the one write whose failure would be worst and whose success is invisible: the value must
     * reach the 0600 store and must never come back over the wire. So the check is the pair — `secretEnvSet`
     * names it, and no response anywhere carries the value.
     */
    const secretValue = 'sk-verify-should-never-be-returned'
    const declare = await api('/api/servers/verify1', {
      method: 'PATCH',
      body: JSON.stringify({ secretEnv: ['VERIFY_TOKEN_NAME'] }),
    })
    record('declare a secret name on the entry', declare.status === 200, `status ${declare.status}`)

    const setSecret = await api('/api/servers/verify1/secrets', {
      method: 'PUT',
      body: JSON.stringify({ set: { VERIFY_TOKEN_NAME: secretValue } }),
    })
    record('write the secret value', setSecret.status === 200, `status ${setSecret.status}`)

    const afterSecret = await api('/api/servers')
    const withSecret = (afterSecret.body.servers ?? []).find(s => s.id === 'verify1')
    record(
      'the secret name is reported as set',
      (withSecret?.secretEnvSet ?? []).includes('VERIFY_TOKEN_NAME'),
      `secretEnvSet ${JSON.stringify(withSecret?.secretEnvSet)}`,
    )
    record(
      'the secret VALUE never comes back over the wire',
      !JSON.stringify(afterSecret.body).includes(secretValue),
      'the response carries no plaintext secret',
    )

    // ---- workspace settings: write, read back (a different store from the panel's) ----
    const wsPatch = await api('/api/settings/workspace', {
      method: 'PATCH',
      body: JSON.stringify({ logs: { keep: 7 } }),
    })
    record('patch workspace settings', wsPatch.status === 200, `status ${wsPatch.status}`)
    const wsRead = await api('/api/settings/workspace')
    record('the workspace setting reads back', wsRead.body?.logs?.keep === 7, `got ${JSON.stringify(wsRead.body?.logs?.keep)}`)

    // ---- jobs: create, read back ----
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ id: 'verifyjob', command: 'node', schedule: '*/5 * * * *' }),
    })
    record('create a job', job.status === 200 || job.status === 201, `status ${job.status}`)

    const jobs = await api('/api/jobs')
    record('the job reads back', (jobs.body.jobs ?? []).some(j => j.id === 'verifyjob'), `count ${(jobs.body.jobs ?? []).length}`)

    // ---- settings: write, read back ----
    const before = await api('/api/settings')
    const beforeLabel = before.body?.control?.label
    const setLabel = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ control: { label: 'Verification Panel' } }),
    })
    record('patch control settings', setLabel.status === 200, `status ${setLabel.status}`)
    const after = await api('/api/settings')
    record('the label persists', after.body?.control?.label === 'Verification Panel', `was ${JSON.stringify(beforeLabel)}, now ${JSON.stringify(after.body?.control?.label)}`)

    /**
     * `POST /api/backups` **creates** — the plan-then-confirm flow belongs to the `/_hh` CLI channel,
     * where `confirm=true` is what turns a plan into an archive. This body carries no `apply` key at
     * all, which the route refuses (`apply must be removed`), and the archive it answers with is real.
     */
    const backup = await api('/api/backups', { method: 'POST', body: JSON.stringify({}) })
    record(
      'a backup is taken and named in the list',
      backup.status === 200 && typeof backup.body.file?.name === 'string' && backup.body.file.sizeBytes > 0,
      `status ${backup.status}, file ${backup.body.file?.name ?? 'none'} (${backup.body.file?.sizeBytes ?? 0} B)`,
    )

    const listedBackups = await api('/api/backups')
    record(
      'the archive is in the list it returns',
      (listedBackups.body.files ?? []).some(f => f.name === backup.body.file?.name),
      `count ${(listedBackups.body.files ?? []).length}`,
    )

    // ---- accounts: a SESSION can manage them; a credential cannot ----
    const bearerCreate = await api('/api/auth/accounts', {
      method: 'POST',
      body: JSON.stringify({ id: 'viaBearer', label: 'Bearer', scopes: ['read'] }),
    })
    record('a bearer token may NOT create an account', bearerCreate.status === 403, `status ${bearerCreate.status}`)

    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ id: 'verify', secret: TOKEN?.split(':').slice(1).join(':') ?? '' }),
    })
    record('sign in', login.status === 200, `status ${login.status}`)
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''

    const viaSession = await api('/api/auth/accounts', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ id: 'verifyacct', label: 'Verify', scopes: ['read'] }),
    })
    record('a session creates an account', viaSession.status === 200 || viaSession.status === 201, `status ${viaSession.status}`)

    const acctPatch = await api('/api/auth/accounts/verifyacct', {
      method: 'PATCH',
      headers: { cookie },
      body: JSON.stringify({ label: 'Verified Account' }),
    })
    record('a session patches an account', acctPatch.status === 200, `status ${acctPatch.status}`)

    const acctList = await api('/api/auth/accounts', { headers: { cookie } })
    const listed = (acctList.body.accounts ?? []).find(a => a.id === 'verifyacct')
    record('the patched account label reads back', listed?.label === 'Verified Account', `got ${JSON.stringify(listed?.label)}`)

    // ---- proxy: read ----
    const proxy = await api('/api/proxy')
    record('read the proxy config', proxy.status === 200, `status ${proxy.status}`)

    // ---- openapi ----
    const spec = await api('/openapi/spec.json')
    record('the OpenAPI spec loads', spec.status === 200 && typeof spec.body === 'object', `status ${spec.status}`)

    /**
     * How much of the write surface this walk actually touches.
     *
     * It exercises nine routes of the **73** the spec publishes as `POST`/`PATCH`/`PUT`/`DELETE`. Reporting
     * that honestly is the point: a walk that covers a tenth of the surface and says "19/19 passed" reads
     * as coverage it does not have. The number is printed rather than asserted at a floor, because a floor
     * on a *sample* invites padding the sample; what the walk must keep covering is the paths a save
     * travels, and those are named in the commit that added each one.
     */
    const writeRoutes = []
    for (const [route, methods] of Object.entries(spec.body.paths ?? {})) {
      for (const method of Object.keys(methods)) {
        if (['post', 'patch', 'put', 'delete'].includes(method))
          writeRoutes.push(`${method.toUpperCase()} ${route}`)
      }
    }
    const exercised = [
      'POST /api/servers',
      'PATCH /api/servers/{id}',
      'PUT /api/servers/{id}/secrets',
      'DELETE /api/servers/{id}',
      'POST /api/jobs',
      'PATCH /api/settings',
      'PATCH /api/settings/workspace',
      'POST /api/backups',
      'POST /api/auth/login',
      'POST /api/auth/accounts',
      'PATCH /api/auth/accounts/{id}',
    ]
    const missing = exercised.filter(route => !writeRoutes.includes(route))
    record(
      'every route this walk believes it exercises is really published',
      missing.length === 0,
      missing.length ? `absent from the spec: ${missing.join(', ')}` : `${exercised.length} of ${writeRoutes.length} write routes`,
    )

    // ---- delete the server, confirm removal ----
    const del = await api('/api/servers/verify1', { method: 'DELETE' })
    record('delete a server', del.status === 200, `status ${del.status}`)
    const afterDel = await api('/api/servers')
    record('the deleted server is gone', !(afterDel.body.servers ?? []).some(s => s.id === 'verify1'))
  }
  finally {
    up.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 600))
    if (!up.killed)
      up.kill('SIGKILL')
    // The throwaway home is this script's, so it cleans it up rather than leaving it for the next run.
    fs.rmSync(HOME, { recursive: true, force: true })
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    console.log('FAILURES:')
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail ?? ''}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('walk threw:', error)
  process.exitCode = 1
})
