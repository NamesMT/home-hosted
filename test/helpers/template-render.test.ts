import { describe, expect, it } from 'vitest'
import { isGeometry, openingTags, renderedExpressions } from './template-render'

/**
 * The two render guards share this reader, so its claims are about template syntax, not about a
 * field. Each case below is a shape an author writes, and the ones that matter are the pairs: a
 * rule that matched one spelling would let the other through at every call site.
 */
describe('what a template renders', () => {
  it('collects interpolation, short bound attributes and the long `v-bind:` form alike', () => {
    const template = [
      '<p>{{ readings.tempCelsius }}</p>',
      '<Gauge :display="readings.tempCelsius" />',
      '<Gauge v-bind:display="readings.tempCelsius" />',
      '<p v-text="readings.tempCelsius" />',
      '<p v-html="readings.tempCelsius" />',
    ].join('\n')
    expect(renderedExpressions(template).map(expression => expression.text))
      .toEqual(Array.from({ length: 5 }).fill('readings.tempCelsius'))
    expect(renderedExpressions(template).map(expression => expression.attribute))
      .toEqual([null, ':display', 'v-bind:display', 'v-text', 'v-html'])
  })

  it('skips an attribute bound to nothing, which renders nothing', () => {
    expect(renderedExpressions('<Gauge :display="" />')).toEqual([])
  })
})

describe('what counts as geometry rather than text', () => {
  /**
   * `:style`/`:class` and their long forms are the same binding. The short-only pattern read
   * `v-bind:class` as text, so a bar's width written the long way was flagged by one scan and a
   * `?? 0` that only picks a colour was reported by the other — the same rule, two answers.
   */
  it('treats both spellings of a style or class binding as geometry', () => {
    for (const attribute of [':style', ':class', 'v-bind:style', 'v-bind:class']) {
      const [expression] = renderedExpressions(`<i ${attribute}="row.tone" />`)
      expect(expression?.attribute, attribute).toBe(attribute)
      expect(isGeometry(expression!), attribute).toBe(true)
    }
  })

  it('counts everything a person reads — including the argument-less object form', () => {
    for (const attribute of [null, ':value', ':display', ':title', 'v-bind:value', 'v-text', 'v-html', 'v-bind']) {
      const template = attribute === null ? '<p>{{ row.tone }}</p>' : `<i ${attribute}="row.tone" />`
      const [expression] = renderedExpressions(template)
      expect(expression, attribute ?? 'interpolation').toBeDefined()
      expect(isGeometry(expression!), attribute ?? 'interpolation').toBe(false)
    }
  })
})

/**
 * A component's opening tags, in both spellings of "no children".
 *
 * `uis/stock/test/metric-spark-hint.test.ts` and three siblings matched `/<X\b([\s\S]*?)\/>/`,
 * which reads a self-closing call site and treats `<X …></X>` as none at all. Measured: a dropped
 * `:empty-hint` on a paired `<MetricSpark …></MetricSpark>` left the file green.
 */
describe('a component call site', () => {
  const markup = [
    '<MetricSpark :label="a" :empty-hint="b" />',
    '<MetricSpark :label="c"></MetricSpark>',
    '<MetricSpark v-if="count > 1" :label="d" />',
    '<MetricSparkLine :label="e" />',
  ].join('\n')

  it('reads the paired form as well as the self-closing one', () => {
    expect(openingTags(markup, 'MetricSpark')).toHaveLength(3)
    expect(openingTags(markup, 'MetricSpark')[1]).toContain(':label="c"')
  })

  it('reads a tag by its own `>`, not the first one in an attribute', () => {
    expect(openingTags(markup, 'MetricSpark')[2]).toBe('<MetricSpark v-if="count > 1" :label="d" />')
  })

  it('does not read a longer component name as this one', () => {
    expect(openingTags(markup, 'MetricSpark').join('\n')).not.toContain(':label="e"')
  })

  it('names the hole the self-closing matcher had', () => {
    // Kept as evidence, not as a guard: the retired matcher must stay blind to the paired form.
    const retired = /<MetricSpark\b([\s\S]*?)\/>/g
    expect([...markup.matchAll(retired)]).toHaveLength(2)
  })
})
