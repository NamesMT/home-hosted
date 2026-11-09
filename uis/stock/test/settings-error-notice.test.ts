// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SystemNotices from '../src/components/shell/SystemNotices.vue'

/** A broken panel-wide settings.json is shown where a broken workspace config already is. */
describe('the settings.json notice', () => {
  it('names the error and the file to fix', () => {
    const wrapper = mount(SystemNotices, {
      props: {
        control: null,
        configError: null,
        configPath: undefined,
        settingsError: { message: 'cannot parse settings.json: Unexpected token', path: '/srv/hh/.hh/settings.json' },
      },
    })
    expect(wrapper.text()).toContain('cannot parse settings.json')
    expect(wrapper.text()).toContain('/srv/hh/.hh/settings.json')
  })

  it('says nothing when the file is fine, or the panel is older and sends no field', () => {
    for (const settingsError of [null, undefined]) {
      const wrapper = mount(SystemNotices, { props: { control: null, configError: null, configPath: undefined, settingsError } })
      expect(wrapper.text()).toBe('')
    }
  })
})
