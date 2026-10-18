import type { BackupsView } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import { backupsBaseline, backupsPatch } from '../src/components/settings/settingsForm'

/**
 * The schedule form fields, and the two ways they can silently corrupt a config.
 *
 * The page asks for an interval in hours while the file stores milliseconds, so the form holds a
 * rounded view. Two rules follow, and both are pinned here: an untouched field must not be sent
 * at all, and a panel that predates the schedule (sends none) must read as "off".
 */
function view(schedule?: { intervalMs: number, keep: number }): BackupsView {
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

  it('sends the interval when, and only when, it was edited', () => {
    const policy = view({ intervalMs: 5_400_000, keep: 7 })
    const baseline = backupsBaseline(policy)
    expect(backupsPatch(policy, { ...baseline, scheduleHours: 6 })).toEqual({ schedule: { intervalMs: 21_600_000 } })
    // Switching it off is `0`, the file's spelling for "off".
    expect(backupsPatch(policy, { ...baseline, scheduleEnabled: false })).toEqual({ schedule: { intervalMs: 0 } })
  })
})
