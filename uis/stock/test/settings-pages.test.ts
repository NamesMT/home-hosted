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
    control: computed(() => CONTROL),
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

async function mountPage(which: 'global' | 'workspace', options: { holdSettings?: boolean, at?: string } = {}) {
  const View = which === 'global'
    ? (await import('@/views/GlobalSettingsView.vue')).default
    : (await import('@/views/SettingsView.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: { template: '<div />' } }],
  })
  await router.push(options.at ?? '/')
  await router.isReady()
  const wrapper = mount(View, { global: { plugins: [router], stubs }, attachTo: document.body })
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
describe('the copy-from-live guard stays per block', () => {
  it('fills the late host block even while another block is being edited', async () => {
    const wrapper = await mountPage('global', { holdSettings: true })

    // The state frame has landed; `/api/settings` has not. Start editing a *different* block.
    await inputFor(wrapper, 'Panel name').setValue('My panel')
    await flushPromises()
    // The host block is still on the schema defaults, which differ from the config below.
    expect((inputFor(wrapper, 'Interval (ms)').element as HTMLInputElement).value).toBe('15000')

    // Now the file-level block arrives with the config's own value.
    gate.release()
    await flushPromises()

    // A guard over the whole form would have read the pending rename as "this block is edited"
    // and left the schema default showing forever, offering to revert a change nobody made.
    expect((inputFor(wrapper, 'Interval (ms)').element as HTMLInputElement).value).toBe('20000')
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
})
