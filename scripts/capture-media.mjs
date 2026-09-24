#!/usr/bin/env node
/**
 * Regenerates the README media into `docs/media/`:
 *
 *   full-size PNGs of the mockups in `docs/mockups/`
 *   full-size PNGs of every UI in `uis/`, each served by a real panel with a throwaway
 *     demo state (a small home stack: three running servers, one disabled)
 *   `tour.gif`, a GIF cycling the same views, from frames captured at GIF size
 *
 * Usage:
 *
 *   node scripts/capture-media.mjs            # all of it
 *   node scripts/capture-media.mjs mockups    # mockups only
 *   node scripts/capture-media.mjs uis        # served UIs only
 *   node scripts/capture-media.mjs gif        # rebuild the GIF from the frames on disk
 *
 * Playwright drives Chromium. Two things a bare container usually lacks, both of which make
 * Chromium die while rendering (a Skia font panic, or a missing shared library):
 *
 *   FONTCONFIG_PATH=/path/to/conf   a fonts.conf with a <dir> holding any TTF
 *   LD_LIBRARY_PATH=/path/to/usr/lib   the X/NSS/Mesa libraries if the system has none
 *
 * With those set, `node scripts/capture-media.mjs` regenerates everything.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import gifenc from 'gifenc'
import { chromium } from 'playwright'
import pngjs from 'pngjs'

// both are CommonJS when Node resolves them, so take the named members off the default
const { applyPalette, GIFEncoder, quantize } = gifenc
const { PNG } = pngjs

const root = fileURLToPath(new URL('..', import.meta.url))
const mockupsDir = path.join(root, 'docs/mockups')
const mediaDir = path.join(root, 'docs/media')
const uisDir = path.join(root, 'uis')

const FULL = { width: 1600, height: 1000 }
const TOUR = { width: 1120, height: 700 }
const FRAME_MS = 2400

const only = process.argv.slice(2)
const wants = what => only.length === 0 || only.includes(what)

/** A stand-in server, so the panels have live output to show — one voice per entry. */
const DEMO_SERVER = `
const { createServer } = require('node:http')
const [, , flavour, port] = process.argv
const LINES = {
  gateway: [
    () => 'route /v1/chat/completions → upstream-' + 'abc'[Math.floor(Math.random() * 3)] + ' (' + (120 + Math.floor(Math.random() * 900)) + ' ms)',
    () => 'route /v1/embeddings → local table (61 ms)',
    () => 'upstreams healthy: 3/3 · queue depth 0',
    () => 'stream closed by client after ' + (2 + Math.random() * 4).toFixed(1) + 'k tokens',
    () => 'key ...4f21 refreshed, next in 41m',
  ],
  media: [
    () => 'library scan: ' + (1180 + Math.floor(Math.random() * 40)) + ' items, 6 added',
    () => 'transcode h264 → h265 finished in ' + (30 + Math.floor(Math.random() * 40)) + 's (S01E04)',
    () => 'subtitle fetch queued for "S01E05"',
    () => 'watched folder change: /media/incoming',
    () => 'session 192.168.1.42 playing · direct play',
  ],
  vault: [
    () => 'audit: read secret home/wifi by mt',
    () => 'token issued for media (ttl 15m)',
    () => 'auto-unseal: transit key rotated',
    () => 'snapshot written (12 KiB) to /backups',
    () => 'lease renewed for gateway (ttl 30m)',
  ],
}
const lines = LINES[flavour] || LINES.gateway
let index = 0
createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('ok\\n')
}).listen(Number(port), '127.0.0.1', () => console.log(flavour + ' listening on ' + port))
setInterval(() => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + lines[index++ % lines.length]()), 1300)
`

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** `stock` keeps the default panel name; anything else announces itself, acronyms intact. */
function uiLabel(name) {
  if (name === 'stock')
    return undefined
  return name.split('-').map(part => (part.length <= 3 ? part.toUpperCase() : part)).join('-')
}

async function waitForPanel(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(url)
      return true
    }
    catch {
      await wait(300)
    }
  }
  return false
}

/** A throwaway state with a live-looking stack, plus a UI to serve when one is given. */
async function makeHome(uiDist, label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-media-'))
  const state = path.join(home, 'state')
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(home, 'server.cjs'), DEMO_SERVER)

  const servers = []
  const flavours = ['gateway', 'media', 'vault']
  const labels = { gateway: 'LLM gateway', media: 'Media server', vault: 'Secrets vault' }
  for (const id of flavours) {
    servers.push({
      id,
      label: labels[id],
      command: process.execPath,
      args: [path.join(home, 'server.cjs'), id, '{port}'],
      port: await freePort(),
      autostart: true,
      env: { LOG_LEVEL: 'info' },
      ...(id === 'media' ? { dataEnvs: { DATA_DIR: '{dataRoot}/.demo-media' } } : {}),
      health: id === 'gateway'
        ? { enabled: true, mode: 'http', http: { path: '/' }, intervalMs: 3000, timeoutMs: 2000 }
        : { enabled: true, intervalMs: 3000, timeoutMs: 2000 },
    })
  }
  servers.push({
    id: 'bot',
    label: 'Telegram bot',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    port: await freePort(),
    enabled: false,
    autostart: false,
  })

  const port = await freePort()
  fs.writeFileSync(
    path.join(state, 'servers.config.json'),
    `${JSON.stringify({ control: { port, host: 'local', auth: { enabled: false }, ...(label ? { label } : {}) }, defaults: { logBufferLines: 500 }, servers }, null, 2)}\n`,
  )
  if (uiDist)
    fs.cpSync(uiDist, path.join(state, '.ui'), { recursive: true })

  return { home, state, port }
}

