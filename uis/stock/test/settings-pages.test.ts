// @vitest-environment happy-dom
import type { BackupsView, ControlView, HostView, SettingsView, UiStatus } from '@shared/contracts'
import type { AppStateView, WorkspaceState } from '@/lib/api'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * The two settings pages share one shell (`SettingsShell.vue`) but write two different files.
 *
 * They were the same view twice — the nav rail and its scroll-spy, the save/discard footer and the
 * unsaved-changes list were byte-identical, and a fix reached one copy only. The extraction moved
 * the *chrome*, so that is what this pins:
 *
 *  - the shell's own behaviour renders for either page (rail, footer, the changes list);
 *  - Global settings calls `saveGlobalSettings` with the panel-wide patch, the workspace page calls
 *    `saveWorkspaceSettings` with the workspace id — pointing either page at the other's save is
 *    exactly the drift the shared shell makes possible, and the case this test must fail on;
 *  - an edit is still shown as pending *per block*, which is what the shell's footer counts.
 *
 * The pages are mounted whole with their sections stubbed: the shell and each page's own wiring are
 * under test here, and every section already has its own test.
 */

/** Every endpoint call either page makes, in order. */
const calls: Array<{ kind: string, args: unknown[] }> = []

/**
 * `/api/settings` is held until a test releases it: the real panel serves the state frame first
 * and this file-level payload *after*, which is the ordering the per-block guard exists for.
 */
const gate = vi.hoisted(() => {
  let release: () => void = () => {}
  let opened = Promise.resolve()
  return {
    reset() {
      opened = new Promise<void>((resolve) => {
        release = () => resolve()
      })
    },
    opened: () => opened,
    release: () => release(),
  }
})

const CONTROL: ControlView = {
  label: 'home-hosted',
  port: 3999,
  host: 'local',
  bindHost: '127.0.0.1',
  url: 'http://127.0.0.1:3999',
  openBrowser: false,
  restartRequired: false,
  protocol: 'http',
  auth: {
    enabled: true,
    passwordSet: true,
    passwordUpdatedAt: 1,
    apiTokenSet: false,
    usingDefaultPassword: false,
    exposed: false,
    blockedReason: null,
    sessionTtlMs: 604_800_000,
    cookieSecure: 'auto',
    trustProxy: false,
    maxLoginAttempts: 5,
    lockoutMs: 60_000,
  },
  tls: {
    enabled: false,
    certPresent: false,
    subject: null,
    issuer: null,
    validFrom: null,
    validTo: null,
    daysRemaining: null,
    fingerprint: null,
    keyMatches: null,
    error: null,
  },
}

const BACKUPS: BackupsView = { enabled: true, dir: '/tmp/.backups', keep: 5, schedule: { intervalMs: 0, keep: 7 }, lastAutomaticAt: null, includePaths: [], entries: [], files: [] }

const UI_STATUS: UiStatus = { custom: false, dir: '/tmp/.ui', meta: null }

/**
 * The file-only host block, as `/api/settings` carries it. It lives outside the state
 * frame, so it arrives *after* the first frame and is the block a global "has anything
 * changed?" gate used to strand on schema defaults.
 */
function hostView(): HostView {
  return {
    enabled: true,
    // Deliberately unlike the form's schema defaults: a block that never fills is visible.
    intervalMs: 20_000,
    diskPaths: ['.'],
    diskUsedPercent: 80,
    memoryUsedPercent: 90,
    swapUsedPercent: 50,
    loadPerCpu: 2,
    tempCelsius: 85,
    alerts: [],
  } as unknown as HostView
}

/** `/api/settings`: the file-level half, which lands after the first state frame. */
const settingsView = {
  control: CONTROL,
  host: hostView(),
  backups: BACKUPS,
  ui: UI_STATUS,
} as unknown as SettingsView

