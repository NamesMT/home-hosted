// @vitest-environment happy-dom
import type { UiStatus } from '@shared/contracts'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

/**
 * A UI dropped into `.ui/` by hand has a `ui.json` with no `files` or `uploadedAt` (the panel adds
 * those on upload). Both UIs showed the absence as a value: stock "0 files", the console
 * "undefined files · 1/1/1970". Absent is never 0 (`AGENTS.md`): the part is left out.
 */
describe('an uploaded UI\'s metadata', () => {
  it('leaves out a file count and upload time the metadata does not record (stock)', async () => {
    const ui: UiStatus = { custom: true, dir: '/tmp/.ui', meta: { name: 'hand-made', version: '1.0.0' } }
    const InterfaceSection = (await import('../src/components/settings/InterfaceSection.vue')).default
    const section = mount(InterfaceSection, { props: { ui, panelVersion: '0.10.3', labelDirty: false, label: 'home-hosted' } })
    expect(section.text()).not.toMatch(/\d files/)
    expect(section.text()).not.toContain('1970')
    section.unmount()
  })

  it('leaves them out in the console too', () => {
    const source = readFileSync(path.join(process.cwd(), 'uis/noc-console/src/views/GlobalSettingsView.vue'), 'utf8')
    expect(source).not.toMatch(/uploadedAt \?\? 0/)
    expect(source).toMatch(/v-if="uiStatus\.meta\.files !== undefined"/)
  })
})
