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
 * It walks **both UIs**, because both ship: `stock` inside the package and `noc-console` as a release
 * asset, with different route tables (`/default/servers` versus `/w/:workspaceId/servers`). Which one
 * to walk is read from the panel's own `ui.json` — a panel serving the console cannot be checked
 * against stock's routes, and the first version of this script only ever walked stock's.
 *
 * To check the console: `home-hosted ui-switch --file uis/dist/home-hosted-ui-noc-console.zip` against
 * the instance first (`node scripts/build-uis.mjs noc-console --zip` makes the zip).
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
 *  - no control is painted over by a **background layer**, found by comparing pixels.
 *
 * The last one exists because `elementFromPoint` ignores backgrounds: a CSS `linear-gradient` painted
 * over a button is invisible to a hit-test, which is how `.scroll-hint-x` hid the Jobs table's
 * `disable`/`remove` while every other check passed. So each control that hit-tests to itself is also
 * measured against the same spot with the controls hidden — a control that is really drawn makes its
 * pixels change when removed, and one that is painted over cannot. Verified by putting a full-opacity
 * cover over a toggle switch with `pointer-events: none`: the hit-test still reached the button, and
 * only this comparison saw the cover.
 *
 * What is deliberately *not* checked: a control the hit-test already names something else for. That
 * is normal scroll-under (the page header, the sticky Save row) and this comparison can only agree
 * with it — an early version reported exactly that as a defect.
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
import pngjs from 'pngjs'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const explicitUrl = process.env.HHOSTED_SMOKE_URL ?? null
const PORT = Number(process.env.HHOSTED_SMOKE_PORT ?? 6979)

/**
 * The signed-in routes every release must be able to draw, **per UI**.
 *
 * Both UIs ship — `stock` inside the package, `noc-console` as a release asset — and they do not share
 * a route table: stock is `/default/servers`, the console is `/w/:workspaceId/servers` and `/proxy`.
 * Walking only stock's routes left the asset every release uploads with no browser check at all, which
 * is the wrong half to leave out: it is the one a person installs deliberately.
 */
const UIS = {
  'stock': [
    ['/global/overview', 'Global overview'],
    ['/global/settings', 'Global settings'],
    ['/default/overview', 'Workspace overview'],
    ['/default/servers', 'Servers'],
    ['/default/jobs', 'Jobs'],
    ['/default/logs', 'Logs'],
    ['/default/settings', 'Workspace settings'],
    ['/global/proxy', 'Reverse proxy'],
  ],
  'noc-console': [
    ['/global/overview', 'Global overview'],
    ['/global/settings', 'Global settings'],
    ['/w/default/servers', 'Servers'],
    ['/w/default/jobs', 'Jobs'],
    ['/w/default/logs', 'Logs'],
    ['/w/default/settings', 'Workspace settings'],
    ['/proxy', 'Reverse proxy'],
  ],
}

/**
 * Which UI the panel under test is serving, from its own `ui.json`.
 *
 * Asked of the panel rather than assumed: `HHOSTED_SMOKE_URL` may point at an instance with either one
 * installed, and walking stock's routes against the console reports eight 404s that are not defects.
 */
async function servedUi(page, base) {
  const status = await page.request.get(`${base}/api/settings`)
  if (!status.ok()) {
    // Not a silent fallback: a `/api/settings` that will not answer means the routes below may be
    // walking the wrong table, which is a false pass rather than a finding.
    fail('ui', `GET /api/settings answered ${status.status()}, so the served UI is unknown`)
    return 'stock'
  }
  const body = await status.json().catch(() => null)
  const name = body?.ui?.meta?.name
  if (typeof name === 'string' && name in UIS)
    return name
  /**
   * A third UI (a hand-written `ui.json`) is legitimate, and this script has no route table for it.
   * Walking stock's table against an unknown UI would report findings that are not defects, so the
   * only honest thing is to say the walk is a best guess rather than a check of *that* UI.
   */
  const label = typeof name === 'string' && name.length > 0 ? `"${name}"` : 'an unnamed UI'
  process.stdout.write(`[smoke] ${label} is not one of the UIs this script knows — walking stock's routes as a smoke, not as a check of ${label}\n`)
  return 'stock'
}

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

/**
 * Controls that something is **painted** over, found by comparing pixels.
 *
 * `elementFromPoint` only answers "which element is on top", so a CSS `linear-gradient` covering a
 * button is invisible to it — that is how `.scroll-hint-x` hid the Jobs table's `disable` and
 * `remove` buttons while every other check passed. The paint is what a person sees, so this asks the
 * only question that can catch it: **does hiding the control change what is on screen where it sits?**
 *
 * The method: screenshot the page, hide every control, screenshot again, and compare each control's
 * own box between the two. A control that is actually drawn makes its pixels *differ* when removed.
 * A control that is completely painted over leaves the same pixels, because what was visible was
 * never the control.
 *
 * Two things make this cheap enough to run per route: the whole page is measured in one pair of
 * screenshots (not one per control), and `page.screenshot({ clip })` crops each control rather than
 * capturing the viewport again.
 *
 * A control that is *partly* painted over — the real defect — still differs, just by fewer pixels, so
 * the threshold is "at least one pixel changed" rather than a proportion. A false positive would be a
 * control whose own paint is identical to what is behind it, which cannot happen for anything with a
 * border, a background or a label.
 */