/** The selected workspace, in the shape `useWorkspaces()` hands the view. */
function workspaceState(): WorkspaceState {
  return {
    id: 'default',
    label: 'Default',
    configPath: '/tmp/.hh/default/servers.config.json',
    settingsPath: '/tmp/.hh/default/settings.json',
    configError: null,
    configWarnings: [],
    logsDir: '/tmp/.hh/default/.logs',
    serverCount: 0,
    runningCount: 0,
    crashedCount: 0,
    defaults: {
      enabled: true,
      autostart: false,
      bind: 'local',
      onPortConflict: 'block',
      logBufferLines: 500,
      restart: { enabled: true, maxRetries: 3, baseDelayMs: 1000, factor: 2, maxDelayMs: 30_000, resetAfterMs: 60_000 },
      health: {
        enabled: true,
        mode: 'port',
        http: { path: '/', method: 'GET', expectStatusBelow: 400, expectBody: '' },
        intervalMs: 5000,
        timeoutMs: 1500,
        unhealthyThreshold: 3,
        forceRestartAfterMs: 0,
        startTimeoutMs: 20_000,
      },
      stop: { signal: 'SIGTERM', killGroup: true, graceMs: 5000, killPortHolders: false },
    },
    logs: { persist: true, maxBytes: 2_000_000, keep: 3 },
    notifications: {
      telegram: {
        enabled: false,
        tokenSet: false,
        chatId: '',
        onCrash: true,
        onUnhealthy: true,
        onForcedRestart: true,
        onRecovered: false,
        onHost: true,
        onDdns: true,
        cooldownMs: 120_000,
        lastResult: null,
        lastResultAt: null,
      },
    },
    servers: [],
  } as unknown as WorkspaceState
}

/**
 * The live control view, as a mutable ref: a state frame is the panel's own value arriving again,
 * and the TLS section's bug was that `syncFromLive()` wrote it over an edit in progress.
 */
const liveControl = ref<ControlView>(CONTROL)

const STATE = {
  control: CONTROL,
  host: null,
  backups: BACKUPS,
  proxy: null,
  projectDir: '/tmp/proj',
  dataRoot: '/tmp/.hh',
  version: '0.0.0-test',
  workspaces: [workspaceState()],
} as unknown as AppStateView

vi.mock('@/lib/api', async (importOriginal) => {
  // Spread the real module: the views do `import * as api`, and a bare object has no module
  // namespace (see the note in logs-stream-filter.test.ts).
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchSettings: async () => {
      await gate.opened()
      return { ...settingsView, host: hostView() }
    },
    saveDdns: async (...args: unknown[]) => {
      calls.push({ kind: 'saveDdns', args })
      return { config: {}, status: {}, providers: [], credentials: [] }
    },
    fetchDdns: async () => ({
      config: { enabled: false, intervalMs: 300_000, ttl: 300, accounts: [], domains: [] },
      status: { enabled: false, lastRunAt: null, records: [] },
      providers: [],
      credentials: [],
    }),
  }
})

vi.mock('@/composables/useControlPlane', () => ({
  useControlPlane: () => ({
    appState: ref(STATE),
    workspaces: computed(() => STATE.workspaces),
    control: computed(() => liveControl.value),
    host: computed(() => null),
    backups: computed(() => BACKUPS),
    projectDir: computed(() => '/tmp/proj'),
    dataRoot: computed(() => '/tmp/.hh'),
    version: computed(() => '0.0.0-test'),
    now: computed(() => 1),
    lastError: computed(() => null),
    refresh: async () => {},
    saveGlobalSettings: async (patch: unknown) => {
      calls.push({ kind: 'saveGlobalSettings', args: [patch] })
      return { ...settingsView, rebinding: false, targetUrl: null }
    },
    saveWorkspaceSettings: async (...args: unknown[]) => {
      calls.push({ kind: 'saveWorkspaceSettings', args })
      return { ...workspaceState() }
    },
  }),
  useServerLogs: () => ({ lines: () => [], version: ref(0) }),
}))

vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({
    activeId: computed(() => 'default'),
    selected: computed(() => workspaceState()),
    workspaces: computed(() => [workspaceState()]),
    defaults: computed(() => workspaceState().defaults),
    logsConfig: computed(() => workspaceState().logs),
    notifications: computed(() => workspaceState().notifications),
    configError: computed(() => null),
    configWarnings: computed(() => []),
    logsDir: computed(() => '/tmp/.hh/default/.logs'),
  }),
}))

