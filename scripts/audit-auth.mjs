/**
 * Two questions about the auth guard, asked of the running panel rather than of `src/app.ts`.
 *
 * **1. Does every write route refuse an anonymous caller?** The middleware order says the guard is
 * mounted on `/api/*` before any route, but an order is a claim about the source. A route mounted
 * outside the guarded prefix, or a handler added before the guard, would show up here and nowhere else.
 *
 * **2. Does a valid session reach them?** The pair is the point. The first pass proves nothing is open;
 * this one proves the refusals were the guard refusing rather than the routes being broken. A route
 * that `401`s to *everyone* passes the first and fails the second.
 *
 * The session pass skips `POST /api/auth/logout`. Not a concession — walking every route with one cookie
 * means walking the route that **ends** that cookie, and a probe that logs itself out reports every later
 * route as a refusal and blames the panel. That is how this script's first version produced "58 of 60
 * write routes refuse a valid session" against a panel that was correct throughout.
 *
 * `/_hh` is excluded from both passes: it is the CLI's local channel and takes `run.json`'s token plus a
 * loopback peer, so a session cookie is the wrong credential to offer it and its refusal would be right.
 *
 * **It is a walk of a live panel, so it has to be run against one:**
 *
 *     HHOSTED_HOME=/tmp/hh-audit node dist/cli.js up --foreground --port 6982 &
 *     HHOSTED_HOME=/tmp/hh-audit HHOSTED_SECRET=audit-secret-123456 node dist/cli.js account create audit --scope read,lifecycle,config,proxy,admin
 *     pnpm run audit:auth
 *
 * Every route the session pass would otherwise trip over is listed in `SESSION_SKIP` with its reason.
 */
import process from 'node:process'

const PORT = Number(process.env.AUDIT_PORT ?? 6982)
const BASE = `http://127.0.0.1:${PORT}`
const ID = process.env.AUDIT_ID ?? 'audit'
const SECRET = process.env.AUDIT_SECRET ?? 'audit-secret-123456'
/** A throwaway account the account routes act on, so the walk cannot delete its own subject. */
const SUBJECT = 'audit-subject'

/** Routes that answer a write method for a reason other than a credential. */
const ANONYMOUS_EXEMPT = new Map([
  ['POST /api/auth/login', 'you must be able to sign in before you have a session'],
  ['POST /api/auth/logout', 'signing out when signed out is a no-op'],
])

const spec = await (await fetch(`${BASE}/openapi/spec.json`)).json()
const writes = []
for (const [route, methods] of Object.entries(spec.paths ?? {})) {
  for (const method of Object.keys(methods)) {
    if (['post', 'patch', 'put', 'delete'].includes(method))
      writes.push(`${method.toUpperCase()} ${route}`)
  }
}
writes.sort()

/**
 * Routes the session pass does not call, each for a reason that is not "it looked hard".
 *
 * `POST /api/proxy/engine` **downloads and installs an engine binary**; with a valid session it does the
 * work, so the probe would spend its whole budget in a download and tell us nothing about the guard —
 * the anonymous pass above already proves the route is behind it.
 *
 * `DELETE /api/auth/password` **turns the guard off**, which ends every session by design. Alphabetically
 * it comes before the account routes, so a walk that calls it leaves itself anonymous and every later
 * route answers `401` — a fourth instance of one mistake in this file: **the walk destroying the state it
 * is about to assert on.** The other three were `logout`, the account `DELETE`/`PATCH` ordering, and
 * sending `Set-Cookie` whole.
 */
const SESSION_SKIP = new Map([
  ['POST /api/proxy/engine', 'installs an engine binary; the anonymous pass already proves it is guarded'],
  ['DELETE /api/auth/password', 'turns the guard off, which ends every session by design'],
])

