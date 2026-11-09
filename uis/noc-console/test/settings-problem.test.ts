// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SettingsProblem from '../src/components/SettingsProblem.vue'

describe('the settings.json banner', () => {
  it('names the error and the file to fix', () => {
    const wrapper = mount(SettingsProblem, { props: { problem: { message: 'cannot parse settings.json', path: '/srv/hh/.hh/settings.json' } } })
    expect(wrapper.text()).toContain('cannot parse settings.json')
    expect(wrapper.text()).toContain('/srv/hh/.hh/settings.json')
  })

  it('renders nothing when the file is fine', () => {
    expect(mount(SettingsProblem, { props: { problem: null } }).text()).toBe('')
  })
})
