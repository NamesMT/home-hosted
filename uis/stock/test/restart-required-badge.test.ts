// @vitest-environment happy-dom
import type { ServerView } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

/**
 * A saved config that the running process has not picked up says so, and offers the fix.
 *
 * `PUT`/`PATCH /api/servers/:id` writes config only — the process keeps the command, args, cwd, env
 * and port it started with. So a person changed the program, pressed Save, read "saved", and the old
 * program kept serving. `serverViewSchema.restartRequired` is the panel's answer, and the card's
 * whole job here is to make it visible: a badge that says which, with the hint naming why.
 *
 * The detail page's badge is asserted too, because that is where the restart button lives — a badge
 * with no action beside it sends the person looking for one.
 *
 * noc-console's half is asserted from `@shared/contracts` in `uis/noc-console/test/`
 * (`restart-required-chip.test.ts`, a source scan) — the two UIs must state the same rule.
 */
function view(overrides: Partial<ServerView> = {}): ServerView {
  return {
    id: 'web',
    workspaceId: 'default',
    config: { id: 'web', command: 'node', args: [], autostart: false, enabled: true, label: null, port: null, bind: 'local' } as never,
    bindHost: '127.0.0.1',
    url: null,
    status: 'running',
    health: 'disabled',
    portState: 'unknown',
    pid: 42,
    adopted: false,
    startedAt: 1,
    exitCode: null,
    exitSignal: null,
    restarts: 0,
    maxRetries: 0,
    lastError: null,
    nextRetryAt: null,
    unhealthySince: null,
    bufferedLines: 0,
    history: {
      windowMs: 86_400_000,
      uptimeRatio: null,
      restarts: 0,
      crashes: 0,
      forcedRestarts: 0,
      lastCrashAt: null,
      lastExitAt: null,
      lastRuntimeMs: null,
      events: [],
    },
    responseMs: null,
    resources: null,
    ...overrides,
  } as ServerView
}

/** Mounted the way `server-card-link.test.ts` does: no router plugin, and `Tip` stubbed. */
async function mountCard(server: ServerView) {
  const ServerCard = (await import('../src/components/server/ServerCard.vue')).default
  return mount(ServerCard, {
    props: { server, workspaceId: 'default', series: undefined, now: 1_000_000 },
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        // `Tip` renders a reka-ui tooltip, which needs a provider the test does not mount.
        Tip: { template: '<span><slot /></span>' },
      },
    },
  })
}

describe('the restart-to-apply badge', () => {
  it('shows when the running process predates the config', async () => {
    const wrapper = await mountCard(view({ restartRequired: true }))
    expect(wrapper.text()).toContain('Restart to apply')
    wrapper.unmount()
  })

  it('says nothing when the running config is the current one', async () => {
    // Absent, not `false`: the field is optional, and an older panel sends neither.
    const wrapper = await mountCard(view())
    expect(wrapper.text()).not.toContain('Restart to apply')
    wrapper.unmount()
  })

  it('is not shown for a stopped entry, where there is nothing to restart', async () => {
    const wrapper = await mountCard(view({ status: 'stopped', pid: null, restartRequired: false }))
    expect(wrapper.text()).not.toContain('Restart to apply')
    wrapper.unmount()
    void vi
  })
})
