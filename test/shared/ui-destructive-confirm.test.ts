import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateRegion } from '../helpers/strip-comments'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * A destructive action confirms in a popover, never by arming the same button.
 *
 * `AGENTS.md` states it: *"a destructive action one click away confirms in a popover, never by
 * arming the same button for a second press — an impatient double click fires an armed button."*
 * Both UIs carry the popover component for it (`ConfirmButton`), and every settings section uses
 * it — except the one that deletes the uploaded UI.
 *
 * `InterfaceSection.vue` flipped its own label (`Revert to stock` → `Confirm revert`) and, on a
 * second click anywhere in a five-second window, called `DELETE /api/settings/ui`. That route
 * `rmSync`s `$HHOSTED_HOME/.hh/.ui` with no archive, so an impatient double click destroys a build
 * the person may have no copy of. The *same action* in `noc-console` already used `ConfirmButton`,
 * so this is one surface not following a rule its twin follows.
 *
 * The label-and-flag shape is the defect, not the spelling: so this reads the **shape** out of each
 * `.vue` — a button whose own label is chosen by a confirmation flag, and an action function that
 * raises that flag from the same click and then performs the action. A mount can only see the
 * component someone thought to mount; the next armed button would be written in a file no test
 * mounts, which is exactly how this one survived.
 */
function vueFiles(): string[] {
  const out: string[] = []
  for (const ui of ['stock', 'noc-console']) {
    const dir = path.join(root, 'uis', ui, 'src')
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.vue'))
        out.push(path.join(entry.parentPath, entry.name))
    }
  }
  return out.sort()
}

const rel = (file: string): string => path.relative(root, file).replaceAll('\\', '/')

