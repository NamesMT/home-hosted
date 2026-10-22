// @vitest-environment happy-dom
import type { ServerConfig, ServerView } from '@shared/contracts'
import { serverSchema } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ServerCard from '../src/components/server/ServerCard.vue'

/**
 * A card must not print "Unhealthy for …" beside its own "not probed" reading.
 *
 * The duration is `now - unhealthySince`, and the card rendered it whenever the timestamp was set.
 * A panel before this release left that timestamp behind when a process exited, so a crashed entry
 * showed a duration that kept counting while nothing was measured. The panel now clears it, but a
 * newer UI is served against an older panel — so the UI must gate the duration on the verdict it
 * displays beside it rather than trusting the field's presence.
 */

function entry(over: Partial<ServerView> = {}): ServerView {
  return {
    id: 'gateway',
    workspaceId: 'default',
    bindHost: '0.0.0.0',
    url: null,
    status: 'running',
    health: 'healthy',
    portState: 'free',
    pid: 1,
    startedAt: 1000,
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
    config: serverSchema({ id: 'gateway', command: 'node', args: [], port: 4991, bind: 'lan' }) as ServerConfig,
    history: { events: [], crashes: 0, lastCrashAt: null, uptimeRatio: 1, restarts: 0 },
    ...over,
  } as unknown as ServerView
}

function render(over: Partial<ServerView>): string {
  return mount(ServerCard, {
    props: { server: entry(over), workspaceId: 'default', series: undefined, now: 1000 + 180_000 },
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        Tip: { template: '<span><slot /></span>' },
      },
    },
  }).text()
}

describe('the card’s unhealthy duration', () => {
  it('shows how long a running entry has been unhealthy', () => {
    const text = render({ status: 'running', health: 'unhealthy', unhealthySince: 1000 })
    expect(text, 'a live unhealthy entry must state its duration').toContain('3m 0s')
  })

  it('says nothing about a duration once the process is gone', () => {
    // The exact shape measured on the built panel before the fix: crashed, health unknown, and the
    // timestamp still standing. A card must not contradict its own "not probed" row.
    const text = render({ status: 'crashed', health: 'unknown', unhealthySince: 1000 })
    expect(text, 'a card that says nothing is probed must not count a probe failure').not.toContain('Unhealthy for')
  })
})
