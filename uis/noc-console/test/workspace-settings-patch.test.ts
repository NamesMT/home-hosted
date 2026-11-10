import type { DestinationStatusView, NotificationView, ServerDefaults, WorkspaceView } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildWorkspacePatch,
  destinationConfig,
  destinationWire,
  filledDestinations,
  policyConfig,
  repairWorkspaceForm,
} from '../src/lib/workspaceSettingsPatch'

/**
 * The workspace settings patch, which used to live inside `SettingsView.vue`.
 *
 * The rule that decides what a workspace Save writes was reachable only by mounting a 1000-line
 * route, and no test mounted it — so an emptied number box refusing the whole body, or an edited
 * block writing a concurrent change back, could only be found by hand. These tests are the reason
 * the extraction was worth doing.
 */

function defaults(): ServerDefaults {
  return {
    enabled: true,
    autostart: false,
    bind: 'local',
    onPortConflict: 'block',
    logBufferLines: 500,
    restart: { enabled: true, maxRetries: 3, baseDelayMs: 1000, factor: 2, maxDelayMs: 30_000, resetAfterMs: 60_000 },
    health: {
      enabled: true,
      mode: 'port',
      http: { scheme: 'http', allowInvalidCert: false, path: '/', method: 'GET', expectStatusBelow: 400, expectBody: '' },
      intervalMs: 5000,
      timeoutMs: 1500,
      unhealthyThreshold: 3,
      forceRestartAfterMs: 0,
      startTimeoutMs: 20_000,
    },
    stop: { signal: 'SIGTERM', killGroup: true, graceMs: 5000, killPortHolders: false },
  }
}

function destination(overrides: Partial<DestinationStatusView> = {}): DestinationStatusView {
  return {
    id: 'ops',
    kind: 'webhook',
    enabled: true,
    useOwnSettings: false,
    onCrash: true,
    onUnhealthy: true,
    onForcedRestart: true,
    onRecovered: false,
    onHost: true,
    onDdns: true,
    cooldownMs: 120_000,
    chatId: null,
    tokenSet: false,
    url: 'https://example.test/hook',
    method: 'POST',
    format: 'json',
    headers: '',
    ...overrides,
  } as DestinationStatusView
}

function live(overrides: { notifications?: NotificationView } = {}): { logs: WorkspaceView['logs'], notifications: NotificationView } {
  return {
    logs: { persist: true, maxBytes: 2_000_000, keep: 3 },
    notifications: overrides.notifications ?? {
      defaults: { onCrash: true, onUnhealthy: true, onForcedRestart: true, onRecovered: false, onHost: true, onDdns: true, cooldownMs: 120_000 },
      destinations: [destination()],
    },
  }
}

/** The form as the page holds it after being filled from `live`. */
function formFrom(source = live()) {
  return {
    defaults: { ...defaults() },
    logs: { ...source.logs },
    notifications: {
      policy: policyConfig(source.notifications.defaults ?? policyConfig(destination() as never)),
      destinations: (source.notifications.destinations ?? []).map(destinationConfig),
    },
  }
}

describe('policyConfig', () => {
  it('reads an absent onDdns as on', () => {
    // A panel from before DDNS sends no flag; treating absent as "off" would silently disable a
    // notification the panel is still sending.
    expect(policyConfig({ ...destination(), onDdns: undefined } as never).onDdns).toBe(true)
    expect(policyConfig({ ...destination(), onDdns: false } as never).onDdns).toBe(false)
  })
})

describe('destinationConfig', () => {
  it('resolves the nullable columns a Telegram row carries', () => {
    const telegram = destination({ kind: 'telegram', url: null, method: null, format: null, headers: null, chatId: '42' })
    const draft = destinationConfig(telegram)
    // The form has one shape for both kinds, so a null must become the value a save would store.
    expect(draft.url).toBe('')
    expect(draft.method).toBe('POST')
    expect(draft.format).toBe('json')
    expect(draft.headers).toBe('')
    expect(draft.chatId).toBe('42')
  })
})

