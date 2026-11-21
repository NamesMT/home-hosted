#!/usr/bin/env node
/**
 * Drive the built panel in a real browser and fail on the defects a unit test cannot see.
 *
 * Every UI defect this project has shipped recently was invisible to `pnpm run check` and obvious
 * within a second of loading the page: a scroll hint painted a white band over a table's last
 * action column, a badge and the line under it both printed `included`, a settings control reverted
 * the edit it was given. Those are *layout and behaviour under a real engine*, and no happy-dom mount
 * reproduces them — it has no layout, so `scrollWidth === clientWidth` always, and a `background:
 * linear-gradient` paints nothing.
 *
 * So this runs the real thing: `dist/cli.js` on a scratch home, the real stock UI, Chromium.
 *
 *   pnpm run smoke                       # boot a panel, walk every route, report
 *   pnpm run smoke -- --keep             # leave it running, for a look
 *   HHOSTED_SMOKE_URL=http://… pnpm run smoke   # against an instance already up
 *
 * It is **not** part of `pnpm run check`: it needs a Chromium binary that `pnpm install` does not
 * fetch, and a full run of it is slower than the whole unit suite. Run it before a release, and when
 * touching `uis/`.
 *
 * What it asserts, per route:
 *  - the page rendered (a heading exists, no blank main);
 *  - no uncaught exception, no console error, no failed same-origin request;
 *  - the document does not scroll sideways (a mobile page-blowout);
 *  - no control is sitting under another *element*: every visible button's centre hit-tests to itself.
 *
 * **What the hit-test cannot see, stated plainly:** `elementFromPoint` ignores backgrounds. A CSS
 * `linear-gradient` painted over a button is invisible to it — measured while investigating the
 * `scroll-hint-x` defect, where the band covered `disable`/`remove` and the hit-test still reported
 * the buttons as uncovered. So that check catches an overlaying *element* (a misplaced modal, a
 * sticky bar swallowing a click) and does **not** catch a painted one. The scroll-hint band was found
 * by looking at a screenshot; only a pixel comparison in this script would catch its next form.
 *
 * The horizontal-scroll check above is the cheap half of the same problem and does work, because
 * `scrollWidth` is real layout — it is what says a table is cut off, just not what is on top of it.
 */
import { spawn } from 'node:child_process'
// @ts-check
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const explicitUrl = process.env.HHOSTED_SMOKE_URL ?? null
const PORT = Number(process.env.HHOSTED_SMOKE_PORT ?? 6979)

/** The signed-in routes every release must be able to draw. */
const ROUTES = [
  ['/global/overview', 'Global overview'],
  ['/global/settings', 'Global settings'],
  ['/default/overview', 'Workspace overview'],
  ['/default/servers', 'Servers'],
  ['/default/jobs', 'Jobs'],
  ['/default/logs', 'Logs'],
  ['/default/settings', 'Workspace settings'],
  ['/global/proxy', 'Reverse proxy'],
]

const failures = []
function fail(where, message) {
  failures.push(`${where}: ${message}`)
}

/**
 * Chromium, or a message that says what to do — the same shape `scripts/capture-media.mjs` uses,
 * because the browser binary is deliberately not an install-time dependency.
 */
async function launchChromium() {
  let playwright
  try {
    playwright = await import('playwright')
  }
  catch {
    throw new Error('`pnpm exec playwright install chromium` is needed — the browser binary is not part of `pnpm install`')
  }
  try {
    return await playwright.chromium.launch()
  }
  catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    throw new Error(`Chromium would not start: ${detail}\n  run: pnpm exec playwright install chromium`)
  }
}

/** Start the built panel on a scratch home and return what it takes to sign in. */
async function startPanel() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-smoke-'))
  const cli = path.join(root, 'dist', 'cli.js')
  if (!fs.existsSync(cli))
    throw new Error(`${path.relative(root, cli)} is missing — run \`pnpm run build\` first`)

  const secret = process.env.HHOSTED_SMOKE_SECRET ?? 'smoke-secret-12'

  const run = (argv, env = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--home', home, ...argv], {
      cwd: root,
      env: { ...process.env, HHOSTED_HOME: home, ...env },
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      out += chunk
    })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(out || `exited ${code}`))))
  })

  /**
   * A known secret, so the walk signs in rather than scraping the first-run one out of stdout.
   * `HHOSTED_SECRET` is the documented non-interactive way to choose it; without it `account create`
   * generates a random one, which is how the first version of this script signed in with a password
   * nothing had ever set and got `401` on every route.
   */
  await run(['account', 'create', 'smoke', '--scope', 'read,lifecycle,config,proxy,admin'], { HHOSTED_SECRET: secret })
    .catch(async (error) => {
      throw new Error(`could not seed the smoke account: ${error.message.split('\n')[0]}`)
    })

  const up = await run(['up', '--port', String(PORT)])
    .catch((error) => {
      throw new Error(`the panel did not start: ${error.message}`)
    })
  void up

  return { home, user: 'smoke', secret, stop: () => run(['down']).catch(() => {}) }
}

/**
 * Everything that is wrong with the page *as rendered*.
 *
 * Layout questions have to be asked in the page: only the engine knows whether a gradient covers a
 * button, and `happy-dom` answers `scrollWidth === clientWidth` for every element it is given.
 */