/** A button whose visible label is picked by a confirmation flag: the armed-button shape. */
function armedLabels(source: string): string[] {
  // The template region, not everything from the root tag onward: a `<script>` above it is not markup.
  const template = templateRegion(source)
  const found: string[] = []
  for (const button of template.matchAll(/<(?:button|AppButton)\b([^>]*)>([\s\S]{0,400}?)<\/(?:button|AppButton)>/g)) {
    for (const slot of (button[2] ?? '').matchAll(/\{\{([\s\S]*?)\}\}/g)) {
      // `confirmingRevert ? … : …` — the same control, renamed, waiting for a second press.
      // `props.confirmLabel`/`confirmLabel` is the *separate* button inside the popover, which is
      // the pattern the rule asks for, so a bare identifier without a ternary is not a finding.
      if (/\bconfirming\w*\s*\?/.test(slot[1] ?? '') || /\bconfirm\w*\s*\?\s*t\(/.test(slot[1] ?? ''))
        found.push(`{{ ${(slot[1] ?? '').trim().replace(/\s+/g, ' ')} }}`)
    }
  }
  return found
}

/**
 * Every function-shaped thing in a `<script>`, with its body read to the matching brace.
 *
 * A handler is written as `function askRemove() {}`, `const askRemove = (): void => {}` or
 * `const askRemove = e => {}`, and Vue treats all three as the same click handler. Matching only the
 * declaration form is how this guard passed a planted arrow handler (`WorkspacePicker.vue`) that
 * raised its flag and emitted the removal in one click — the exact shape its comment claims to fail.
 */
function functions(script: string): Array<{ name: string, body: string }> {
  const found: Array<{ name: string, body: string }> = []
  const heads = [
    /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*\{/g,
    /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*(?::[^{}=]+)?=>\s*\{/g,
    /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?\w+\s*=>\s*\{/g,
  ]
  const seen = new Set<number>()
  for (const head of heads) {
    for (const match of script.matchAll(head)) {
      if (seen.has(match.index!))
        continue
      seen.add(match.index!)
      const start = match.index! + match[0].length
      let depth = 1
      let index = start
      for (; index < script.length && depth > 0; index++) {
        if (script[index] === '{')
          depth++
        else if (script[index] === '}')
          depth--
      }
      found.push({ name: match[1]!, body: script.slice(start, index) })
    }
  }
  return found
}

/**
 * A function that raises an arming flag and then calls the destructive action it guards.
 *
 * Reading the function body is what separates "two honest answers in one popover" from "the same
 * button again": the popover's confirm handler does not raise anything, it just acts.
 */
function armingActions(source: string): string[] {
  const script = source.slice(0, source.indexOf('</script>'))
  // Any ref whose name carries the word: `confirmingRevert` and `confirmArmed` are the same idea,
  // and a fixed list of spellings is a guard the next author trips over by renaming a ref — measured
  // on the re-break, where `confirmArmed` walked past a `confirming\w*|armed\w*` list. The type
  // argument is optional: `ref<boolean>(false)` is the same ref, and it walked past the matcher.
  const flags = [...script.matchAll(/const\s+(\w*(?:confirm|arm)\w*)\s*=\s*(?:shallowRef|ref)\s*(?:<[^>]*>)?\(/gi)]
    .map(match => match[1]!)
  if (flags.length === 0)
    return []
  const found: string[] = []
  for (const { name, body } of functions(script)) {
    const raised = flags.filter(flag => new RegExp(`\\b${flag}(?:\\.value)?\\s*=\\s*true`).test(body))
    if (raised.length === 0)
      continue
    // The action it guards is whatever the same function calls after the flag, so a handler that
    // only opens a confirmation is not a finding. The emit is the third spelling: a child component
    // hands the destructive action to its parent, which then calls the API.
    const acted = /(?:await\s+)?(?:api|control|workspace|props)\??\.\w+\(/.test(body)
      || /\b(?:revertUi|uploadUi|remove|delete|destroy|clear|forget)\w*\s*\(/.test(body)
      || /\bemit\s*\(\s*['"](?:remove|delete|destroy|clear|forget|revert)\w*['"]/.test(body)
    if (acted)
      found.push(`${name} raises ${raised.join(', ')} and then acts`)
  }
  return found
}

/**
 * The armed idiom, with no name to go on: the first press raises a flag and returns, the second
 * press performs the destructive action.
 *
 * `armingActions` above needs the flag to be called `confirm*`/`arm*`, so an armed button with a
 * differently-named flag is a shape it cannot see — measured on the pre-fix `InterfaceSection.vue`,
 * whose flag was `confirmingRevert` and would have passed just as well as `asking`. This reads the
 * branch instead: `if (!flag.value) { flag.value = true; … return }` followed by the action, which
 * is the double-click hazard itself and is identical however the ref is spelled. The historical
 * defect is reproduced from git in the anti-vacuity test below, so this is pinned against a real
 * one, not a shape invented for the scan.
 */
function armedFirstPress(source: string): string[] {
  const script = source.slice(0, source.indexOf('</script>'))
  const acted = /(?:await\s+)?(?:api|control|workspace|props)\??\.\w+\(/
  const found: string[] = []
  for (const { name, body } of functions(script)) {
    for (const branch of body.matchAll(/if\s*\(\s*!\s*(\w+)(?:\.value)?\s*\)\s*\{([\s\S]*?)\breturn\b/g)) {
      const flag = branch[1]!
      if (!new RegExp(`\\b${flag}(?:\\.value)?\\s*=\\s*true\\b`).test(branch[2]!))
        continue
      const after = body.slice(branch.index! + branch[0].length)
      // The action has to be in the *second* press: a branch that acts before returning is a
      // guarded no-op, not an armed button.
      if (acted.test(branch[2]!))
        continue
      if (acted.test(after))
        found.push(`${name}: the first press raises \`${flag}\` and returns, the second acts`)
    }
  }
  return found
}

describe('a destructive action confirms in a popover, not by arming its own button', () => {
  it('finds the components to check, so a broken glob cannot pass for free', () => {
    // Anti-vacuity: every assertion below is a "no offenders" list, which an empty file set would
    // satisfy. Both UIs are Vue apps with dozens of components.
    expect(vueFiles().length).toBeGreaterThan(60)
  })

  it('never renames a button into its own confirmation', () => {
    const offenders = vueFiles()
      .flatMap(file => armedLabels(fs.readFileSync(file, 'utf8')).map(found => `${rel(file)}: ${found}`))
    expect(offenders, 'an armed button puts the destructive action under the second click of a double click').toEqual([])
  })

  it('never raises an arming flag and performs the action in the same click', () => {
    const offenders = vueFiles()
      .flatMap(file => armingActions(fs.readFileSync(file, 'utf8')).map(found => `${rel(file)}: ${found}`))
    expect(offenders, 'the second press is a different target — the popover — or it is a double click away').toEqual([])
  })

  it('never arms on the first press and acts on the second, under any flag name', () => {
    const offenders = vueFiles()
      .flatMap(file => armedFirstPress(fs.readFileSync(file, 'utf8')).map(found => `${rel(file)}: ${found}`))
    expect(offenders, 'an armed button needs no `confirm` in its name to fire on a double click').toEqual([])
  })

  /**
   * Every way a handler that arms can be *written*, not the one spelling the corpus happens to use.
   *
   * The scan above is a "no offenders" list, so a matcher that sees nothing is indistinguishable
   * from a corpus that is clean. Measured on `WorkspacePicker.vue`: a `const askRemove = (): void
   * => { confirming.value = true; emit('remove', …) }` left the suite green, because the matcher
   * read `function` declarations only. Each shape below is a handler no author would call unusual.
   */
  it('sees every spelling of an arming handler, so a green run means something', () => {
    const shapes: Record<string, string> = {
      'a function declaration': 'function askRemove(): void {\n  confirming.value = true\n  void api.deleteWorkspace(id)\n}',
      'an arrow const': 'const askRemove = (): void => {\n  confirming.value = true\n  void api.deleteWorkspace(id)\n}',
      'an async arrow with a bare parameter': 'const askRemove = async (workspace) => {\n  confirming.value = true\n  await api.deleteWorkspace(workspace.id)\n}',
      'a handler that hands the action to its parent': 'const askRemove = (): void => {\n  confirming.value = true\n  emit(\'remove\', selected)\n}',
      'a typed ref': 'const confirming = ref<boolean>(false)\nfunction askRemove(): void {\n  confirming.value = true\n  void api.deleteWorkspace(id)\n}',
    }
    const missed = Object.entries(shapes)
      .filter(([, source]) => armingActions(`<script setup lang="ts">\nconst confirming = ref(false)\nconst workspaceId = ref('x')\n${source}\n</script>`).length === 0)
      .map(([shape]) => shape)
    expect(missed, 'a handler shape the scan cannot see is the next armed button').toEqual([])

    // And the honest ones stay clear: the popover's own confirm acts without arming anything.
    const popover = '<script setup lang="ts">\nconst open = ref(false)\nfunction confirm(): void {\n  open.value = false\n  emit(\'confirm\')\n}\n</script>'
    expect(armingActions(popover)).toEqual([])
  })

  /**
   * The name-agnostic scan, against the defect it was written from: the revert handler in
   * `InterfaceSection.vue` before `c83a9e6`, with its flag renamed to `asking`.
   *
   * The historic flag was `confirmingRevert`, so the *name* scan catches that one too — the rename
   * is what makes this a test of the branch shape rather than of a spelling. The real file is
   * planted with it in the test below; this is the same handler written out, so the failure names
   * the shape even if that file is ever rewritten.
   */
  it('sees the armed branch even when the flag is not called `confirm…`', () => {
    const armed = [
      'const asking = ref(false)',
      'async function revert(): Promise<void> {',
      '  if (!asking.value) {',
      '    asking.value = true',
      '    setTimeout(() => { asking.value = false }, 5000)',
      '    return',
      '  }',
      '  asking.value = false',
      '  busy.value = true',
      '  try { await api.revertUi() } finally { busy.value = false }',
      '}',
    ].join('\n')
    expect(armedFirstPress(`<script setup lang="ts">\n${armed}\n</script>`)).toHaveLength(1)

    // A handler that guards itself with a flag but never arms a *second* press is not this defect:
    // `if (!canSubmit) { notice = '…'; return }` is a refusal, and it must stay clear.
    const refusal = [
      'function submit(): void {',
      '  if (!canSubmit.value) {',
      '    error.value = true',
      '    return',
      '  }',
      '  void api.save()',
      '}',
    ].join('\n')
    expect(armedFirstPress(`<script setup lang="ts">\n${refusal}\n</script>`)).toEqual([])
  })

  it('fails the armed branch planted back into the component that was fixed', () => {
    const file = path.join(root, 'uis', 'stock', 'src', 'components', 'settings', 'InterfaceSection.vue')
    const source = fs.readFileSync(file, 'utf8')
    expect(source, 'the fix is still in place: the revert delegates to ConfirmButton').toContain('ConfirmButton')
    // The pre-fix handler, put back where it was, with the flag renamed and the popover's template
    // left alone: nothing but the branch shape marks this as armed.
    const armed = source.replace(
      /async function revert\(\): Promise<void> \{/,
      'async function revert(): Promise<void> {\n  if (!asking.value) {\n    asking.value = true\n    return\n  }\n  asking.value = false\n  void api.revertUi()',
    )
    expect(armed, 'the revert handler was found to plant into').not.toBe(source)
    expect(armedFirstPress(armed), 'a planted armed revert must be visible to this scan').toHaveLength(1)
  })
})
