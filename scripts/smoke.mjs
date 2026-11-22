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
 * Every route is walked **twice**: at 1280x800 and at 390x844. The layout checks are the ones that
 * differ by width, and the sideways-scroll check exists for a mobile blow-out that never happens at
 * desktop width — running only the wide pass meant it had never been exercised at a phone width.
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
import http from 'node:http'
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
  /**
   * Every path here must be one the router actually declares — `uis/stock/src/router.ts`.
   *
   * **Six of these eight used to be wrong**, and the suite reported "routes clean" while testing one
   * page six times. `/default/overview`, `/default/servers`, `/default/jobs`, `/default/logs`,
   * `/default/settings` and `/global/proxy` are not routes: the catch-all matches them, the guard
   * rewrites to `/global/overview`, and every one of them rendered **Global Overview** — measured, all
   * six landed on `/global/overview` with `h1="Global Overview"`. The workspace pages live under `/w/`,
   * exactly as noc-console's entries below already said.
   */
  'stock': [
    ['/global/overview', 'Global Overview'],
    ['/global/settings', 'Global settings'],
    // `workspacePath(id, 'overview')` is `/w/<id>` — the overview has no suffix of its own.
    ['/w/default', 'Overview'],
    ['/w/default/servers', 'Servers'],
    ['/w/default/jobs', 'Jobs'],
    ['/w/default/logs', 'Logs'],
    ['/w/default/settings', 'Workspace settings'],
    ['/proxy', 'Reverse Proxy'],
  ],
  'noc-console': [
    ['/global/overview', 'Global Overview'],
    ['/global/settings', 'Global settings'],
    ['/w/default/servers', 'Servers'],
    ['/w/default/jobs', 'Jobs'],
    ['/w/default/logs', 'Logs'],
    ['/w/default/settings', 'Workspace settings'],
    ['/proxy', 'Reverse Proxy'],
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
  const ui = body?.ui
  /**
   * `custom: false` **is** the stock UI — the panel reports `meta: null` for it, because there is no
   * `ui.json` to read: stock ships inside the package. Trusting `meta.name` alone therefore labelled a
   * stock panel "an unnamed UI" and warned about a UI it did not recognise, which is the exact
   * opposite of what a fresh panel is.
   */
  if (ui?.custom !== true)
    return 'stock'
  const name = ui?.meta?.name
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
/**
 * A placeholder that does not fit its own input is a hint nobody can finish reading.
 *
 * Measured rather than read: the palette's input is `94vw` minus a search icon — 266 px at a 390 px
 * viewport — and `palette.placeholder` was "Jump to a server, run an action, open a setting…", which
 * needs 277 px in English and 384 px in Russian. **Every** language was cut mid-word, and that is why it
 * survived: a hint you cannot finish looks like a hint that is merely long.
 *
 * `canvas.measureText` at the input's own computed font is the only way to answer this without a
 * screenshot diff — a `placeholder` is not `overflow: hidden`, so no scroll-width comparison sees it.
 *
 * Separate from `inspectPage` because it is also the only check worth running with a modal open, and
 * `inspectPage`'s others read an open dialog's backdrop as a cover.
 */
async function placeholderOverflow(page) {
  return page.evaluate(() => {
    const overflowing = []
    for (const input of document.querySelectorAll('input[placeholder]')) {
      const cs = getComputedStyle(input)
      if (cs.visibility === 'hidden' || cs.display === 'none' || input.clientWidth === 0)
        continue
      const context = document.createElement('canvas').getContext('2d')
      if (context === null)
        continue
      context.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const needed = context.measureText(input.placeholder).width
      // A little slack: sub-pixel rounding differs per platform and a 1 px miss is not a defect.
      if (needed > input.clientWidth + 2)
        overflowing.push(`"${input.placeholder.slice(0, 40)}" needs ${Math.round(needed)}px in ${input.clientWidth}px`)
    }
    return overflowing.map(entry => `placeholder does not fit its input: ${entry}`)
  })
}

/**
 * Every control a person can reach must have an accessible name.
 *
 * `test/shared/ui-accessible-name.test.ts` checks this over the **source**, which catches a bare
 * `<button><Icon /></button>` before it ships. It cannot see what a *rendered* control is called: a
 * component that forwards no slot text, a label pointing at an id that is not on the page, an
 * `aria-label` bound to an empty string. Only the browser resolves that.
 *
 * This asks the same question the browser's accessibility tree would, using the sources a name can
 * come from — `aria-label`, `aria-labelledby`, its own text, `title`, a wrapping `<label>`, and a
 * `label[for]` — and skips what is not on screen.
 */
async function namelessControls(page) {
  return page.evaluate(() => {
    const nameless = []
    for (const element of document.querySelectorAll('button, a[href], input, select, textarea')) {
      if (element.closest('[aria-hidden="true"]'))
        continue
      const style = getComputedStyle(element)
      if (style.visibility === 'hidden' || style.display === 'none' || element.getClientRects().length === 0)
        continue
      // A disabled control is still announced, so it is still checked.
      const byId = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim()
      const name = [
        (element.getAttribute('aria-label') ?? '').trim(),
        byId,
        (element.textContent ?? '').trim(),
        (element.getAttribute('title') ?? '').trim(),
        (element.closest('label')?.textContent ?? '').trim(),
        element.id ? (document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent ?? '').trim() : '',
      ].find(candidate => candidate.length > 0)
      if (name === undefined) {
        const tag = element.tagName.toLowerCase()
        const hint = element.className ? `.${String(element.className).split(' ')[0]}` : ''
        nameless.push(`${tag}${hint} has no accessible name, so a screen reader announces only "${tag}"`)
      }
    }
    return nameless
  })
}

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

/**
 * Create, act on and remove a throwaway server, asserting every step answers.
 *
 * Kept to the endpoints that take **no request body**, because those are the ones a body-size guard is
 * most likely to break and the ones nothing tested: a middleware that mis-reads the request turns them
 * into `500`s while every `POST` with a body keeps working, which is exactly how the regression looked.
 */
/**
 * A `POST` with no body and no `content-length`, exactly as a browser `fetch` or `curl -X POST` sends it.
 *
 * `node:http` is the point: `page.request.post(url)` adds `content-length: 0`, which a body-size guard
 * can answer from the header alone. The request this suite has to reproduce is the one without it.
 */
function bodilessPost(base, cookie, pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base)
    const request = http.request({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'POST', headers: { cookie } }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 0))
    })
    request.on('error', reject)
    request.end()
  })
}

