// @vitest-environment happy-dom
import type { UiStatus } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

/**
 * Reverting deletes the uploaded UI from disk, with no archive of it.
 *
 * `UiService.revert()` is `fs.rmSync(directory, { recursive: true, force: true })`, so the build
 * someone uploaded is gone — and `AGENTS.md` says a destructive action confirms in a *popover*,
 * never by arming the same button for a second press, because an impatient double click fires it.
 * This section armed its own button: the label flipped to `Confirm revert` and a second click on
 * the same pixels, inside a five-second window, sent `DELETE /api/settings/ui`.
 *
 * Both halves are asserted here: the double click must not reach the API, and the popover's own
 * confirm must still get there — a confirmation that can never be completed is not a fix.
 */
const calls = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  revertUi: async () => {
    calls.count += 1
    return { ok: true, removed: true, ui: { custom: false, dir: '/tmp/.ui', meta: null } }
  },
}))

const CUSTOM: UiStatus = { custom: true, dir: '/tmp/.ui', meta: { name: 'mine', version: '1.0.0', files: 3 } }

async function mountSection(): Promise<ReturnType<typeof mount>> {
  const InterfaceSection = (await import('../src/components/settings/InterfaceSection.vue')).default
  return mount(InterfaceSection, {
    props: { ui: CUSTOM, panelVersion: '0.10.3', labelDirty: false, label: 'home-hosted' },
  })
}

/** The popover is portalled to `document.body`, so its buttons are read from there. */
function bodyButtons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll('button')]
}
function byText(text: string): HTMLButtonElement | undefined {
  return bodyButtons().find(button => button.textContent?.trim() === text)
}

describe('revert to stock confirms before deleting the uploaded UI', () => {
  it('does not fire on a rapid second click on the trigger', async () => {
    calls.count = 0
    const section = await mountSection()

    const trigger = section.findAll('button').find(button => button.text().includes('Revert to stock'))
    expect(trigger, 'the section must offer the revert').toBeDefined()

    // Two clicks in quick succession, the second on the same element — the shape that fired the
    // armed button. Here it only re-toggles the popover, so nothing may reach the API.
    await trigger!.trigger('click')
    await trigger!.trigger('click')
    await nextTick()

    expect(calls.count).toBe(0)
    section.unmount()
  })

  it('deletes only from the confirmation popover, which says what the delete costs', async () => {
    calls.count = 0
    const section = await mountSection()

    const trigger = section.findAll('button').find(button => button.text().includes('Revert to stock'))
    await trigger!.trigger('click')
    await nextTick()

    // The cost is stated where the decision is made: it is a delete, not an archive.
    expect(document.body.textContent).toContain('Delete the uploaded UI?')
    expect(document.body.textContent).toContain('deleted, not archived')

    const confirm = byText('Confirm revert')
    expect(confirm, 'the popover must offer the confirm under its own label').toBeDefined()
    confirm!.click()
    await nextTick()
    await nextTick()

    expect(calls.count).toBe(1)
    section.unmount()
  })
})