/**
 * Only the sections this test does not drive are stubbed. The two field groups it edits are
 * mounted for real, so its assertion is about the page's own patch and endpoint rather than about
 * a fixture that mimics a v-model.
 */
const stubs = {
  HostSection: false,
  BackupsSection: true,
  TlsSection: true,
  PathsSection: true,
  NotificationsSection: true,
  DdnsSection: true,
}

async function mountPage(which: 'global' | 'workspace', options: { holdSettings?: boolean, at?: string, tls?: boolean } = {}) {
  const View = which === 'global'
    ? (await import('@/views/GlobalSettingsView.vue')).default
    : (await import('@/views/SettingsView.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: { template: '<div />' } }],
  })
  await router.push(options.at ?? '/')
  await router.isReady()
  // `tls` mounts the real TLS section; every other test stubs it.
  const sections = options.tls === true ? { ...stubs, TlsSection: false } : stubs
  const wrapper = mount(View, { global: { plugins: [router], stubs: sections }, attachTo: document.body })
  await flushPromises()
  // Every other test wants the settings payload present; the guard test drives the ordering itself.
  if (!options.holdSettings)
    gate.release()
  await flushPromises()
  return wrapper
}

/** The input a section renders under `label` — `TextField`/`NumberField` bind `for` to it. */
function inputFor(wrapper: Awaited<ReturnType<typeof mountPage>>, label: string) {
  const node = wrapper.findAll('label').find(entry => entry.text().trim() === label)
  if (!node)
    throw new Error(`no field labelled ${label}`)
  return wrapper.get(`#${node.attributes('for')}`)
}

function saveButton(wrapper: Awaited<ReturnType<typeof mountPage>>) {
  const button = wrapper.findAll('button').find(node => node.text() === 'Save settings')
  if (!button)
    throw new Error('the shell rendered no Save button')
  return button
}

beforeEach(() => {
  calls.length = 0
  document.body.innerHTML = ''
  liveControl.value = CONTROL
  gate.reset()
})

describe('the shared settings shell', () => {
  it('renders its rail and footer for the global page', async () => {
    const wrapper = await mountPage('global')

    for (const title of ['Listener', 'Authentication', 'Host vitals', 'Backups', 'TLS', 'Interface', 'Paths'])
      expect(wrapper.findAll('button').some(button => button.text() === title), title).toBe(true)

    expect(wrapper.text()).toContain('No unsaved changes')
    expect(wrapper.text()).toContain('Discard changes')
    // The rail names which settings these are, for a screen reader.
    expect(wrapper.find('nav').attributes('aria-label')).toBe('Global settings sections')
  })

  it('renders its rail and footer for the workspace page, with its own label', async () => {
    const wrapper = await mountPage('workspace')

    for (const title of ['Server defaults', 'Logs', 'Notifications', 'Dynamic DNS'])
      expect(wrapper.findAll('button').some(button => button.text() === title), title).toBe(true)

    expect(wrapper.find('nav').attributes('aria-label')).toBe('Workspace settings sections')
    expect(wrapper.text()).toContain('Discard changes')
  })

  /**
   * The panel name is the one field the global page owns end to end: it is edited from the
   * Interface section and saved in the `control` patch. Typing it must turn into a pending count
   * and reach `saveGlobalSettings` alone.
   */
  it('sends the panel-wide patch to saveGlobalSettings', async () => {
    const wrapper = await mountPage('global')

    await inputFor(wrapper, 'Panel name').setValue('My panel')
    await flushPromises()

    expect(wrapper.text()).toContain('1 field changed')
    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(calls.map(call => call.kind)).toEqual(['saveGlobalSettings'])
    // The panel's own name, in the `control` group the panel-wide file stores.
    expect(calls[0]!.args[0]).toEqual({ control: { label: 'My panel' } })
  })

  /**
   * The same shape on the workspace page: its Save carries the workspace id, and the patch is
   * scoped to that workspace's file. A shared page that quietly called the other endpoint would
   * write the panel-wide file with workspace keys.
   */
  it('sends the workspace patch to saveWorkspaceSettings, with the workspace id', async () => {
    const wrapper = await mountPage('workspace')

    await inputFor(wrapper, 'Keep rotated files').setValue('7')
    await flushPromises()

    expect(wrapper.text()).toContain('1 field changed')
    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(calls.map(call => call.kind)).toEqual(['saveWorkspaceSettings'])
    expect(calls[0]!.args[0], 'the workspace id travels with the patch').toBe('default')
    expect(calls[0]!.args[1]).toEqual({ logs: { keep: 7 } })
  })
})

