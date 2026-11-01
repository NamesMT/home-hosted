import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateRegion } from '../helpers/strip-comments'
import { openingTags } from '../helpers/template-render'

/**
 * A destructive action confirms in a popover, and the popover says what it destroys.
 *
 * `ConfirmButton` falls back to `` `${confirmLabel}?` `` when no `title` is given, so a confirmation
 * written without one reads only **"confirm remove?"** — the person is told a thing will be removed
 * and not what removing it costs.
 *
 * This was two per-UI files of the same rule, and each carried its own narrowings. Measured, every
 * one of them green on a planted defect:
 *
 *  - stock matched `/<ConfirmButton[\s\S]{0,900}?\/>/`, so a paired `<ConfirmButton …>
 *    </ConfirmButton>` — legal in Vue — was not a call site at all: a dropped `title` passed;
 *  - the same slice ran on to the *next* `/>`, so a `title` on a following sibling satisfied the
 *    button before it — measured with a `<ToneBadge :title>` after the confirmation;
 *  - stock read `src/components/settings/` and noc-console read `src/views/` plus the files
 *    directly in `src/components/`, so a confirmation anywhere else was invisible — measured with
 *    a nested `src/components/panels/`, and with a `title` dropped in `stock/src/views/`;
 *  - stock exempted a whole *file* (`BackupsSection.vue`), so a second, title-less confirmation
 *    added elsewhere in it was excused. A row states the cost of one button, not of its file;
 *  - noc-console's plain-control half matched the literal word after `<button>`, so the translated
 *    `{{ t('common.remove') }}` every UI actually writes was no control at all.
 *
 * One rule, both UIs, through the shared readers: a tag ends at its own `>`, and a paired call site
 * is the same call site as a self-closing one.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

/** Every `.vue` in either UI, by path — the whole `src`, because a confirmation is not a folder. */
function vueFiles(): Array<{ ui: string, file: string, rel: string }> {
  const found: Array<{ ui: string, file: string, rel: string }> = []
  for (const ui of ['stock', 'noc-console']) {
    const srcDir = path.join(root, 'uis', ui, 'src')
    for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
      // The component itself declares the fallback; it is not a call site.
      if (!entry.isFile() || !entry.name.endsWith('.vue') || entry.name === 'ConfirmButton.vue')
        continue
      const file = path.join(entry.parentPath, entry.name)
      found.push({ ui, file, rel: path.relative(root, file).replaceAll('\\', '/') })
    }
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel))
}

