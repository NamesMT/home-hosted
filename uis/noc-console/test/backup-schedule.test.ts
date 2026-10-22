import type { BackupScheduleConfig, BackupScope } from '@shared/contracts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describeScope, schedulePatch } from '../src/lib/backupSelection'

/**
 * The backups block's two rules that sat inline in `GlobalSettingsView.vue`.
 *
 * The view reads its settings from a composable rather than a prop, so neither had a test: the
 * summary could say the wrong direction, or the patch could drop the scope, and nothing on screen
 * would show it — an automatic backup silently capturing the opposite of what was ticked.
 *
 * The source assertion at the end is not redundant: those tests cover the module, so a view that
 * grew its own copy back would keep every one of them green.
 */

const VIEW = readFileSync(new URL('../src/views/GlobalSettingsView.vue', import.meta.url), 'utf8')

/** A stored schedule, in the shape the config file holds. */
function stored(overrides: Partial<BackupScheduleConfig> = {}): BackupScheduleConfig {
  return { intervalMs: 3_600_000, keep: 7, ...overrides }
}

describe('the scope summary', () => {
  it('says the whole default scope when none is stored', () => {
    // A blank line here reads as "nothing is captured", which is the opposite of what it means.
    expect(describeScope(null)).toBe('everything (the default scope)')
  })

  it('reads each mode as the CLI spells it, with its count', () => {
    // "only" is `--include` and "except" is `--all --exclude`; swapping the two words leaves a page
    // that describes the opposite archive.
    expect(describeScope({ mode: 'only', ids: ['global:settings'] })).toBe('only 1 item selected')
    expect(describeScope({ mode: 'only', ids: ['global:settings', 'global:tls'] })).toBe('only 2 items selected')
    expect(describeScope({ mode: 'except', ids: ['global:secrets'] })).toBe('everything except 1 item')
    expect(describeScope({ mode: 'except', ids: ['global:secrets', 'global:tls'] })).toBe('everything except 2 items')
  })
})

describe('the schedule in a settings patch', () => {
  const storedScope: BackupScope = { mode: 'except', ids: ['global:secrets'] }

  it('sends nothing when the schedule was not touched', () => {
    // The patch merges by key, so re-sending a rebuilt group is how a page starts rewriting a config
    // nobody edited. And "everything ticked" is `null` on both sides, which is also not a change.
    expect(schedulePatch(stored({ scope: storedScope }), { enabled: true, hours: 1, keep: 7, scope: storedScope })).toEqual({})
    expect(schedulePatch(stored(), { enabled: true, hours: 1, keep: 7, scope: null })).toEqual({})
  })

  it('keeps a panel that predates the schedule reading as "off"', () => {
    // No `schedule` at all: the schema defaults are `intervalMs: 0`/`keep: 7`, and an untouched form
    // must not invent one.
    expect(schedulePatch(undefined, { enabled: false, hours: 1, keep: 7, scope: null })).toEqual({})
  })

  it('sends the scope when the person chose a different one', () => {
    expect(schedulePatch(stored({ scope: storedScope }), { enabled: true, hours: 1, keep: 7, scope: { mode: 'only', ids: ['global:secrets'] } }))
      .toEqual({ scope: { mode: 'only', ids: ['global:secrets'] } })
    expect(schedulePatch(stored(), { enabled: true, hours: 1, keep: 7, scope: { mode: 'only', ids: ['global:settings'] } }))
      .toEqual({ scope: { mode: 'only', ids: ['global:settings'] } })
  })

  it('clears the scope with an explicit null, never by leaving the key out', () => {
    // An absent key means "keep whatever is stored", so dropping it here would leave the person
    // unable to go back to the whole default scope.
    const patch = schedulePatch(stored({ scope: storedScope }), { enabled: true, hours: 1, keep: 7, scope: null })
    expect(patch).toEqual({ scope: null })
    expect(Object.hasOwn(patch, 'scope'), 'the key has to be present').toBe(true)
  })

  it('ignores the order the panel wrote the ids in', () => {
    // The panel chooses the order it writes them in; a different one is not an edit.
    const scope: BackupScope = { mode: 'except', ids: ['a', 'b'] }
    expect(schedulePatch(stored({ scope }), { enabled: true, hours: 1, keep: 7, scope: { mode: 'except', ids: ['b', 'a'] } })).toEqual({})
  })

  it('does not rewrite a non-whole-hour interval on an unrelated save', () => {
    // 90 minutes displays as "2 h", so comparing the rounded hours against the real milliseconds
    // sent it back as 2 hours on a save that only changed the retention.
    const policy = stored({ intervalMs: 5_400_000 })
    expect(schedulePatch(policy, { enabled: true, hours: 2, keep: 3, scope: null })).toEqual({ keep: 3 })
  })

  it('sends the interval when, and only when, it was edited', () => {
    const policy = stored({ intervalMs: 5_400_000 })
    expect(schedulePatch(policy, { enabled: true, hours: 6, keep: 7, scope: null })).toEqual({ intervalMs: 21_600_000 })
    // Switching it off is `0`, the file's spelling for "off".
    expect(schedulePatch(policy, { enabled: false, hours: 2, keep: 7, scope: null })).toEqual({ intervalMs: 0 })
    // Turning it on from the schema default sends a real interval.
    expect(schedulePatch(stored({ intervalMs: 0 }), { enabled: true, hours: 2, keep: 7, scope: null })).toEqual({ intervalMs: 7_200_000 })
  })
})

describe('the view keeps using them', () => {
  it('reads both from the module instead of re-inlining them', () => {
    // A second copy is how the two drift apart, and the module's own tests would stay green.
    expect(VIEW, 'the summary must come from the module').toContain('describeScope(')
    expect(VIEW, 'the patch must come from the module').toContain('schedulePatch(')
    // The modes' wording belongs in one place, not in the view's template.
    expect(VIEW).not.toContain('everything (the default scope)')
    expect(VIEW, 'the view must not compare scopes itself').not.toMatch(/sameScope\(/)
  })
})
