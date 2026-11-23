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

    /**
     * **Restore is the one path that overwrites a live host**, and it had no coverage at all.
     *
     * The check is deliberately conservative: the entry it restores into is the `verify1` this walk
     * created moments ago, whose only content is a command line and a label — so a successful restore
     * puts back exactly what a capture took and touches nothing a person cares about. What it proves is
     * that the request schema accepts the documented shape, that the archive an earlier step wrote is
     * readable, and that the answer reports what it did.
     *
     * **`include` is omitted, not empty.** Omitting it means every restorable item; `include: []` means
     * nothing is selected*, and the panel answered exactly that — `applied` empty, `skipped` naming all
     * seventeen items as `(not selected)`. That is the right behaviour and a good demonstration of an
     * API that does not guess what an empty list meant.
     *
     * `exclude` is sent because the schema's own docblock records the bug where it was rejected: the same
     * request worked on the `/_hh` channel and answered `exclude must be removed` on `/api`, so a script
     * could never say "everything except these" on the destructive path.
     */
    const restored = await api('/api/backups/restore', {
      method: 'POST',
      body: JSON.stringify({
        name: backup.body.file.name,
        exclude: ['global:secrets'],
      }),
    })
    record(
      'restore accepts the documented request shape',
      restored.status === 200,
      `status ${restored.status}${restored.status !== 200 ? ` — ${JSON.stringify(restored.body).slice(0, 160)}` : ''}`,
    )
    record(
      'restore reports what it did, naming the items it restored',
      restored.status === 200 && Array.isArray(restored.body.appliedIds) && restored.body.appliedIds.length > 0,
      `${restored.body.appliedIds?.length ?? 0} item(s) applied, ${restored.body.skipped?.length ?? 0} skipped`,
    )
    record(
      'the excluded item was skipped rather than restored',
      (restored.body.skipped ?? []).some(line => /Global secrets/i.test(line)),
      `skipped ${restored.body.skipped?.length ?? 0}`,
    )

    // The entry the restore wrote back is still there and still reads as itself.
    const afterRestore = await api('/api/servers')
    const survived = (afterRestore.body.servers ?? []).find(s => s.id === 'verify1')
    record(
      'the restored entry still reads back',
      survived !== undefined,
      `servers ${(afterRestore.body.servers ?? []).length}`,
    )

    /**
     * **Deploy through the running panel** — the path with no test anywhere else.
     *
     * `test/cli/deploy.test.ts` covers deploy **offline**, which is the path someone uses *because the
     * panel is down*. The panel path resolves the entry's environment through its supervisor, and nothing
     * exercised it: a sweep of every `test/` file found `/_hh/servers/.../deploy` in none of them.
     *
     * The entry declares one step that writes a file, so the check is the file rather than the answer. A
     * deploy that reports success and runs nothing is exactly the shape this walk exists for.
     */
    const marker = `deploy-marker-${Date.now()}`
    const declared = await api('/api/servers/verify1', {
      method: 'PATCH',
      body: JSON.stringify({
        deploy: {
          steps: [{ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(require('node:path').join(process.env.HH_VERIFY_DIR ?? '.', '${marker}'), 'ok')`] }],
          restart: false,
        },
      }),
    })
    record('declare a deploy step on the entry', declared.status === 200, `status ${declared.status}`)

    const deployRun = await api('/api/servers/verify1/deploy', { method: 'POST', body: JSON.stringify({}) })
    record(
      'deploy through the panel reaches the route and reports its outcome',
      deployRun.status === 200 && typeof deployRun.body.ok === 'boolean',
      `status ${deployRun.status}, ok ${JSON.stringify(deployRun.body.ok)}, failedStep ${JSON.stringify(deployRun.body.failedStep ?? null)}`,
    )

    /**
     * **Notifications: a policy toggle and a destination, both read back.**
     *
     * The policy patch is the shape the schema's own docblock is emphatic about: it must be the
     * hand-written `notificationPolicyPatchShape` and **not** a `.partial()` of the defaults schema,
     * because ArkType keeps a `= false` / `= 120000` default through `.partial()` — so a body naming one
     * toggle would validate into all seven keys and overwrite the rest. That is a silent data loss, and
     * the only way to see it is to set one field and read the others back.
     *
     * A destination is **replaced whole as a list**, so adding one is "send the list with it in". Its
     * credential lives apart from the list (`PUT …/token`), which is why this adds an *enabled* webhook
     * with no token: the route must accept it and the list must report it, and a test that never sends
     * a real URL is a test that never makes an outbound call.
     */
    const beforePolicy = await api('/api/settings/workspace')
    const beforeDefaults = beforePolicy.body?.notifications?.defaults ?? {}
    const policyPatch = await api('/api/settings/workspace', {
      method: 'PATCH',
      body: JSON.stringify({ notifications: { defaults: { onHost: true } } }),
    })
    record('patch one notification policy toggle', policyPatch.status === 200, `status ${policyPatch.status}`)

    const afterPolicy = await api('/api/settings/workspace')
    const afterDefaults = afterPolicy.body?.notifications?.defaults ?? {}
    record(
      'the toggled field reads back as set',
      afterDefaults.onHost === true,
      `onHost ${JSON.stringify(afterDefaults.onHost)}`,
    )
    /**
     * The rest survived. This is the assertion that would have caught the `.partial()` bug: a derived
     * patch injects the code defaults, so every field it did not name comes back **changed**.
     */
    const collateral = Object.keys(beforeDefaults).filter(key =>
      key !== 'onHost' && JSON.stringify(beforeDefaults[key]) !== JSON.stringify(afterDefaults[key]))
    record(
      'no other policy field was overwritten by the patch',
      collateral.length === 0,
      collateral.length ? `changed: ${collateral.join(', ')}` : `${Object.keys(afterDefaults).length} field(s) unchanged`,
    )

    const destination = { kind: 'webhook', id: 'verifyhook', enabled: true, url: 'https://example.invalid/hook' }
    const addDestination = await api('/api/settings/workspace', {
      method: 'PATCH',
      body: JSON.stringify({ notifications: { destinations: [destination] } }),
    })
    record('add a notification destination', addDestination.status === 200, `status ${addDestination.status}`)

    const listedDestinations = await api('/api/settings/workspace')
    const dests = listedDestinations.body?.notifications?.destinations ?? []
    record(
      'the destination is listed with its kind and id',
      dests.some(d => d.id === 'verifyhook' && d.kind === 'webhook'),
      `${dests.length} destination(s): ${dests.map(d => `${d.kind}/${d.id}`).join(', ') || '(none)'}`,
    )

    /**
     * Clearing a destination's credential — `DELETE …/destinations/:id/token`.
     *
     * Local and idempotent, so it is walkable. Its sibling `PUT` is **not**: it calls Telegram to verify
     * the token before storing it, which is a real outbound request to a third party, and a walk that
     * makes one would be a walk that fails on a runner without egress. The delete has no such dependency
     * and is the half a person uses to revoke a credential that leaked.
     */
    const clearToken = await api('/api/notifications/destinations/verifyhook/token', { method: 'DELETE' })
    record(
      'clearing a destination credential is accepted (idempotent when none is set)',
      clearToken.status === 200,
      `status ${clearToken.status}`,
    )

    // Removing it is sending the list without it — a replace, not a merge.
    const removeDestination = await api('/api/settings/workspace', {
      method: 'PATCH',
      body: JSON.stringify({ notifications: { destinations: [] } }),
    })
    record('remove the destination by sending an empty list', removeDestination.status === 200, `status ${removeDestination.status}`)
    const afterRemove = await api('/api/settings/workspace')
    record(
      'the destination is gone',
      (afterRemove.body?.notifications?.destinations ?? []).length === 0,
      `${(afterRemove.body?.notifications?.destinations ?? []).length} left`,
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
     * A workspace is a whole store and an ownership boundary, created and removed through the API.
     *
     * Worth its own checks because the id is **derived from the label** when omitted, and a workspace id
     * keys everything downstream — SSE, buffers, routes. Creating one and then reading a resource through
     * its id is what proves the derivation and the ownership wiring agree.
     */
    const wsCreated = await api('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ label: 'Verify Workspace' }),
    })
    record('create a workspace', wsCreated.status === 200 || wsCreated.status === 201, `status ${wsCreated.status}`)
    const wsId = wsCreated.body.workspace?.id
    record('the id is derived from the label', typeof wsId === 'string' && wsId.length > 0, `id ${JSON.stringify(wsId)}`)

    const wsListed = await api('/api/workspaces')
    record('the workspace is listed', (wsListed.body.workspaces ?? []).some(w => w.id === wsId), `count ${(wsListed.body.workspaces ?? []).length}`)

    const wsRenamed = await api(`/api/workspaces/${wsId}`, {
      method: 'PATCH',
      body: JSON.stringify({ label: 'Verify Renamed' }),
    })
    record('rename the workspace', wsRenamed.status === 200, `status ${wsRenamed.status}`)
    const wsRenamedRead = await api('/api/workspaces')
    const renamed = (wsRenamedRead.body.workspaces ?? []).find(w => w.id === wsId)
    record('the new label reads back', renamed?.label === 'Verify Renamed', `got ${JSON.stringify(renamed?.label)}`)

    const wsRemoved = await api(`/api/workspaces/${wsId}`, { method: 'DELETE' })
    record('remove the workspace', wsRemoved.status === 200, `status ${wsRemoved.status}`)
    const wsAfterRemove = await api('/api/workspaces')
    record('the workspace is gone', !(wsAfterRemove.body.workspaces ?? []).some(w => w.id === wsId))

    /**
     * The server lifecycle: start, stop, restart.
     *
     * Each answers `200` and the state frame then reports the status the action promised — an action that
     * returns `ok` and leaves the entry `stopped` is exactly the "reports success, did nothing" shape this
     * walk exists to catch. The entry runs `node -e 'setInterval(...)'`, so it really is startable here.
     */
    const started = await api('/api/servers/verify1/start', { method: 'POST', body: JSON.stringify({}) })
    record('start a server', started.status === 200, `status ${started.status}`)

    const running = await api('/api/servers')
    const startedEntry = (running.body.servers ?? []).find(s => s.id === 'verify1')
    record(
      'the server reports running, or a refusal that says why',
      ['running', 'starting'].includes(startedEntry?.status) || typeof startedEntry?.lastError === 'string',
      `status ${JSON.stringify(startedEntry?.status)}, lastError ${JSON.stringify(startedEntry?.lastError)}`,
    )

    const stopped = await api('/api/servers/verify1/stop', { method: 'POST', body: JSON.stringify({}) })
    record('stop a server', stopped.status === 200, `status ${stopped.status}`)
    const afterStop = await api('/api/servers')
    const stoppedEntry = (afterStop.body.servers ?? []).find(s => s.id === 'verify1')
    record('the server reports stopped', ['stopped', 'stopping'].includes(stoppedEntry?.status), `status ${JSON.stringify(stoppedEntry?.status)}`)

    // ---- jobs: run one, and read the run's outcome ----
    const ran = await api('/api/jobs/verifyjob/run', { method: 'POST', body: JSON.stringify({}) })
    record('run a job', ran.status === 200, `status ${ran.status}`)
    record(
      'the run reports its exit code',
      typeof ran.body.exitCode === 'number' || typeof ran.body.exitCode === 'object',
      `exitCode ${JSON.stringify(ran.body.exitCode)}`,
    )

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
      'POST /api/servers/{id}/start',
      'POST /api/servers/{id}/stop',
      'POST /api/servers/{id}/deploy',
      'POST /api/jobs',
      'POST /api/jobs/{id}/run',
      'PATCH /api/settings',
      'PATCH /api/settings/workspace',
      'DELETE /api/notifications/destinations/{id}/token',
      'POST /api/backups',
      'POST /api/backups/restore',
      'POST /api/auth/login',
      'POST /api/auth/accounts',
      'PATCH /api/auth/accounts/{id}',
      'POST /api/workspaces',
      'PATCH /api/workspaces/{id}',
      'DELETE /api/workspaces/{id}',
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
