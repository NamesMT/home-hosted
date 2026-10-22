// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MetricSpark from '../src/components/telemetry/MetricSpark.vue'
import { t } from '../src/i18n'

/**
 * The label a chart shows when it has no reading is a promise, and nothing tested it.
 *
 * `MetricSpark` renders `emptyHint ?? t('metric.emptyHint')`, and the fallback is
 * "collecting…". On a stopped or crashed entry nothing is being collected, so that sentence
 * reads as a spinner that never finishes — on the one page a person opens to ask *why* the
 * server is down. The card already passed an honest hint for both metrics
 * (`fix(stock): the first run has a button, and the errors land where you look`), and the
 * detail page — which has three of these — passed none, so it was the only surface still
 * promising data on a dead entry.
 *
 * This mounts the component rather than scanning templates: the value is chosen from props at
 * render time, so a source scan could see that a caller wrote `:empty-hint` but not what it
 * resolved to.
 */
function textOf(props: Record<string, unknown>): string {
  const wrapper = mount(MetricSpark, {
    props: {
      label: 'CPU',
      values: [],
      format: (value: number | null) => `${value}%`,
      ...props,
    },
  })
  return wrapper.text()
}

describe('a chart with no reading says why', () => {
  it('falls back to "collecting…" only where data really is on its way', () => {
    // The default is what a *running* entry shows before its first sample; that is the one
    // case where the promise is true, so it must stay the default.
    expect(textOf({})).toContain(t('metric.emptyHint'))
  })

  it('says "not running" when the caller knows the entry is down', () => {
    const text = textOf({ emptyHint: t('metric.notRunning') })
    expect(text).toContain(t('metric.notRunning'))
    // The broken state is the *absence* of the promise, so assert it is gone rather than
    // only asserting the new sentence is there.
    expect(text).not.toContain(t('metric.emptyHint'))
  })

  it('says "not probed" rather than promising a probe that will not come', () => {
    const text = textOf({ emptyHint: t('serverCard.notProbed') })
    expect(text).toContain(t('serverCard.notProbed'))
    expect(text).not.toContain(t('metric.emptyHint'))
  })

  it('shows the reading, and no empty hint at all, once there is a sample', () => {
    const text = textOf({ values: [null, 12], format: (value: number | null) => `${value}%` })
    expect(text).toContain('12%')
    expect(text).not.toContain(t('metric.emptyHint'))
  })
})
