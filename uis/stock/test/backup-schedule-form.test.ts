import type { BackupScope, BackupsView } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import { backupsBaseline, backupsPatch } from '../src/components/settings/settingsForm'

/**
 * The schedule form fields, and the two ways they can silently corrupt a config.
 *
 * The page asks for an interval in hours while the file stores milliseconds, so the form holds a
 * rounded view. Two rules follow, and both are pinned here: an untouched field must not be sent
 * at all, and a panel that predates the schedule (sends none) must read as "off".
 */
function view(schedule?: { intervalMs: number, keep: number, scope?: BackupScope }): BackupsView {
  return ({
    enabled: true,
    dir: '/srv/.backups',
    keep: 5,
    ...(schedule === undefined ? {} : { schedule }),
    includePaths: [],
    entries: [],
    files: [],
  }) as BackupsView
}

describe('the backup schedule form', () => {
  it('reads an older panel as "off", with the schema default retention', () => {
    const baseline = backupsBaseline(view())
    expect(baseline.scheduleEnabled).toBe(false)
    expect(baseline.scheduleHours).toBe(1)
    expect(baseline.scheduleKeep).toBe(7)
    // And saving that untouched form changes nothing.
    expect(backupsPatch(view(), baseline)).toEqual({})
  })

  it('does not rewrite a non-whole-hour interval on an unrelated save', () => {
    // 90 minutes: the field shows "2 h", so sending it back would silently become 2 hours.
    const policy = view({ intervalMs: 5_400_000, keep: 7 })
    const baseline = backupsBaseline(policy)
    expect(baseline.scheduleHours, 'rounded for display').toBe(2)

    // Untouched: nothing to send.
    expect(backupsPatch(policy, baseline)).toEqual({})

    // Only the retention changed: the interval must not ride along.
    const patch = backupsPatch(policy, { ...baseline, scheduleKeep: 3 })
    expect(patch).toEqual({ schedule: { keep: 3 } })
    expect(JSON.stringify(patch), 'the interval is left alone').not.toContain('intervalMs')
  })

  /**
   * The scope field, and the two ways it can corrupt a config.
   *
   * An untouched dialog must not send the scope at all: the patch merges by key, so sending what the
   * panel already holds is harmless — but re-sending a *rebuilt* object on every save is how a page
   * starts rewriting a config nobody edited. And `null` has to travel as `null`, because omitting
   * the key means "leave it stored" — that is the only way to go back to the whole default scope.
   */
  it('sends the scope only when the dialog changed it, and null clears it', () => {
    const off = view({ intervalMs: 3_600_000, keep: 7 })
    const baseline = backupsBaseline(off)
    expect(baseline.scheduleScope, 'a schedule with no scope is the whole default').toBeNull()
    expect(backupsPatch(off, baseline)).toEqual({})

    // The same ids in another order is not an edit: the panel chooses the order it writes them in.
    const custom = view({ intervalMs: 3_600_000, keep: 7, scope: { mode: 'except', ids: ['a', 'b'] } })
    const customBaseline = backupsBaseline(custom)
    expect(backupsPatch(custom, { ...customBaseline, scheduleScope: { mode: 'except', ids: ['b', 'a'] } })).toEqual({})

    // A narrowed schedule sends the narrowed scope.
    expect(backupsPatch(custom, { ...customBaseline, scheduleScope: { mode: 'only', ids: ['global:settings'] } }))
      .toEqual({ schedule: { scope: { mode: 'only', ids: ['global:settings'] } } })
    // And clearing it travels as `null`, not as an absent key.
    expect(backupsPatch(custom, { ...customBaseline, scheduleScope: null })).toEqual({ schedule: { scope: null } })
  })

  it('keeps a scope an older panel never sent out of the patch', () => {
    // A panel that predates the field reports no `scope`; the form must not invent one.
    const older = view({ intervalMs: 3_600_000, keep: 7 })
    expect(backupsBaseline(older).scheduleScope).toBeNull()
    expect(backupsPatch(older, backupsBaseline(older))).toEqual({})
  })

  it('sends the interval when, and only when, it was edited', () => {
    const policy = view({ intervalMs: 5_400_000, keep: 7 })
    const baseline = backupsBaseline(policy)
    expect(backupsPatch(policy, { ...baseline, scheduleHours: 6 })).toEqual({ schedule: { intervalMs: 21_600_000 } })
    // Switching it off is `0`, the file's spelling for "off".
    expect(backupsPatch(policy, { ...baseline, scheduleEnabled: false })).toEqual({ schedule: { intervalMs: 0 } })
  })
})