async function exerciseLifecycle(page, base, cookie) {
  const workspace = 'smoke-probe'
  const created = await page.request.post(`${base}/api/workspaces`, { data: { id: workspace, label: 'Smoke probe' } })
  // An instance that already has this workspace is not a defect; clean it up and carry on.
  if (!created.ok() && created.status() !== 409)
    fail('lifecycle', `POST /api/workspaces answered ${created.status()}`)

  try {
    const entry = await page.request.post(`${base}/api/servers?workspace=${workspace}`, {
      data: { id: 'probe', command: process.execPath, args: ['-e', '0'], bind: 'local' },
    })
    if (!entry.ok()) {
      fail('lifecycle', `declaring a server answered ${entry.status()}`)
      return
    }

    /**
     * The two bodiless POSTs a person uses most: this is what the body-limit guard broke.
     *
     * **Sent through `node:http`, not `page.request`.** Playwright's request client sets
     * `content-length: 0` on a bodyless POST, which is a *different request* from the one a browser
     * `fetch` or `curl -X POST` sends — and it takes a different path through a body-size guard. Verified
     * both ways against a panel with the broken guard: `page.request` answered `200` while the same call
     * through the real client answered `500`. A check that cannot fail is not a check.
     */
    for (const action of ['start', 'stop']) {
      const status = await bodilessPost(base, cookie, `/api/servers/probe/${action}?workspace=${workspace}`)
      if (status >= 300)
        fail('lifecycle', `POST /api/servers/probe/${action} answered ${status} — a bodiless POST must not fail`)
    }
    process.stdout.write(`[smoke] lifecycle: start and stop answered\n`)
  }
  finally {
    await page.request.delete(`${base}/api/workspaces/${workspace}`)
  }
}