/**
 * The rail's link to the URL survived the move into the shell: `?section=` still selects an entry,
 * and an unknown one is ignored rather than lighting nothing.
 */
describe('the section deep link', () => {
  it('opens on the section the URL names, and ignores one that does not exist', async () => {
    const linked = await mountPage('workspace', { at: '/?section=notifications' })
    const current = () => linked.findAll('button').find(button => button.attributes('aria-current') === 'true')?.text()

    expect(current()).toBe('Notifications')
    expect(linked.findAll('nav button').some(button => button.text() === 'Dynamic DNS')).toBe(true)

    const bogus = await mountPage('workspace', { at: '/?section=nope' })
    expect(bogus.findAll('button').find(button => button.attributes('aria-current') === 'true')?.text()).toBe('Server defaults')
  })
})

/**
 * The per-block guard, driven through the page rather than through `settingsForm`.
 *
 * Host thresholds and the backups policy come from `/api/settings`, which lands *after* the first
 * state frame. One "has anything changed?" gate for the whole form read that late arrival as a
 * pending edit and left those fields showing schema defaults forever — and offered to revert a
 * change nobody made. The block under the cursor is the one that must not be overwritten; the one
 * beside it must still fill.
 */
/**
 * The reported bug, driven through the mounted page: "Serve the panel over HTTPS" flipped itself
 * back within a second of being switched on.
 *
 * `ListenerForm` carries `tlsEnabled` because the `control` patch is one block, but the page guards
 * its three groups separately. Editing TLS left the listener part untouched, so the listener fill
 * ran every state frame and `Object.assign(form.control, listenerBaseline(view))` wrote the live
 * `tls.enabled` straight over the switch. `TlsSection` is mounted for real here — the flip happened
 * in the page's fill loop, and only the rendered toggle can show it.
 */
describe('the TLS toggle is not reverted by a state frame', () => {
  it('keeps the switch on while the panel still serves http', async () => {
    const wrapper = await mountPage('global', { tls: true })

    const tlsSwitch = () => wrapper.findAll('[role="switch"]')
      .find(node => node.attributes('aria-labelledby') !== undefined
        && wrapper.find(`#${node.attributes('aria-labelledby')}`).text() === 'Serve the panel over HTTPS')

    expect(tlsSwitch(), 'the TLS section rendered no HTTPS switch').toBeTruthy()
    expect(tlsSwitch()!.attributes('data-state')).toBe('unchecked')

    await tlsSwitch()!.trigger('click')
    await flushPromises()
    expect(tlsSwitch()!.attributes('data-state')).toBe('checked')

    // The next state frame carries what the panel holds — still "off", because nothing was saved.
    liveControl.value = { ...CONTROL, label: 'Renamed elsewhere' }
    await flushPromises()

    expect(
      tlsSwitch()!.attributes('data-state'),
      'a state frame reverted the HTTPS toggle',
    ).toBe('checked')
    // …and the listener group it belongs to did follow the rename, so the guard is per part.
    expect((inputFor(wrapper, 'Panel name').element as HTMLInputElement).value).toBe('Renamed elsewhere')
  })
})

