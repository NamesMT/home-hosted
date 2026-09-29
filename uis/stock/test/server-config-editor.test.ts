// @vitest-environment happy-dom
import type { ServerConfig } from '@shared/contracts'
import { serverSchema } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import ServerConfigEditor from '../src/components/server/ServerConfigEditor.vue'

/** The workspace an entry belongs to; every action is scoped to it. */
const workspaceId = 'default'

/**
 * The editor keeps its own copy of the entry so a live state frame does not wipe
 * unsaved edits. A *shallow* copy of `health` left its nested `http` aliased to
 * the live config, so typing into "Healthy below status" mutated the very object
 * the frame guard compared against: the next frame then looked like a genuine
 * server-side change and reset the whole form — labels and every other group
 * included — a few seconds after the edit.
 */

/** A valid entry, as the panel serves it (http probing, so the field is visible). */
function demoConfig(): ServerConfig {
  const parsed = serverSchema({
    id: 'demo',
    label: 'demo',
    command: 'node',
    args: ['server.js'],
    port: 4000,
    health: { mode: 'http', http: { path: '/healthz' } },
  })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return parsed as ServerConfig
}

function inputFor(wrapper: ReturnType<typeof mount>, label: string) {
  const labelEl = wrapper.findAll('label').find(node => node.text().trim() === label)
  if (!labelEl)
    throw new Error(`no field labelled ${label}`)
  return wrapper.get(`#${labelEl.attributes('for')}`)
}

function valueOf(wrapper: ReturnType<typeof mount>, label: string): string {
  return (inputFor(wrapper, label).element as HTMLInputElement).value
}

describe('server config editor', () => {
  it('never writes into the live config it was given', async () => {
    const config = demoConfig()
    const wrapper = mount(ServerConfigEditor, { props: { serverId: 'demo', workspaceId, config } })

    await inputFor(wrapper, 'Healthy below status').setValue('500')

    expect(config.health.http.expectStatusBelow).toBe(400)
    expect(config.label).toBe('demo')
  })

  it('keeps every edit when the same config is re-sent', async () => {
    const wrapper = mount(ServerConfigEditor, { props: { serverId: 'demo', workspaceId, config: demoConfig() } })

    await inputFor(wrapper, 'Healthy below status').setValue('500')
    await inputFor(wrapper, 'Label').setValue('renamed')

    // A state frame carries the same values again, as a fresh object.
    await wrapper.setProps({ config: demoConfig() })

    expect(valueOf(wrapper, 'Healthy below status')).toBe('500')
    expect(valueOf(wrapper, 'Label')).toBe('renamed')
  })

  it('takes a real server-side change as one', async () => {
    const wrapper = mount(ServerConfigEditor, { props: { serverId: 'demo', workspaceId, config: demoConfig() } })

    await wrapper.setProps({ config: { ...demoConfig(), label: 'renamed-elsewhere' } })

    expect(valueOf(wrapper, 'Label')).toBe('renamed-elsewhere')
  })

  it('lists a health edit among what Save would write', async () => {
    const wrapper = mount(ServerConfigEditor, { props: { serverId: 'demo', workspaceId, config: demoConfig() } })

    await inputFor(wrapper, 'Healthy below status').setValue('500')

    const review = wrapper.findAll('button').find(button => button.text().includes('unsaved'))
    expect(review).toBeDefined()
    await review!.trigger('click')

    // The review dialog portals into the body.
    expect(document.body.textContent).toContain('health.http.expectStatusBelow')
    wrapper.unmount()
  })
})
