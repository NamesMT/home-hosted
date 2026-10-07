// @vitest-environment happy-dom
import type { ServerConfig, ServerView } from '@shared/contracts'
import { serverSchema } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ServerCard from '../src/components/server/ServerCard.vue'

/**
 * The card's "open server" link must be reachable from where the viewer is.
 *
 * A `lan` entry is reported at this machine's LAN address, which nobody arriving over a public
 * hostname or a tunnel can route to — so the link kept pointing into a LAN they are not on. The card
 * is where that link lives, so the wiring (and not just the pure rule in `test/shared/server-url.test.ts`)
 * is what this mounts.
 *
 * happy-dom serves the suite from `localhost`, so each case sets the page URL explicitly.
 */

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

/** The card's external link, told apart from the router link on the label. */
function mountCard(over: Parameters<typeof entry>[0] = {}) {
  const wrapper = mount(ServerCard, {
    props: { server: entry(over), workspaceId: 'default', series: undefined, now: 1 },
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        // `Tip` renders a reka-ui tooltip, which needs a provider the test does not mount.
        Tip: { template: '<span><slot /></span>' },
      },
    },
  })
  const link = wrapper.findAll('a').find(node => node.attributes('target') === '_blank')
  if (!link)
    throw new Error('the card rendered no external link')
  return link
}

function atPage(url: string): void {
  (window as unknown as { happyDOM: { setURL: (value: string) => void } }).happyDOM.setURL(url)
}

afterEach(() => atPage('http://localhost:4999/'))

describe('the server card link', () => {
  it('uses the hostname the page was reached at, keeping the server’s port', () => {
    atPage('http://evox1.isthe.top:4999/w/default/servers')
    const link = mountCard()

    expect(link.attributes('href')).toBe('http://evox1.isthe.top:4991')
    // The link's own text and tooltip must not go on showing the unreachable address.
    expect(link.attributes('title')).toBe('http://evox1.isthe.top:4991')
  })

  it('keeps the LAN address when the viewer is on the machine', () => {
    atPage('http://localhost:4999/')
    expect(mountCard().attributes('href')).toBe('http://192.168.1.20:4991')
  })

  it('keeps a loopback entry, whatever the page hostname is', () => {
    atPage('http://evox1.isthe.top:4999/')
    expect(mountCard({ bind: 'local', bindHost: '127.0.0.1', url: 'http://127.0.0.1:3000' }).attributes('href'))
      .toBe('http://127.0.0.1:3000')
  })

  it('renders no link for an entry with no port', () => {
    atPage('http://evox1.isthe.top:4999/')
    const wrapper = mount(ServerCard, {
      props: { server: entry({ url: null }), workspaceId: 'default', series: undefined, now: 1 },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Tip: { template: '<span><slot /></span>' } } },
    })
    expect(wrapper.findAll('a').filter(node => node.attributes('target') === '_blank')).toHaveLength(0)
  })
})
