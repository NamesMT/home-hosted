import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every `<MetricSpark>` reads one entry's series, so only its caller knows whether that entry
 * is up — which makes the component's fallback promise ("collecting…") right only by accident.
 * The card stated the hint on all three charts; `ServerDetailView` stated none on any of them,
 * so a crashed or disabled entry's detail page promised data that was never coming, on the one
 * page a person opens to ask why it is down.
 *
 * `metric-spark.test.ts` mounts the component and pins what a hint *does*; it cannot see whether
 * a caller passes one. That is this rule, and it is a template scan for the reason
 * `untranslated-copy.test.ts` and `mobile-layout.test.ts` are: the scan catches the next author,
 * not only the one place that broke.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const srcDir = path.join(root, 'src')

function vueFiles(): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.vue'))
      found.push(path.join(entry.parentPath, entry.name))
  }
  return found.sort()
}

/** Each opening `<MetricSpark …>` tag's attribute text, comments stripped. */
function sparkTags(source: string): string[] {
  const template = /<template>([\s\S]*)<\/template>/.exec(source)?.[1] ?? ''
  const clean = template.replace(/<!--[\s\S]*?-->/g, '')
  return [...clean.matchAll(/<MetricSpark\b([\s\S]*?)\/>/g)].map(match => match[1]!)
}

describe('every chart call site states its empty hint', () => {
  it('finds the call sites, so a broken matcher cannot pass for free', () => {
    const total = vueFiles().reduce((sum, file) => sum + sparkTags(fs.readFileSync(file, 'utf8')).length, 0)
    expect(total).toBeGreaterThanOrEqual(5)
  })

  it('passes an empty hint on every one of them', () => {
    const offenders: string[] = []
    for (const file of vueFiles()) {
      for (const tag of sparkTags(fs.readFileSync(file, 'utf8'))) {
        // `:empty-hint` (bound) or `empty-hint` (literal); either states the intent. The bound
        // form is what every call site uses today, so the leading `:` must be allowed.
        if (!/(?<![\w.-]):?empty-hint=/.test(tag))
          offenders.push(path.basename(file))
      }
    }
    expect(offenders).toEqual([])
  })
})