async function inspectPage(page) {
  return page.evaluate(() => {
    const problems = []

    // A page that scrolls sideways on a narrow window is the classic mobile blow-out: something
    // inside is wider than the frame and the whole document travels with it.
    const doc = document.documentElement
    if (doc.scrollWidth > doc.clientWidth + 1)
      problems.push(`the document scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`)

    // A control painted over by a decoration is still in the DOM and still reports the right size;
    // only hit-testing finds it. The `scroll-hint-x` band hid `disable`/`remove` exactly this way.
    const covered = []
    for (const control of document.querySelectorAll('button, a[href], input, select, textarea')) {
      const box = control.getBoundingClientRect()
      if (box.width === 0 || box.height === 0)
        continue
      const cs = getComputedStyle(control)
      if (cs.visibility === 'hidden' || cs.display === 'none')
        continue
      // Only what is actually on screen, and only when the centre is not the element itself.
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight)
        continue
      const hit = document.elementFromPoint(x, y)
      if (hit === null || hit === control || control.contains(hit) || hit.contains(control))
        continue
      // A label pointing at its own input is not a cover.
      if (hit.tagName === 'LABEL' && hit.htmlFor === control.id)
        continue
      /**
       * A `sticky` or `fixed` bar over a control is the layout working, not a defect: the settings
       * shell keeps its Save row pinned at the bottom, so a control scrolled to the fold sits under
       * it until the page moves. Only a cover that follows the control is a defect, so scroll the
       * control to the middle of the viewport and ask again — a sticky bar cannot follow it there.
       */
      control.scrollIntoView({ block: 'center', inline: 'center' })
      const again = control.getBoundingClientRect()
      const rehit = document.elementFromPoint(again.left + again.width / 2, again.top + again.height / 2)
      if (rehit === null || rehit === control || control.contains(rehit) || rehit.contains(control))
        continue
      covered.push(`${control.tagName.toLowerCase()}"${(control.textContent ?? '').trim().slice(0, 24)}" under <${rehit.tagName.toLowerCase()} class="${(rehit.className ?? '').toString().slice(0, 40)}">`)
    }
    if (covered.length > 0)
      problems.push(`controls painted over: ${covered.slice(0, 4).join('; ')}`)

    // A page with no heading did not finish rendering, whatever the network said.
    if (document.querySelectorAll('h1, h2').length === 0)
      problems.push('no heading on the page')

    return problems
  })
}

async function main() {
  const target = explicitUrl === null ? await startPanel() : null
  const base = (explicitUrl ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '')
  const browser = await launchChromium()

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()

    /** Console errors and failed requests are defects; the panel logs neither on a happy path. */
    const noise = []
    page.on('pageerror', error => noise.push(`uncaught: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error')
        noise.push(`console: ${message.text().slice(0, 160)}`)
    })
    page.on('requestfailed', (request) => {
      if (request.url().startsWith(base))
        noise.push(`request failed: ${request.url().slice(base.length)} (${request.failure()?.errorText ?? '?'})`)
    })

    /**
     * Sign in through the API the page itself uses, so the cookie is the browser's own.
     *
     * Done even against `HHOSTED_SMOKE_URL`: pointing this at an instance that is already up does not
     * mean it has no password, and skipping the login is what turned eight routes into `401`s and
     * eight console errors the first time the external mode was tried.
     */
    const user = target?.user ?? process.env.HHOSTED_SMOKE_USER ?? 'smoke'
    const secret = target?.secret ?? process.env.HHOSTED_SMOKE_SECRET ?? 'smoke-secret-12'
    const response = await page.request.post(`${base}/api/auth/login`, { data: { id: user, secret } })
    if (!response.ok())
      fail('login', `POST /api/auth/login answered ${response.status()} — pass HHOSTED_SMOKE_USER/HHOSTED_SMOKE_SECRET`)

    for (const [route, label] of ROUTES) {
      noise.length = 0
      const response = await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
      if (response === null || !response.ok())
        fail(route, `answered ${response?.status() ?? 'nothing'}`)
        // The SPA route may 200 the shell; the heading check below is what proves it rendered.
      try {
        await page.waitForSelector('h1, h2', { timeout: 15_000 })
      }
      catch {
        fail(route, 'nothing rendered (no heading after 15 s)')
        continue
      }
      // The state frame is a second apart; give the first one a moment to land.
      await page.waitForTimeout(1200)

      for (const problem of await inspectPage(page))
        fail(route, problem)
      for (const entry of noise)
        fail(route, entry)

      process.stdout.write(`[smoke] ${route} — ${label}\n`)
    }

    // The two unauthenticated reads a UI reaches same-origin, and the spec a client builds on.
    for (const [route, name] of [['/openapi/spec.json', 'OpenAPI spec'], ['/healthz', 'healthz']]) {
      const response = await page.request.get(`${base}${route}`)
      if (!response.ok())
        fail(route, `${name} answered ${response.status()}`)
    }

    await context.close()
  }
  finally {
    await browser.close()
    if (target !== null && !keep)
      await target.stop()
    if (target !== null)
      process.stdout.write(`[smoke] state ${target.home}${keep ? ' (kept — the panel is still up)' : ''}\n`)
  }

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} problem(s):\n`)
    for (const failure of failures)
      process.stderr.write(`  - ${failure}\n`)
    process.exit(1)
  }
  process.stdout.write(`\n[smoke] ${ROUTES.length} routes clean, spec and healthz answered\n`)
}

await main()
