import type { JobRow } from '@shared/api-client'
import { describe, expect, it } from 'vitest'
import { blankJobForm, JOB_FIELDS, JOB_FORM_LAYOUT, jobCreateBody, jobFormComplete, jobFormFrom, jobFormPayload } from '../src/lib/jobForm'

/**
 * The console's job form, pinned as data.
 *
 * The sheet is a shell around this catalogue, so a field that loses its label, its hint or its place
 * would still render — just wrong, on the page a person declares a backup on. A mounted test alone
 * would not see a field the layout stopped listing, so this pins the catalogue and the layout.
 */
const JOB: JobRow = {
  id: 'nightly-backup',
  label: 'Nightly backup',
  enabled: false,
  command: './scripts/backup.sh',
  args: ['--full', '--keep=14'],
  schedule: '0 3 * * *',
  running: false,
  cwd: '/srv/app',
  timeoutMs: 900_000,
  secretEnv: ['BACKUP_TOKEN'],
  secretEnvSet: ['BACKUP_TOKEN'],
}

describe('the job form catalogue', () => {
  it('defines a label, a control and a hint-bearing entry for every field it lists', () => {
    for (const section of JOB_FORM_LAYOUT) {
      for (const key of section.fields) {
        const spec = JOB_FIELDS[key]
        expect(spec, `${key} has no catalogue entry`).toBeDefined()
        expect(spec.label.length, `${key} has no label`).toBeGreaterThan(0)
        expect(['text', 'textarea', 'check']).toContain(spec.control)
      }
    }
  })

  /**
   * The layout is the only place field order lives, so a field it never places is a field nobody can
   * edit — which is the shape of the defect this form was added to fix.
   */
  it('places every field it defines, exactly once', () => {
    const placed = JOB_FORM_LAYOUT.flatMap(section => section.fields)
    expect([...placed].sort()).toEqual(Object.keys(JOB_FIELDS).sort())
    expect(new Set(placed).size).toBe(placed.length)
  })

  /**
   * `id` is not a field: it names the run's log file, its run history and its stored secret values, so
   * the sheet shows it read-only rather than offering an edit that would orphan all three.
   */
  it('offers no editable id', () => {
    expect(Object.keys(JOB_FIELDS)).not.toContain('id')
  })

  /**
   * The secret **names** and their value boxes are one block, and the box block is anchored after the
   * names field — a section-level slot can only render after the whole group, which is how the same
   * panel landed 1897 px below the names that declare it in the server form.
   */
  it('anchors the secret-values slot directly after the names field', () => {
    const group = JOB_FORM_LAYOUT.find(section => section.fields.includes('secretEnv'))
    expect(group, 'the names field must be placed').toBeDefined()
    const slots = group!.slots ?? []
    expect(slots).toHaveLength(1)
    expect(slots[0]!.after).toBe('secretEnv')
    expect(slots[0]!.name).toBe('secret-values')
    // And the anchor is in the block's own field list, so the renderer has something to follow.
    expect(group!.fields).toContain(slots[0]!.after)
  })
})

describe('the job form values', () => {
  it('fills from the stored job, not from the blank form', () => {
    const form = jobFormFrom(JOB)
    expect(form).toMatchObject({
      label: 'Nightly backup',
      command: './scripts/backup.sh',
      args: '--full\n--keep=14',
      schedule: '0 3 * * *',
      cwd: '/srv/app',
      timeoutSeconds: '900',
      enabled: false,
      secretEnv: 'BACKUP_TOKEN',
    })
  })

  /** A panel that predates `cwd`/`timeoutMs` sends neither; the form falls back rather than blanking. */
  it('falls back to the schema defaults for a job that carries neither cwd nor timeout', () => {
    const form = jobFormFrom({ ...JOB, cwd: undefined, timeoutMs: undefined, label: undefined })
    expect(form.cwd).toBe('')
    expect(form.timeoutSeconds).toBe('3600')
    expect(form.label).toBe('')
  })

  it('sends a whole-field patch with no id in it', () => {
    const payload = jobFormPayload(jobFormFrom(JOB))
    expect(payload).toEqual({
      label: 'Nightly backup',
      command: './scripts/backup.sh',
      args: ['--full', '--keep=14'],
      schedule: '0 3 * * *',
      cwd: '/srv/app',
      timeoutMs: 900_000,
      enabled: false,
      secretEnv: ['BACKUP_TOKEN'],
    })
    expect(payload).not.toHaveProperty('id')
  })

  it('reads a blank label as null, which clears it and falls back to the id', () => {
    expect(jobFormPayload(blankJobForm()).label).toBeNull()
    expect(jobFormPayload({ ...blankJobForm(), label: '   ' }).label).toBeNull()
  })

  /**
   * A create with no label leaves the key **out**; a patch keeps `null`, where it means "clear it".
   * Sending `null` on create wrote `"label": null` into `jobs.config.json`, which is not the file's
   * own convention — an absent key is what falls back to the id.
   */
  it('omits a blank label from the create body, and keeps it for a patch', () => {
    const blank = { ...blankJobForm(), command: 'x', schedule: '0 3 * * *' }
    const created = jobCreateBody('backup', blank)
    expect(created).not.toHaveProperty('label')
    expect(created.id).toBe('backup')
    expect(created.command).toBe('x')
    // A label the person typed is sent.
    expect(jobCreateBody('backup', { ...blank, label: 'Nightly' }).label).toBe('Nightly')
    // The patch is unchanged: `null` there is "clear it".
    expect(jobFormPayload(blank).label).toBeNull()
  })

  it('reads a blank cwd as the default "." and an unusable timeout as the schema default', () => {
    const payload = jobFormPayload({ ...blankJobForm(), cwd: '  ', timeoutSeconds: '' })
    expect(payload.cwd).toBe('.')
    expect(payload.timeoutMs).toBe(3_600_000)
    // A zero or a negative would be refused by the schema's `>= 1000` floor.
    expect(jobFormPayload({ ...blankJobForm(), timeoutSeconds: '0' }).timeoutMs).toBe(3_600_000)
  })

  it('drops blank argument lines and deduplicates the declared secret names', () => {
    const payload = jobFormPayload({ ...blankJobForm(), command: 'x', schedule: '* * * * *', args: '\n--a\n\n--b\n', secretEnv: 'A\nB\nA\n' })
    expect(payload.args).toEqual(['--a', '--b'])
    expect(payload.secretEnv).toEqual(['A', 'B'])
  })

  it('submits only once the command, the schedule and (when creating) the id are there', () => {
    const ready = { ...blankJobForm(), command: 'x', schedule: '0 3 * * *' }
    expect(jobFormComplete(ready, 'create', 'backup')).toBe(true)
    expect(jobFormComplete(ready, 'create', '  ')).toBe(false)
    // Editing an existing job needs no id: it has one and cannot change it.
    expect(jobFormComplete(ready, 'edit', '')).toBe(true)
    expect(jobFormComplete({ ...blankJobForm(), schedule: '0 3 * * *' }, 'edit', 'backup')).toBe(false)
    expect(jobFormComplete({ ...blankJobForm(), command: 'x' }, 'edit', 'backup')).toBe(false)
  })
})