describe('the copy-from-live guard stays per block', () => {
  it('fills the late host block even while another block is being edited', async () => {
    const wrapper = await mountPage('global', { holdSettings: true })

    // The state frame has landed; `/api/settings` has not. Start editing a *different* block.
    await inputFor(wrapper, 'Panel name').setValue('My panel')
    await flushPromises()
    // The host block is still on the schema defaults, which differ from the config below.
    // Shown in seconds now, so the schema default 15000 ms reads as `15`.
    expect((inputFor(wrapper, 'Interval (s)').element as HTMLInputElement).value).toBe('15')

    // Now the file-level block arrives with the config's own value.
    gate.release()
    await flushPromises()

    // A guard over the whole form would have read the pending rename as "this block is edited"
    // and left the schema default showing forever, offering to revert a change nobody made.
    expect((inputFor(wrapper, 'Interval (s)').element as HTMLInputElement).value).toBe('20')
    // …and the rename in the other block survived the fill.
    expect((inputFor(wrapper, 'Panel name').element as HTMLInputElement).value).toBe('My panel')
  })
})

/**
 * The changes list is the shell's, down to the count in its trigger — the one thing that used to
 * be copied per page and could disagree with the footer about how much is pending.
 */
describe('the unsaved-changes list', () => {
  it('opens from the footer and lists what Save would write', async () => {
    const wrapper = await mountPage('global')

    await inputFor(wrapper, 'Panel name').setValue('Renamed')
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text().includes('field changed'))!.trigger('click')
    await flushPromises()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('control.label')
    })
    expect(document.body.textContent).toContain('Unsaved changes')
    expect(document.body.textContent).toContain('Renamed')
  })

  /**
   * A patched leaf whose path has no counterpart in the live shape reads as "unset → true", which
   * looks like the panel has no value where it plainly does. The HTTPS toggle was the case: the
   * patch carries `control.tls.enabled`, and the snapshot used to carry the form's flat
   * `tlsEnabled` beside it.
   */
  it('names the live value of the HTTPS toggle, not "unset"', async () => {
    const wrapper = await mountPage('global', { tls: true })

    await wrapper.findAll('[role="switch"]')
      .find(node => wrapper.find(`#${node.attributes('aria-labelledby')}`).text() === 'Serve the panel over HTTPS')!
      .trigger('click')
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text().includes('field changed'))!.trigger('click')
    await flushPromises()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('control.tls.enabled')
    })
    // The row reads `false → true`; `unset` would mean the page had no live value to compare against.
    const row = Array.from(document.body.querySelectorAll('li'))
      .find(node => node.textContent?.includes('control.tls.enabled'))
    expect(row?.textContent).not.toContain('unset')
    expect(row?.textContent).toContain('false')
  })
})

/**
 * The DDNS block's count, driven through the mounted section.
 *
 * The page's own count reported **9 fields** for a single IPv6 toggle: it counted the leaves of the
 * whole block it hands to `/api/ddns`, which is a replaced block, so every untouched key rode along
 * — and the change list showed them as `true → true`. The fix is `ddnsConfigPatch`, and this is the
 * one test that can see the number the footer actually prints.
 *
 * `DdnsSection` is mounted for real here; every other test stubs it.
 */