function call(method, route, headers, body) {
  return fetch(`${BASE}${route.replace(/\{[^}]+\}/g, 'probe')}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'DELETE' ? undefined : body ?? '{}',
    signal: AbortSignal.timeout(15_000),
  })
}

let failures = 0
function fail(message) {
  failures += 1
  console.log(`FAIL  ${message}`)
}

// ---- pass 1: anonymous ----
for (const route of writes) {
  const [method, path] = route.split(' ')
  let status
  try {
    status = (await call(method, path, {}, '{}')).status
  }
  catch (error) {
    fail(`${route} could not be called — ${error.message}`)
    continue
  }
  const exempt = ANONYMOUS_EXEMPT.get(route)
  if (exempt !== undefined) {
    // The exemption is only honest if the route really does answer: a 401 there would mean sign-in is
    // unreachable, which is a worse defect than an open route.
    if (status === 401 || status === 403)
      fail(`${route} refused an anonymous caller, but ${exempt}`)
    continue
  }
  if (status !== 401 && status !== 403)
    fail(`${route} answered ${status} with no credential — expected 401/403`)
}
console.log(`anonymous: ${writes.length} write routes probed, ${failures === 0 ? 'all refused' : `${failures} failure(s)`}`)

// ---- pass 2: a valid session ----
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: ID, secret: SECRET }),
})
// `Set-Cookie`'s value begins with the cookie and continues with attributes; a browser sends only the
// first segment, and `fetch` keeps no jar, so the probe has to cut it.
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
if (!cookie.includes('=')) {
  fail(`sign-in answered ${login.status} with no session cookie`)
}
else {
  const before = failures
  let reached = 0
  const unreachable = []
  // The subject the `:id` account routes act on. It has to exist for a `PATCH`/`DELETE` to answer
  // anything other than 404, and it must not be the account whose session is being used.
  const made = await call('POST', '/api/auth/accounts', { cookie }, JSON.stringify({ id: SUBJECT, label: 'Audit subject', scopes: ['read'] }))
  if (made.status !== 200 && made.status !== 201)
    fail(`could not create the audit subject — status ${made.status}`)

  /**
   * The two account routes that **change the subject** are checked separately, in a safe order.
   *
   * Alphabetically `DELETE /api/auth/accounts/{id}` comes before `PATCH`, so a walk that offers both the
   * same id deletes the record the patch then looks for — and the patch answers `401`, which reads as a
   * guard defect. It is not: the panel refuses to revoke the *caller's* account (`CANNOT_REVOKE_SELF`), so
   * the session survives and only the fixture does not.
   */
  const orderSensitive = new Set([
    'PATCH /api/auth/accounts/{id}',
    'DELETE /api/auth/accounts/{id}',
  ])

  for (const routeOf of writes) {
    const [method, original] = routeOf.split(' ')
    // Skip the local channel (wrong credential) and the route that would end this session.
    if (!original.startsWith('/api/') || routeOf === 'POST /api/auth/logout')
      continue
    if (orderSensitive.has(routeOf) || SESSION_SKIP.has(routeOf))
      continue
    const path = original.replace(/\{[^}]+\}/g, 'probe')
    let status
    try {
      status = (await call(method, path, { cookie }, '{}')).status
    }
    catch (error) {
      unreachable.push(`${method} ${original} could not be called — ${error.message}`)
      continue
    }
    if (status === 401 || status === 403)
      unreachable.push(`${method} ${original} -> ${status}`)
    else
      reached += 1
  }
  /**
   * The order-sensitive pair, checked in the order that does not destroy the subject: patch first,
   * then delete. Both must reach the route (not 401/403); the patch must then succeed and the delete
   * must succeed, which together prove the guard let the session through and the handler did its work.
   */
  for (const [method, expected] of [['PATCH', [200]], ['DELETE', [200]]]) {
    const path = `/api/auth/accounts/${SUBJECT}`
    let status
    try {
      status = (await call(method, path, { cookie }, JSON.stringify({ label: 'Audit subject 2' }))).status
    }
    catch (error) {
      unreachable.push(`${method} ${path} could not be called — ${error.message}`)
      continue
    }
    if (!expected.includes(status))
      unreachable.push(`${method} ${path} -> ${status}`)
    else
      reached += 1
  }

  if (unreachable.length) {
    fail(`${unreachable.length} route(s) refused a valid session`)
    for (const u of unreachable) console.log(`        ${u}`)
  }
  console.log(`session: ${reached} route(s) reached with a valid session`)
  if (reached === 0)
    fail('no /api write route accepted a valid session — the session pass proves nothing')
  else if (failures === before)
    console.log('session: no /api write route refused a valid session')
}

console.log(failures === 0 ? '\nOK — the write surface is guarded, and a session reaches it' : `\n${failures} failure(s)`)
if (failures)
  process.exitCode = 1
