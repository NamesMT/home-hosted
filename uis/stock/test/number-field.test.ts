// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import NumberField from '../src/components/ui/NumberField.vue'

/**
 * `NumberField` is the only `<input type="number">` in the UIs, and Vue's
 * `vModelText` casts that input's value with `looseToNumber` *before* the model
 * setter sees it — a number, not the string a text input reports. A setter that
 * assumed a string threw `raw.trim is not a function`, which silently discarded
 * every value typed into a numeric field (the port bug). These tests type into a
 * real number input so that can never come back.
 */

function field(options: { initial: number | null, nullable: boolean }) {
  const model = ref<number | null>(options.initial)
  const wrapper = mount(NumberField, {
    props: {
      'modelValue': model.value,
      'nullable': options.nullable,
      'onUpdate:modelValue': (value: number | null) => {
        model.value = value
      },
    },
  })
  const input = wrapper.get('input')
  return {
    model,
    input,
    async type(text: string) {
      ;(input.element as HTMLInputElement).value = text
      await input.trigger('input')
    },
  }
}

describe('numberField', () => {
  it('writes a typed number into the model', async () => {
    const f = field({ initial: 4123, nullable: true })
    await f.type('4321')
    expect(f.model.value).toBe(4321)
  })

  it('writes a number into a non-nullable field too', async () => {
    const f = field({ initial: 500, nullable: false })
    await f.type('700')
    expect(f.model.value).toBe(700)
  })

  it('clears a nullable field to null', async () => {
    const f = field({ initial: 4123, nullable: true })
    await f.type('')
    expect(f.model.value).toBeNull()
  })

  it('marks a cleared non-nullable field invalid instead of zero', async () => {
    const f = field({ initial: 500, nullable: false })
    await f.type('')
    expect(f.model.value).toBeNaN()
    // `NaN` must never be written into a number input: the browser refuses it.
    expect((f.input.element as HTMLInputElement).value).toBe('')
  })

  it('shows the model it was given', () => {
    const f = field({ initial: 4123, nullable: true })
    expect((f.input.element as HTMLInputElement).value).toBe('4123')
  })
})
