// @vitest-environment happy-dom
import type { ServerConfig, ServerView } from '@shared/contracts'
import { serverSchema } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * The detail header's link must be reachable from where the viewer is.
 *
 * A `lan` entry is reported at this machine's LAN address, which nobody arriving over a public
 * hostname or a tunnel can route to. The rule is pinned purely in `test/shared/server-url.test.ts`;
 * this mounts the component, because the defect was the *wiring* — a correct rule the header did not
 * use would have looked fixed.
 *
 * happy-dom serves the suite from `localhost`, so each case sets the page URL explicitly.
 */

/** The detail pane opens a log stream on mount; the suite only needs the header. */
class FakeEventSource {
  addEventListener(): void {}
  close(): void {}
}

beforeEach(() => vi.stubGlobal('EventSource', FakeEventSource))
afterEach(() => {
  vi.unstubAllGlobals()
  atPage('http://localhost:4999/')
})

function entry(over: Partial<{ url: string | null, bindHost: string, bind: string }> = {}): ServerView {
  const { bind = 'lan', bindHost = '0.0.0.0', url = 'http://192.168.1.20:4991', ...rest } = over
  return {
    ...rest,
    id: 'gateway',
    workspaceId: 'default',
    bindHost,
    url,
    status: 'running',
    health: 'healthy',
    portState: 'free',
    pid: 1,
    startedAt: 1,
    exitCode: null,
    exitSignal: null,
    restarts: 0,
    maxRetries: 3,
    lastError: null,
    nextRetryAt: null,
    unhealthySince: null,
    bufferedLines: 0,
    responseMs: 1,
    resources: null,
    adopted: false,
    config: serverSchema({ id: 'gateway', command: 'node', args: [], port: 4991, bind }) as ServerConfig,
    history: { events: [], crashes: 0, lastCrashAt: null, uptimeRatio: 1, restarts: 0 },
  } as unknown as ServerView
}

/** The header's external link — the only `target="_blank"` anchor this component renders. */
async function mountDetail(over: Parameters<typeof entry>[0] = {}) {
  const ServerDetail = (await import('../src/components/ServerDetail.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()

  const wrapper = mount(ServerDetail, {
    props: { server: entry(over), workspaceId: 'default', now: 1 },
    global: { plugins: [router] },
  })
  const link = wrapper.findAll('a').find(node => node.attributes('target') === '_blank')
  if (!link)
    throw new Error('the detail pane rendered no external link')
  return link
}

function atPage(url: string): void {
  (window as unknown as { happyDOM: { setURL: (value: string) => void } }).happyDOM.setURL(url)
}

describe('the server detail link', () => {
  it('uses the hostname the page was reached at, keeping the server’s port', async () => {
    atPage('http://evox1.isthe.top:4999/w/default/servers/gateway')
    const link = await mountDetail()

    expect(link.attributes('href')).toBe('http://evox1.isthe.top:4991')
    // The visible text is the link, so it must not keep the unreachable address either.
    expect(link.text()).toBe('http://evox1.isthe.top:4991')
  })

  it('keeps the LAN address when the viewer is on the machine', async () => {
    atPage('http://localhost:4999/')
    expect((await mountDetail()).attributes('href')).toBe('http://192.168.1.20:4991')
  })

  it('keeps a loopback entry, whatever the page hostname is', async () => {
    atPage('http://evox1.isthe.top:4999/')
    expect((await mountDetail({ bind: 'local', bindHost: '127.0.0.1', url: 'http://127.0.0.1:3000' })).attributes('href'))
      .toBe('http://127.0.0.1:3000')
  })
})
