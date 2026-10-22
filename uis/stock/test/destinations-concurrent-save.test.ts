import { describe, expect, it } from 'vitest'
import { createWorkspaceForm, destinationsPatch, filledDestinations, workspaceBlockSnapshot } from '../src/components/settings/settingsForm'

/**
 * Two clients on one settings page: the second must not be erased by the first.
 *
 * `destinations` is a list the API **replaces**, so whatever a save sends becomes the whole list.
 * The stock UI used to decide "did I change it" by comparing the form against *live* state, so a
 * save from another client looked like this form's own edit — and saving an unrelated toggle wrote
 * back the list it had open, without the destination that had just been added.
 *
 * Measured on the built panel (`dist/cli.js`, real home, real Chromium), two tabs on
 * `/w/default/settings`: tab A opened with `alpha` and toggled a policy switch, tab B added `beta`
 * and saved, then A saved. `settings.json` ended up with `["alpha"]` — `beta` was gone.
 */
function destinationRow(id: string) {
  return {
    kind: 'webhook' as const,
    id,
    enabled: true,
    useOwnSettings: false,
    chatId: null,
    tokenSet: false,
    url: `http://127.0.0.1:9/${id}`,
    method: 'POST' as const,
    format: 'json' as const,
    headers: '',
    onCrash: true,
    onUnhealthy: true,
    onForcedRestart: true,
    onRecovered: false,
    onHost: true,
    onDdns: true,
    cooldownMs: 120_000,
    lastResult: null,
    lastResultAt: null,
  }
}

describe('a replaced destination list survives a concurrent save', () => {
  it('sends no list when the form only edited the policy columns', () => {
    const form = createWorkspaceForm()
    form.destinations = [{
      id: 'alpha',
      kind: 'webhook',
      enabled: true,
      useOwnSettings: false,
      chatId: '',
      tokenSet: false,
      url: 'http://127.0.0.1:9/alpha',
      method: 'POST',
      format: 'json',
      headers: '',
      policy: { onCrash: true, onUnhealthy: true, onForcedRestart: true, onRecovered: false, onHost: true, onDdns: true, cooldownMs: 120_000 },
    }]
    // The block's own baseline: this is what the page was filled with.
    const filled = filledDestinations(workspaceBlockSnapshot(form, 'notifications'))
    expect(filled?.map(entry => entry.id)).toEqual(['alpha'])

    // Another client added `beta` after the page opened.
    const live = [destinationRow('alpha'), destinationRow('beta')]
    expect(destinationsPatch(live, form.destinations, filled)).toBeNull()
  })

  it('keeps a destination another client added, alongside this form\'s own new one', () => {
    const form = createWorkspaceForm()
    const base = {
      id: 'alpha',
      kind: 'webhook' as const,
      enabled: true,
      useOwnSettings: false,
      chatId: '',
      tokenSet: false,
      url: 'http://127.0.0.1:9/alpha',
      method: 'POST' as const,
      format: 'json' as const,
      headers: '',
      policy: { onCrash: true, onUnhealthy: true, onForcedRestart: true, onRecovered: false, onHost: true, onDdns: true, cooldownMs: 120_000 },
    }
    form.destinations = [base]
    const filled = filledDestinations(workspaceBlockSnapshot(form, 'notifications'))
    form.destinations = [...form.destinations, { ...base, id: 'gamma', url: 'http://127.0.0.1:9/gamma' }]

    const patch = destinationsPatch([destinationRow('alpha'), destinationRow('beta')], form.destinations, filled)
    expect(patch).not.toBeNull()
    expect((patch!.destinations as Array<{ id: string }>).map(entry => entry.id)).toEqual(['alpha', 'gamma', 'beta'])
  })

  it('still removes one this form actually deleted', () => {
    const form = createWorkspaceForm()
    const base = {
      id: 'alpha',
      kind: 'webhook' as const,
      enabled: true,
      useOwnSettings: false,
      chatId: '',
      tokenSet: false,
      url: 'http://127.0.0.1:9/alpha',
      method: 'POST' as const,
      format: 'json' as const,
      headers: '',
      policy: { onCrash: true, onUnhealthy: true, onForcedRestart: true, onRecovered: false, onHost: true, onDdns: true, cooldownMs: 120_000 },
    }
    form.destinations = [base, { ...base, id: 'beta', url: 'http://127.0.0.1:9/beta' }]
    const filled = filledDestinations(workspaceBlockSnapshot(form, 'notifications'))
    form.destinations = [base]

    const patch = destinationsPatch([destinationRow('alpha'), destinationRow('beta')], form.destinations, filled)
    expect(patch).toEqual({ destinations: [expect.objectContaining({ id: 'alpha' })] })
  })

  it('refuses to send a list the block was never filled with', () => {
    // A never-filled block holds `[]`, and `[]` on a replaced list means "delete every destination".
    expect(filledDestinations(undefined)).toBeUndefined()
    expect(destinationsPatch([destinationRow('alpha')], [], undefined)).toBeNull()
  })
})