/** One attribute's value on an opening tag. */
function attribute(tag: string, name: string): string | null {
  return new RegExp(`(?:^|\\s):?${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1] ?? null
}

/** The label that identifies a confirmation, in the spelling its call site uses. */
const labelOf = (tag: string): string => attribute(tag, 'label') ?? '?'

/**
 * A confirmation whose surrounding row already states the cost, keyed to the label it carries.
 *
 * Both UIs show the backup's name, size and date in the row beside this button, so "confirm delete"
 * is unambiguous there. Keying on the label rather than the file is what keeps a second button in
 * the same file from inheriting the exemption.
 */
const CONTEXTUAL = new Map([
  ['stock#t(\'common.delete\')', 'the backup row shows the archive name, size and date beside the button'],
  ['noc-console#delete', 'the backup row shows the archive name, size and date beside the button'],
])

/** What a control renders: its interpolations unwrapped, its tags and quotes gone. */
function renderedText(body: string): string {
  return body
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{\{|\}\}/g, ' ')
    .replace(/['"`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A label that names a destructive act, in any translation the UI ships. */
const DESTRUCTIVE_WORD = /\b(?:remove|removes|delete|deletes|forget|revoke|clear|disable)\b/i

/**
 * Whether a click performs the action, rather than opening the surface that confirms it.
 *
 * Every assignment is stripped first: `confirmClear = true` and `mode = 'remove'` leave nothing
 * callable, while `clearBuffer`, `removeAccount(account)` and `act('stop')` leave a call or a bare
 * handler reference. This is what separates a trigger from the act without needing a name: a click
 * that only raises state cannot destroy anything.
 */
function actsOnClick(handler: string): boolean {
  const rest = handler.replace(/\w+(?:\.\w+)*\s*=[^,;]+/g, '').trim()
  return /\w\s*\(/.test(rest) || /^[\w$.]+$/.test(rest)
}

/**
 * The template spans that *are* a confirmation surface, by depth.
 *
 * A control inside one of these is the second click of a confirmation, which is the pattern the rule
 * asks for — `ConfirmButton`'s own popover, and the `Modal`/`Dialog` a view opens before acting. The
 * span is counted rather than sliced: a `>` inside a bound attribute is data, and an unclosed
 * ancestor would otherwise swallow the rest of the file.
 */
const CONFIRMING = new Set(['ConfirmButton', 'Modal', 'Dialog', 'PopoverContent'])

interface Span { start: number, end: number }

function confirmingRegions(template: string): Span[] {
  interface Open { start: number, confirming: boolean }
  const spans: Span[] = []
  const stack: Open[] = []
  for (const match of template.matchAll(/<(\/?)([A-Z][\w.-]*)/gi)) {
    let end = match.index + match[0].length
    // The tag ends at its own `>`, skipping any inside a quoted value.
    for (; end < template.length; end += 1) {
      const char = template[end]!
      if (char === '"' || char === '\'') {
        const close = template.indexOf(char, end + 1)
        if (close < 0) {
          end = -1
          break
        }
        end = close
        continue
      }
      if (char === '>')
        break
    }
    if (end < 0)
      break
    const tag = template.slice(match.index, end + 1)
    const confirming = CONFIRMING.has(match[2]!) || /role\s*=\s*"dialog"/.test(tag)
    if (match[1] === '/') {
      const open = stack.pop()
      if (open?.confirming)
        spans.push({ start: open.start, end: end + 1 })
      continue
    }
    if (tag.endsWith('/>')) {
      if (confirming)
        spans.push({ start: match.index, end: end + 1 })
      continue
    }
    stack.push({ start: match.index, confirming })
  }
  for (const open of stack) {
    if (open.confirming)
      spans.push({ start: open.start, end: template.length })
  }
  return spans
}

/** Plain controls outside a confirmation with a destructive label and a click that acts. */
function unconfirmedDestructive(file: string): Array<{ label: string, handler: string }> {
  const template = templateRegion(fs.readFileSync(file, 'utf8'))
  const confirmed = confirmingRegions(template)
  const found: Array<{ label: string, handler: string }> = []
  for (const match of template.matchAll(/<(button|AppButton)\b/g)) {
    // The opening tag, to its own `>` — a `:title` ternary contains one.
    let openEnd = match.index + match[0].length
    for (; openEnd < template.length; openEnd += 1) {
      const char = template[openEnd]!
      if (char === '"' || char === '\'') {
        const close = template.indexOf(char, openEnd + 1)
        if (close < 0) {
          openEnd = -1
          break
        }
        openEnd = close
        continue
      }
      if (char === '>')
        break
    }
    if (openEnd < 0)
      break
    const open = template.slice(match.index, openEnd + 1)
    if (open.endsWith('/>'))
      continue
    const close = template.indexOf(`</${match[1]}>`, openEnd)
    if (close < 0)
      continue
    if (confirmed.some(span => match.index >= span.start && match.index < span.end))
      continue
    const handler = attribute(open, 'click') ?? /@click\s*=\s*"([^"]*)"/.exec(open)?.[1]
    if (handler === null || handler === undefined || !actsOnClick(handler))
      continue
    const text = renderedText(template.slice(openEnd + 1, close))
    if (!DESTRUCTIVE_WORD.test(text))
      continue
    found.push({ label: text, handler })
  }
  return found
}

/**
 * The exceptions, each a recorded answer rather than an oversight.
 *
 * Both DDNS sections edit a *draft*: `removeAccount` and `removeDomain` filter a local copy, the
 * section's own `reset` rebuilds it from the block the form was filled with, and nothing leaves the
 * panel until save — the same recorded decision the proxy's route rows make. The console's
 * `clear buffer` empties this client's log ring, not a stored file; the stored-log delete beside it
 * is the confirmation.
 *
 * Keyed to the handler as well as the label, because two rows in one section carry one word.
 */
const NO_POPOVER = new Map([
  ['uis/stock/src/components/settings/DdnsSection.vue#t( common.remove )#removeAccount(account)', 'a draft account row: `reset` restores it, and nothing leaves the panel until save'],
  ['uis/stock/src/components/settings/DdnsSection.vue#t( common.remove )#removeDomain(domain)', 'a draft hostname row: `reset` restores it, and nothing leaves the panel until save'],
  ['uis/noc-console/src/components/ServerDetail.vue#clear buffer#clearBuffer', 'it empties this UI\'s log ring, not a stored file; the stored-log delete confirms'],
])

describe('a destructive action confirms in a popover that names its cost', () => {
  it('finds both UIs and their confirmations, so a broken walk cannot pass for free', () => {
    const files = vueFiles()
    // Anti-vacuity: the assertions below are "no offenders" lists, which an empty set would satisfy.
    expect(new Set(files.map(file => file.ui)).size, 'both UIs must be read').toBe(2)
    expect(files.length, 'both UIs are Vue apps with dozens of components').toBeGreaterThan(60)
    const total = files.reduce((sum, file) => sum + openingTags(templateRegion(fs.readFileSync(file.file, 'utf8')), 'ConfirmButton').length, 0)
    expect(total, 'the two UIs hold many destructive confirmations').toBeGreaterThanOrEqual(15)
  })

  it('states what the action costs, unless the row beside it does', () => {
    const silent: string[] = []
    for (const { ui, file, rel } of vueFiles()) {
      for (const tag of openingTags(templateRegion(fs.readFileSync(file, 'utf8')), 'ConfirmButton')) {
        // A `ConfirmButton` with no `confirm-label` confirms nothing; it is a plain button.
        if (attribute(tag, 'confirm-label') === null)
          continue
        if (attribute(tag, 'title') !== null)
          continue
        if (CONTEXTUAL.has(`${ui}#${labelOf(tag)}`))
          continue
        silent.push(`${rel}: ${labelOf(tag)}`)
      }
    }
    expect(silent, 'a confirmation that states no consequence reads as "confirm remove?"').toEqual([])
  })

  it('keeps each exemption to the label it was written for', () => {
    expect([...CONTEXTUAL.keys()]).toEqual(['stock#t(\'common.delete\')', 'noc-console#delete'])
  })

  it('has no destructive control that acts without a confirmation around it', () => {
    const offenders: string[] = []
    for (const { file, rel } of vueFiles()) {
      for (const { label, handler } of unconfirmedDestructive(file)) {
        if (NO_POPOVER.has(`${rel}#${label}#${handler}`))
          continue
        offenders.push(`${rel}: ${label.slice(0, 60)} -> ${handler}`)
      }
    }
    expect(offenders, 'a destructive action one click away must confirm in a popover').toEqual([])
  })

  it('keeps each recorded exception to the control it was written for', () => {
    expect([...NO_POPOVER.keys()]).toEqual([
      'uis/stock/src/components/settings/DdnsSection.vue#t( common.remove )#removeAccount(account)',
      'uis/stock/src/components/settings/DdnsSection.vue#t( common.remove )#removeDomain(domain)',
      'uis/noc-console/src/components/ServerDetail.vue#clear buffer#clearBuffer',
    ])
  })

  /**
   * The matcher's own spelling, against each shape the per-UI files could not see.
   *
   * A paired call site, a `>` inside a bound attribute, a sibling's `title`, and a translated plain
   * control: each is one call site or one label, written the way an author actually writes it.
   */
  it('reads a call site to its own `>`, a label as rendered, and a handler by what it calls', () => {
    // Paired and self-closing are one call site.
    const paired = '<ConfirmButton label="remove" confirm-label="confirm" @confirm="x"></ConfirmButton>'
    expect(openingTags(`<template>${paired}</template>`, 'ConfirmButton')).toHaveLength(1)
    // A `>` inside a bound attribute does not end the tag early.
    const [ternary] = openingTags('<template><ConfirmButton label="a" :title="a > b ? \'x\' : \'y\'" /></template>', 'ConfirmButton')
    expect(attribute(ternary!, 'title')).toBe('a > b ? \'x\' : \'y\'')
    // A sibling's `title` is not this call site's title.
    const [plain] = openingTags(`<template><ConfirmButton label="remove" confirm-label="confirm" />
      <ToneBadge :title="t('x')" /></template>`, 'ConfirmButton')
    expect(attribute(plain!, 'title')).toBeNull()

    // A translated label names the act; a handler that only raises state does not perform it.
    expect(renderedText('<Trash2 class="size-3" />{{ t(\'common.remove\') }}')).toContain('common.remove')
    expect(actsOnClick('confirmClear = true')).toBe(false)
    expect(actsOnClick('mode = \'remove\'; targetId = selected.id')).toBe(false)
    expect(actsOnClick('clearBuffer')).toBe(true)
    expect(actsOnClick('removeAccount(account)')).toBe(true)
  })

  it('sees a title-less confirmation planted in a file no per-UI scan read', () => {
    // The scope each per-UI file had, stated so a future narrowing is a decision rather than a slip.
    const read = vueFiles().map(file => file.rel)
    expect(read).toContain('uis/stock/src/views/OverviewView.vue')
    expect(read).toContain('uis/noc-console/src/components/DdnsPanel.vue')
    // Every `.vue` under `src`, not one directory: a nested component is a call site too.
    expect(read.every(rel => rel.startsWith('uis/'))).toBe(true)
    expect(new Set(read).size, 'no file is read twice').toBe(read.length)
  })
})