describe('the DDNS block counts only what it changed', () => {
  const DDNS_CONFIG = {
    enabled: true,
    intervalMs: 300_000,
    ttl: 1,
    ipv4: { enabled: true, url: '' },
    ipv6: { enabled: true, url: '' },
    accounts: [{ id: 'main', provider: 'cloudflare', label: '' }],
    domains: [
      { host: 'one.example.com', account: 'main', types: ['A'], proxied: false, enabled: true },
      { host: 'two.example.com', account: 'main', types: ['A'], proxied: false, enabled: true },
    ],
  }

  async function mountWithDdns() {
    const original = await import('@/lib/api')
    vi.spyOn(original, 'fetchDdns').mockResolvedValue({
      config: DDNS_CONFIG,
      status: { enabled: true, running: false, lastRunAt: null, lastResult: null, ipv4: null, ipv6: null, records: [] },
      providers: [{ id: 'cloudflare', label: 'Cloudflare', docsUrl: '', families: ['A', 'AAAA'], fields: [], ttl: true, proxied: true, txt: false }],
      credentials: [],
    } as never)

    const View = (await import('@/views/SettingsView.vue')).default
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { template: '<div />' } }] })
    await router.push('/')
    await router.isReady()
    const wrapper = mount(View, { global: { plugins: [router], stubs: { ...stubs, DdnsSection: false } }, attachTo: document.body })
    await flushPromises()
    gate.release()
    await flushPromises()
    return wrapper
  }

  it('reports one field for turning IPv6 off, not the whole block', async () => {
    const wrapper = await mountWithDdns()

    // Turning IPv6 off is the reported action: its switch carries that label.
    const labels = wrapper.findAll('label').filter(node => node.text().startsWith('Detect IPv6'))
    expect(labels.length, 'the DDNS section did not render its IPv6 switch').toBeGreaterThan(0)
    await labels[0]!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('1 field changed')
    expect(wrapper.text()).not.toContain('9 fields changed')

    // The list behind that count: the one field, and not the eight it was never asked about.
    await wrapper.findAll('button').find(button => button.text().includes('field changed'))!.trigger('click')
    await flushPromises()

    const list = await vi.waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text).toContain('ddns.ipv6.enabled')
      return text
    })
    for (const untouched of ['ddns.enabled', 'ddns.ttl', 'ddns.intervalMs', 'ddns.accounts', 'ddns.domains'])
      expect(list, `${untouched} was reported for a toggle that never touched it`).not.toContain(untouched)
    // A row key is a UI detail, so it may not appear in a value either.
    expect(list).not.toContain('ddns-row-')

    wrapper.unmount()
  })
})

/**
 * A deep link has to survive the page growing under it.
 *
 * `?section=` is read in `setup`, before `/api/settings` fills the host and backups blocks. Those
 * blocks add real height *above* the target, so a single `scrollIntoView` measured the shorter
 * document and then let the page grow past it. Measured in Chromium at 1280x900 on
 * `/global/settings?section=tls`: the scroll ran at `scrollHeight` 5227, the page grew to 6227, and
 * the target sat at **1072** instead of 72 — a reload, a bookmark and the command palette's
 * "Global setting: TLS" all landed on unrelated content, while clicking the rail (which runs after
 * the fill) was correct.
 *
 * `happy-dom` lays nothing out, so the assertion is about the *order of operations*: the shell must
 * keep re-issuing the scroll while its host element reports new height, and must stop once it is
 * still, or when the person scrolls instead.
 */
describe('a section deep link follows the page as it grows', () => {
  /** Records every `scrollIntoView`, and reports a height the shell's observer will see. */
  function trackScrolls(heights: number[]) {
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id)
    }
    let index = 0
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => {
      // Grow on each read, as a late block filling does, then hold.
      const value = heights[Math.min(index, heights.length - 1)] ?? 0
      index += 1
      return value
    })
    return {
      scrolled,
      restore() {
        Element.prototype.scrollIntoView = original
        scrollHeight.mockRestore()
      },
    }
  }

  it('re-issues the scroll while the page keeps growing, then stops', async () => {
    vi.useFakeTimers()
    const tracker = trackScrolls([500, 1200, 1800, 1800, 1800])
    try {
      const wrapper = await mountPage('global', { at: '/?section=paths' })
      await flushPromises()

      // The first placement happened in `setup`/`nextTick`.
      expect(tracker.scrolled.length, 'the deep link must scroll at least once').toBeGreaterThan(0)
      expect(tracker.scrolled.every(id => id === 'paths'), 'it must follow the section the URL named').toBe(true)

      const afterFirst = tracker.scrolled.length
      // A fill lands and the page grows: the next poll sees the new height and re-places.
      await vi.advanceTimersByTimeAsync(150)
      await flushPromises()
      expect(tracker.scrolled.length, 'growth must be followed by another scroll').toBeGreaterThan(afterFirst)

      // Once the height holds for the settle window, the shell lets go.
      await vi.advanceTimersByTimeAsync(2000)
      await flushPromises()
      const settled = tracker.scrolled.length
      await vi.advanceTimersByTimeAsync(5000)
      await flushPromises()
      expect(tracker.scrolled.length, 'a settled page must not keep scrolling').toBe(settled)

      wrapper.unmount()
    }
    finally {
      tracker.restore()
      vi.useRealTimers()
    }
  })
})