describe('destinationWire', () => {
  it('writes the policy columns only for a destination that owns its settings', () => {
    // An inheriting destination sends no policy: writing it would make the config say something the
    // page does not mean, and every untouched row would look edited to the diff.
    const inheriting = destinationWire({ ...destinationConfig(destination({ useOwnSettings: false })) })
    expect(inheriting).not.toHaveProperty('onCrash')
    expect(inheriting).not.toHaveProperty('cooldownMs')

    const owning = destinationWire({ ...destinationConfig(destination({ useOwnSettings: true })) })
    expect(owning).toHaveProperty('onCrash', true)
    expect(owning).toHaveProperty('cooldownMs', 120_000)
  })

  it('never writes the derived tokenSet', () => {
    // `tokenSet` is read off the status; putting it in a patch compares a field no box can clear.
    expect(destinationWire(destinationConfig(destination()))).not.toHaveProperty('tokenSet')
  })
})

describe('an untouched form', () => {
  it('writes nothing', () => {
    const source = live()
    const form = formFrom(source)
    const patch = buildWorkspacePatch({
      form,
      defaults: defaults(),
      live: source,
      snapshots: {
        defaults: { ...form.defaults },
        logs: { ...form.logs },
        notifications: { policy: { ...form.notifications.policy }, destinations: form.notifications.destinations.map(entry => ({ ...entry })) },
      },
    })
    expect(patch).toEqual({})
  })
})

describe('a cleared number box', () => {
  it('is repaired to the live value, so it drops out of the diff', () => {
    const source = live()
    const form = formFrom(source)
    ;(form.logs as unknown as Record<string, unknown>).keep = ''

    repairWorkspaceForm(form, defaults(), source)
    expect(form.logs.keep).toBe(3)

    const patch = buildWorkspacePatch({ form, defaults: defaults(), live: source, snapshots: {} })
    expect(patch.logs).toBeUndefined()
  })
})

describe('the destination list', () => {
  it('is replaced only when this form changed it', () => {
    const source = live()
    const form = formFrom(source)
    const filled = form.notifications.destinations.map(entry => ({ ...entry }))

    // Untouched: the list is not re-sent, or a merge would rewrite it in its reduced form.
    const untouched = buildWorkspacePatch({
      form,
      defaults: defaults(),
      live: source,
      snapshots: { notifications: { policy: { ...form.notifications.policy }, destinations: filled } },
    })
    expect(untouched.notifications).toBeUndefined()

    // Removing one travels, because a merge cannot express an absence.
    form.notifications.destinations = []
    const removed = buildWorkspacePatch({
      form,
      defaults: defaults(),
      live: source,
      snapshots: { notifications: { policy: { ...form.notifications.policy }, destinations: filled } },
    })
    expect(removed.notifications).toMatchObject({ destinations: [] })
  })

  it('keeps a destination another client added while the page was open', () => {
    // The form was filled with one destination; another tab added a second. A save that only knows
    // the form's list must not delete the one it never saw.
    const filledWith = live()
    const form = formFrom(filledWith)
    const filled = form.notifications.destinations.map(entry => ({ ...entry }))

    form.notifications.destinations = [...form.notifications.destinations, destinationConfig(destination({ id: 'added-here' }))]
    const current = live({ notifications: { ...filledWith.notifications, destinations: [destination(), destination({ id: 'added-elsewhere' })] } })

    const patch = buildWorkspacePatch({
      form,
      defaults: defaults(),
      live: current,
      snapshots: { notifications: { policy: { ...form.notifications.policy }, destinations: filled } },
    })
    const sent = (patch.notifications as { destinations?: Array<{ id: string }> } | undefined)?.destinations ?? []
    // `mergeReplacedList` reconciles: the other client's entry survives, and the local one arrives.
    expect(sent.map(entry => entry.id).sort()).toEqual(['added-elsewhere', 'added-here', 'ops'])
  })
})

describe('filledDestinations', () => {
  it('reports undefined for a block that was never filled', () => {
    // Absent is not "nothing was there": the second reading makes every save a deletion of everything.
    expect(filledDestinations(undefined)).toBeUndefined()
    expect(filledDestinations({})).toBeUndefined()
    expect(filledDestinations({ destinations: 'nope' })).toBeUndefined()
  })
})