async function paintedOverControls(page) {
  const boxes = await page.evaluate(() => {
    /** Stable identity for one control across two screenshots. */
    const found = []
    for (const [index, control] of [...document.querySelectorAll('button, a[href], input, select, textarea')].entries()) {
      const box = control.getBoundingClientRect()
      if (box.width === 0 || box.height === 0)
        continue
      const cs = getComputedStyle(control)
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0)
        continue
      // Only what is fully on screen: a control at the edge is cropped, and a crop makes the
      // comparison meaningless rather than wrong.
      if (box.left < 0 || box.top < 0 || box.right > window.innerWidth || box.bottom > window.innerHeight)
        continue
      /**
       * Skip a control the page has scrolled under a sticky or fixed bar.
       *
       * That is the layout working, not a defect, and this comparison cannot tell it apart from one:
       * hiding every control leaves the bar's own paint untouched, so the crop reads "nothing
       * changed" for a control that is legitimately behind the header. Measured on Global settings
       * after `inspectPage` had scrolled `main` to 1875: a real button sat at y=20 with the `<h1>`
       * band painted over it, and this reported it as a cover.
       *
       * The hit-test in `inspectPage` already handles the same case by re-asking after a scroll, so
       * this check defers to it rather than repeating the mistake in a second way.
       */
      /**
       * Only a control that hit-tests to **itself** is worth a pixel comparison.
       *
       * `elementFromPoint` answers "which element is on top", so if it already names something else
       * the control is legitimately scrolled under that thing — the page header, the sticky Save row —
       * and this comparison can only agree. Testing the pixels of a control that is *known* to be
       * covered adds nothing and reports normal scroll-under as a defect: measured on Global settings,
       * where `inspectPage`'s own `scrollIntoView` left a 32×18 switch at y=20 with the `<h1>` painted
       * over it, and the pixel check called that a cover.
       *
       * So this runs on the narrow set the hit-test has already cleared: what remains is a control
       * that hit-tests to *itself* yet whose pixels do not change when it is hidden — which only a
       * background-layer paint (a `linear-gradient`, a `::before`) can produce, since that has no
       * element of its own to be hit-tested.
       */
      const onTop = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      if (onTop !== control && !control.contains(onTop))
        continue
      found.push({
        index,
        // A pixel or two in from the edge, so a neighbouring control's border is not in the crop.
        x: Math.round(box.left) + 1,
        y: Math.round(box.top) + 1,
        width: Math.max(1, Math.round(box.width) - 2),
        height: Math.max(1, Math.round(box.height) - 2),
        label: `${control.tagName.toLowerCase()}${(control.textContent ?? '').trim().length === 0 ? (control.getAttribute('aria-label') === null ? '(no accessible name)' : `"${control.getAttribute('aria-label')}"`) : `"${(control.textContent ?? '').trim().slice(0, 24)}"`} [${Math.round(box.left)},${Math.round(box.top)}]`,
        // Marked rather than removed: removing one can reflow the ones after it.
        style: cs.cssText,
      })
    }
    return found
  })

  if (boxes.length === 0)
    return []

  const shoot = async () => pngjs.PNG.sync.read(await page.screenshot())

  const visible = await shoot()
  // `visibility: hidden` keeps the box, so nothing moves and the crops still line up.
  await page.evaluate(() => {
    for (const control of document.querySelectorAll('button, a[href], input, select, textarea'))
      control.style.setProperty('visibility', 'hidden', 'important')
  })
  const hidden = await shoot()
  await page.evaluate(() => {
    for (const control of document.querySelectorAll('button, a[href], input, select, textarea'))
      control.style.removeProperty('visibility')
  })

  /** Mean per-channel difference inside one crop of two same-size images. */
  const changed = (box) => {
    let differing = 0
    for (let y = box.y; y < box.y + box.height; y += 1) {
      for (let x = box.x; x < box.x + box.width; x += 1) {
        const at = (y * visible.width + x) * 4
        if (visible.data[at] !== hidden.data[at]
          || visible.data[at + 1] !== hidden.data[at + 1]
          || visible.data[at + 2] !== hidden.data[at + 2]) {
          differing += 1
        }
      }
    }
    return differing
  }

  return boxes
    .map(box => ({ box, differing: changed(box) }))
    .filter(entry => entry.differing === 0)
    .map(entry => `${entry.box.label} is painted over at ${entry.box.x},${entry.box.y} (no pixel changed when it was hidden)`)
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

    const ui = await servedUi(page, base)
    const routes = UIS[ui]
    process.stdout.write(`[smoke] walking ${routes.length} ${ui} routes\n`)

    for (const [route, label] of routes) {
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
        fail(`${ui} ${route}`, problem)
      // The half `inspectPage` cannot do: a control painted over by a CSS background is still in the
      // DOM, still hit-tests to itself if the paint has no box, and only a pixel comparison sees it.
      for (const problem of await paintedOverControls(page))
        fail(`${ui} ${route}`, problem)
      for (const entry of noise)
        fail(`${ui} ${route}`, entry)

      process.stdout.write(`[smoke] ${ui} ${route} — ${label}\n`)
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
  process.stdout.write(`\n[smoke] routes clean, spec and healthz answered\n`)
}

await main()