/** Runs the panel for one UI, hands its URL to `run`, then tears everything down. */
async function withPanel(name, uiDist, run) {
  const { home, state, port } = await makeHome(uiDist, uiLabel(name))
  const child = spawn(process.execPath, [path.join(root, 'dist', 'cli.js'), 'up', '--foreground'], {
    env: { ...process.env, HHOSTED_HOME: state, HHOSTED_PROJECT: home },
    stdio: 'ignore',
  })
  try {
    if (!(await waitForPanel(`http://127.0.0.1:${port}/healthz`)))
      throw new Error(`the panel for ${name} never answered on ${port}`)
    process.stdout.write(`[media] ${name} served on ${port}\n`)
    return await run(`http://127.0.0.1:${port}/`)
  }
  finally {
    child.kill('SIGTERM')
    await wait(1500)
    fs.rmSync(home, { recursive: true, force: true })
  }
}

const shots = []

async function shoot(page, url, name, { settle = 0, expect }) {
  await page.setViewportSize(FULL)
  await page.goto(url, { waitUntil: 'load' })
  if (expect)
    await page.getByText(expect, { exact: false }).first().waitFor({ timeout: 8000 }).catch(() => {})
  if (settle > 0)
    await wait(settle)
  await page.screenshot({ path: path.join(mediaDir, `${name}.png`) })

  await page.setViewportSize(TOUR)
  await wait(350)
  await page.screenshot({ path: path.join(mediaDir, `${name}-tour.png`) })

  // Cheap layout sanity: a view that scrolls is a view we are only half capturing.
  const fit = await page.evaluate(() => {
    const root = document.documentElement
    const spill = [...document.querySelectorAll('*')]
      .filter((element) => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && (box.right > innerWidth + 1 || box.bottom > innerHeight + 1)
      })
      .slice(0, 4)
      .map(element => `${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]}`)
    return { width: innerWidth, height: innerHeight, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, spill }
  })
  const bleeds = fit.scrollWidth > fit.width + 1 || fit.scrollHeight > fit.height + 1
  process.stdout.write(bleeds
    ? `[media] ${name} overflows ${fit.width}x${fit.height} (${fit.scrollWidth}x${fit.scrollHeight}) spill=${fit.spill.join(',')} \n`
    : `[media] ${name} fits ${fit.width}x${fit.height}\n`)

  // No vision model here, so assert the render is real: fonts resolved (tofu boxes mean the
  // font never loaded), text painted, and nothing collapsed to a zero-height page.
  const paint = await page.evaluate(() => ({
    fonts: document.fonts.status,
    families: new Set([...document.querySelectorAll('body *')].slice(0, 400).map(element => getComputedStyle(element).fontFamily)).size,
    text: (document.body.textContent || '').trim().length,
    height: document.body.getBoundingClientRect().height,
  }))
  if (paint.fonts !== 'loaded' || paint.text < 40 || paint.height < 100)
    process.stdout.write(`[media] ${name} WEAK RENDER fonts=${paint.fonts} text=${paint.text} height=${Math.round(paint.height)}\n`)

  const { size } = await fs.promises.stat(path.join(mediaDir, `${name}.png`))
  process.stdout.write(`[media] ${name}.png (${Math.round(size / 1024)} KB)\n`)
  shots.push({ name, file: path.join(mediaDir, `${name}-tour.png`) })
}

async function captureMockups(page) {
  for (const file of fs.readdirSync(mockupsDir).filter(entry => entry.endsWith('.html')).sort()) {
    const name = `mockup-${path.basename(file, '.html')}`
    await shoot(page, `file://${path.join(mockupsDir, file)}`, name, { settle: 250 })
  }
}

async function captureUis(page) {
  const uis = fs.readdirSync(uisDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(uisDir, entry.name, 'dist', 'index.html')))
    .map(entry => entry.name)
    .sort()

  for (const name of uis) {
    const dist = path.join(uisDir, name, 'dist')
    await withPanel(name, name === 'stock' ? null : dist, async (url) => {
      await shoot(page, url, `ui-${name}`, { settle: 2600, expect: 'gateway' })
    })
  }
}

async function buildGif() {
  // The shipped UIs first (the actual product), then the design examples — and always from
  // disk, so re-running just `uis gif` still produces the whole tour.
  const frames = fs.readdirSync(mediaDir)
    .filter(entry => entry.endsWith('-tour.png'))
    .sort((left, right) => {
      const rank = entry => (entry.startsWith('ui-') ? 0 : 1)
      return rank(left) - rank(right) || left.localeCompare(right)
    })
    .map(entry => path.join(mediaDir, entry))

  const encoder = GIFEncoder()
  for (const file of frames) {
    const png = PNG.sync.read(fs.readFileSync(file))
    const palette = quantize(png.data, 192, { format: 'rgb565' })
    const index = applyPalette(png.data, palette, 'rgb565')
    encoder.writeFrame(index, png.width, png.height, { palette, delay: FRAME_MS })
  }
  encoder.finish()

  const target = path.join(mediaDir, 'tour.gif')
  fs.writeFileSync(target, encoder.bytes())
  const { size } = await fs.promises.stat(target)
  process.stdout.write(`[media] tour.gif — ${frames.length} frames, ${Math.round(size / 1024)} KB\n`)
}

fs.mkdirSync(mediaDir, { recursive: true })

if (wants('gif') && only.length === 1 && only[0] === 'gif') {
  await buildGif()
}
else {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: FULL, deviceScaleFactor: 2 })
  try {
    if (wants('mockups'))
      await captureMockups(page)
    if (wants('uis') && fs.existsSync(path.join(root, 'dist', 'cli.js')))
      await captureUis(page)
  }
  finally {
    await browser.close()
  }
  if (wants('gif'))
    await buildGif()
}