async function main() {
  const target = explicitUrl === null ? await startPanel() : null
  const base = (explicitUrl ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '')
  const browser = await launchChromium()

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    // Reassignable: the mobile pass rebinds it so `walk` and the noise listeners follow the new tab.
    let page = await context.newPage()

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

    // The cookie the login set, for the one check that speaks HTTP directly rather than through
    // Playwright — `bodilessPost` explains why it has to.
    const cookie = (response.headersArray().find(header => header.name.toLowerCase() === 'set-cookie')?.value ?? '').split(';')[0] ?? ''

    /**
     * The write paths, exercised once before the read-only walk.
     *
     * Every check above and below is a `GET`: the suite logged in and then read eight pages. It never
     * sent a `POST`, so it could not have caught the round where a body-limit guard made **every
     * bodiless `POST` answer 500** — `start`, `stop`, `backup create`, the panel's core actions. That
     * defect shipped, was found by driving a panel by hand, and would have been caught here in one
     * second.
     *
     * A scratch workspace, created and removed, so an instance reached through `HHOSTED_SMOKE_URL` is
     * left as it was. Declared here rather than as a `ROUTES` entry because it is a sequence, and the
     * point is the lifecycle, not the page.
     */
    await exerciseLifecycle(page, base, cookie)

    const ui = await servedUi(page, base)
    const routes = UIS[ui]
    process.stdout.write(`[smoke] walking ${routes.length} ${ui} routes\n`)

    /**
     * Walk one route and assert everything that holds at any window size.
     *
     * Extracted because it now runs twice per route, at two widths — the layout checks below are the
     * ones that differ by width, and running the desktop pass alone meant the sideways-scroll check
     * (the mobile blow-out it exists for) had never been exercised at a phone width at all. The
     * `.scroll-hint-x` defect was exactly this shape: invisible at 1280 px, a covered action column at
     * 390 px.
     */
    const walk = async (route, label, width) => {
      const where = `${ui} ${route}${width === null ? '' : ` @${width}`}`
      noise.length = 0
      const response = await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
      if (response === null || !response.ok())
        fail(where, `answered ${response?.status() ?? 'nothing'}`)
        // The SPA route may 200 the shell; the heading check below is what proves it rendered.
      try {
        await page.waitForSelector('h1, h2', { timeout: 15_000 })
      }
      catch {
        fail(where, 'nothing rendered (no heading after 15 s)')
        return
      }
      // The state frame is a second apart; give the first one a moment to land.
      await page.waitForTimeout(1200)

      /**
       * The page must still be at the route that was asked for.
       *
       * A path this UI does not declare does **not** 404: the router's catch-all matches it and the
       * guard rewrites to the panel-wide overview, so a wrong address answers `200` and renders a real
       * page. That is how six of stock's eight entries were wrong for as long as they were — every one
       * landed on `/global/overview` with `h1="Global Overview"`, and "routes clean" was true of a suite
       * that had walked one page six times.
       *
       * **This has to run after the settle, not after `goto`.** Measured: immediately after
       * `domcontentloaded` the URL is still `/default/jobs`, and it is `/global/overview` 1.5 s later —
       * the guard rewrites from a Vue watcher, not from the initial navigation. Read too early, the
       * check passes on exactly the defect it exists for.
       */
      const settled = new URL(page.url()).pathname.replace(/\/$/, '')
      if (settled !== route.replace(/\/$/, ''))
        fail(where, `landed on ${settled || '/'} — this UI does not declare that route, so the catch-all sent it elsewhere`)

      /**
       * And the heading must be the one that route names.
       *
       * The URL check above catches a path the router does not declare. This catches the other shape:
       * two routes that both exist but render each other's page — a copy-pasted route entry, a component
       * wired to the wrong view. The `label` column was documentation until now; each entry's text is
       * the catalog string `TopBar` renders from `meta.titleKey`, so it is the page's real name.
       *
       * Matched loosely (`===` on the trimmed text) because the two UIs label differently — noc-console's
       * own route table carries the same strings its shell renders.
       */
      const heading = await page.evaluate(() => (document.querySelector('h1')?.textContent ?? '').trim())
      if (heading !== label)
        fail(where, `rendered "${heading || '(no heading)'}" but this route is "${label}" — the route exists and shows another page`)

      for (const problem of [...await inspectPage(page), ...await placeholderOverflow(page), ...await namelessControls(page)])
        fail(where, problem)
      // The half `inspectPage` cannot do: a control painted over by a CSS background is still in the
      // DOM, still hit-tests to itself if the paint has no box, and only a pixel comparison sees it.
      for (const problem of await paintedOverControls(page))
        fail(where, problem)

      /**
       * The command palette is a **lazy modal** — nothing renders it until the shortcut — so every check
       * above skips its search input, which is the one fixed-width box in the UI holding a translatable
       * string. Without this the placeholder overflow that shipped was invisible to this script: the
       * first version of the check passed because the input did not exist on the page.
       *
       * Opened only where the UI has one, and closed again so the next route starts clean. A UI without
       * the shortcut (noc-console) simply reports nothing here.
       */
      /**
       * Focus a real trigger **before** opening, so there is somewhere for focus to return to.
       *
       * The order matters and I got it wrong first: focusing a header button *after* the palette was
       * already open captured `<body>` as the element to return to, so the focus check below could
       * never fire. The real sequence is focus-then-open, and the check has to mirror it.
       */
      const trigger = await page.evaluate(() => {
        /**
         * A **visible** header button, not merely the first one.
         *
         * The first is the mobile menu trigger, `lg:hidden`, so at a desktop width it has no box and
         * `focus()` on it does nothing — which made the focus check below report a defect that was my
         * selector's, not the palette's. `getClientRects().length` is the test for "a person could have
         * clicked this".
         */
        const candidate = [...document.querySelectorAll('header button')]
          .find(button => !button.closest('[role="dialog"]') && button.getClientRects().length > 0)
        if (!(candidate instanceof HTMLElement))
          return null
        candidate.focus()
        return ((candidate.textContent ?? '').trim() || (candidate.getAttribute('aria-label') ?? '').trim()).slice(0, 30)
      })
      await page.evaluate(() => {
        // `Mod+K` is what the button itself advertises; dispatch the event rather than a real keypress,
        // so the check does not depend on focus having landed anywhere in particular.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, metaKey: true, bubbles: true }))
      })
      await page.waitForTimeout(600)
      /**
       * Only run the modal checks if a dialog actually opened.
       *
       * This used to return a hard-coded `true`, so the block below ran whether or not the palette had
       * appeared — and on a route where the shortcut did nothing, `Escape` did nothing, focus never
       * moved, and the focus check could not fail. A condition that is always true is not a condition.
       */
      const paletteOpened = await page.evaluate(() => document.querySelector('[role="dialog"]') !== null)
      if (paletteOpened) {
        /**
         * Only the input check runs while a modal is open.
         *
         * `inspectPage`'s other two checks read an open dialog as a defect — its backdrop genuinely does
         * paint over the page behind it, which is what a modal is for. Running the whole function here
         * reported eight "controls painted over" findings that were all the overlay working correctly.
         */
        for (const problem of await placeholderOverflow(page))
          fail(`${where} (palette)`, problem)

        /**
         * Escape must hand focus back to the control that opened the palette.
         *
         * It used to close and leave focus on `<body>`, so a keyboard user lost their place and had to
         * Tab from the top of the page again — invisible to anyone closing it with a mouse, because the
         * pointer goes back where they were looking. Only a real browser observes this: `happy-dom`
         * keeps reka-ui's dialog mounted after close, so a component test cannot see it.
         */
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(300)
        if (trigger !== null) {
          const focusAfterClose = await page.evaluate(() => ({
            tag: document.activeElement?.tagName ?? 'none',
            label: (document.activeElement?.textContent ?? document.activeElement?.getAttribute?.('aria-label') ?? '').trim().slice(0, 30),
            isBody: document.activeElement === document.body,
          }))
          if (focusAfterClose.isBody)
            fail(`${where} (palette)`, `closing the palette dropped focus on <body> instead of returning it to "${trigger}"`)
        }
      }

      for (const entry of noise)
        fail(where, entry)
      process.stdout.write(`[smoke] ${where} — ${label}\n`)
    }

    for (const [route, label] of routes)
      await walk(route, label, null)

    /**
     * The same routes again at a phone width, where the layout is a different program.
     *
     * 390 px is the width `mobile-layout.test.ts` reasons about in both UIs. A second context rather
     * than `setViewportSize` on the existing page, so a media-query-driven re-render cannot leave a
     * half-adjusted DOM for the next route.
     */
    const MOBILE = { width: 390, height: 844 }
    const mobileContext = await browser.newContext({ viewport: MOBILE })
    await mobileContext.addCookies(await context.cookies())
    const mobilePage = await mobileContext.newPage()
    mobilePage.on('pageerror', error => noise.push(`uncaught: ${error.message}`))
    mobilePage.on('console', (message) => {
      if (message.type() === 'error')
        noise.push(`console: ${message.text().slice(0, 160)}`)
    })
    mobilePage.on('requestfailed', (request) => {
      if (request.url().startsWith(base))
        noise.push(`request failed: ${request.url().slice(base.length)} (${request.failure()?.errorText ?? '?'})`)
    })

    // `walk` closes over `page`; rebind it for the mobile pass rather than duplicating the body.
    const desktopPage = page
    page = mobilePage
    try {
      process.stdout.write(`[smoke] the same ${routes.length} routes at ${MOBILE.width}×${MOBILE.height}\n`)
      for (const [route, label] of routes)
        await walk(route, label, MOBILE.width)
    }
    finally {
      page = desktopPage
      await mobileContext.close()
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
