import type { HealthConfig, RestartConfig, ServerDefaults, StopConfig } from '@shared/contracts'
import type { FieldKey } from '../src/lib/serverForm'
import { serverPatchSchema } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import { blankSharedForm, FIELD_CATALOG_PARTS, FIELD_SPECS, fieldSpec, FORM_LAYOUT, inheritBaseline, rssBytesFromForm, rssMegabytesFromConfig, SCHEMA_HEALTH, SCHEMA_RESTART, SCHEMA_STOP } from '../src/lib/serverForm'

/**
 * The shared server form, pinned field by field.
 *
 * `AddServerDialog.vue` and `ServerConfigView.vue` render the same form, and the point of
 * moving it into `src/lib/serverForm.ts` is that the two can no longer disagree about a
 * label, a hint or a default. A test that only mounted one of them would not notice the
 * other losing a field, so this pins the catalogue itself.
 */

/** The policy defaults the dialog used to spell out as its own `SCHEMA_*` literals. */
const LITERAL_RESTART: RestartConfig = { enabled: true, maxRetries: 3, baseDelayMs: 1000, factor: 2, maxDelayMs: 30000, resetAfterMs: 60000 }
const LITERAL_HEALTH: HealthConfig = {
  enabled: true,
  mode: 'port',
  http: { scheme: 'http', allowInvalidCert: false, path: '/', method: 'GET', expectStatusBelow: 400, expectBody: '' },
  intervalMs: 5000,
  timeoutMs: 1500,
  unhealthyThreshold: 3,
  forceRestartAfterMs: 0,
  startTimeoutMs: 20000,
}
const LITERAL_STOP: StopConfig = { signal: 'SIGTERM', killGroup: true, graceMs: 5000, killPortHolders: false }

describe('the schema defaults', () => {
  /**
   * Read from the contract rather than re-typed, so a default that moves in
   * `src/shared/contracts.ts` cannot leave this form diffing against a stale value — the
   * failure that would write the old default into `servers.config.json`.
   */
  it('matches the literals the dialog used to carry', () => {
    expect(SCHEMA_RESTART).toEqual(LITERAL_RESTART)
    expect(SCHEMA_HEALTH).toEqual(LITERAL_HEALTH)
    expect(SCHEMA_STOP).toEqual(LITERAL_STOP)
  })

  it('gives the nested `http` group its own object, so a copy cannot alias live state', () => {
    // Two reads must not hand out the same object: `cloneHealth` exists for that reason.
    expect(SCHEMA_HEALTH.http).not.toBe(LITERAL_HEALTH.http)
  })
})

describe('inheritBaseline', () => {
  const defaults: ServerDefaults = {
    enabled: false,
    autostart: true,
    bind: 'lan',
    onPortConflict: 'reclaim',
    logBufferLines: 900,
    restart: { ...LITERAL_RESTART },
    health: { ...LITERAL_HEALTH },
    stop: { ...LITERAL_STOP },
  }

  it('is one definition the dialog diffs against, with the panel defaults on top', () => {
    expect(inheritBaseline(defaults)).toEqual({
      args: [],
      cwd: '.',
      env: {},
      dataEnvs: {},
      dependsOn: [],
      envFile: '',
      backupPaths: [],
      backupIgnoreGenerated: true,
      resources: { maxRssBytes: 0 },
      bind: 'lan',
      enabled: false,
      autostart: true,
      persistent: false,
      onPortConflict: 'reclaim',
      logBufferLines: 900,
    })
  })

  it('falls back to the schema defaults with no panel defaults at all', () => {
    const baseline = inheritBaseline(null)
    expect(baseline.bind).toBe('local')
    expect(baseline.enabled).toBe(true)
    expect(baseline.autostart).toBe(false)
    expect(baseline.onPortConflict).toBe('block')
    expect(baseline.logBufferLines).toBe(500)
  })

  it('hands back a fresh object every time, so a diff cannot corrupt the next one', () => {
    const first = inheritBaseline(defaults)
    const second = inheritBaseline(defaults)
    expect(first).not.toBe(second)
    expect(first.resources).not.toBe(second.resources)
    ;(first.resources as { maxRssBytes: number }).maxRssBytes = 999
    expect(second.resources).toEqual({ maxRssBytes: 0 })
  })
})

describe('blankSharedForm', () => {
  /**
   * The three fields the two entry points deliberately differ on. The sheet writes them
   * blank so its placeholder can say what will be inherited; the page shows the value it
   * is editing and starts from the panel default.
   */
  it('leaves the sheet blank where the page shows an inherited value', () => {
    const sheet = blankSharedForm('sheet', null)
    const page = blankSharedForm('page', null)

    expect(sheet.cwd).toBe('')
    expect(sheet.logBufferLines).toBe('')
    expect(sheet.bootstrapTimeoutMs).toBe('')
    expect(page.cwd).toBe('.')
    expect(page.logBufferLines).toBe('500')
    expect(page.bootstrapTimeoutMs).toBe('120000')
  })

  it('takes everything else from the panel defaults, identically on both sides', () => {
    const defaults = { enabled: false, autostart: true, bind: 'lan', onPortConflict: 'kill' } as ServerDefaults
    const sheet = blankSharedForm('sheet', defaults)
    const page = blankSharedForm('page', defaults)

    for (const key of ['bind', 'enabled', 'autostart', 'onPortConflict'] as const) {
      expect(sheet[key]).toEqual(page[key])
      expect(sheet[key]).toEqual(defaults[key])
    }
    expect(sheet.persistent).toBe(false)
    expect(sheet.backupIgnoreGenerated).toBe(true)
    expect(sheet.bootstrapEnabled).toBe(false)
  })
})

/** Every field key the catalogue resolves, taken from the catalogue rather than restated. */
function allFields(): FieldKey[] {
  return Object.keys(FIELD_SPECS.sheet) as FieldKey[]
}

describe('the field catalogue', () => {
  it('defines every field each layout names', () => {
    for (const [variant, sections] of Object.entries(FORM_LAYOUT)) {
      const named = sections.flatMap(section => [
        ...section.fields,
        ...(section.sections ?? []).flatMap(inner => [...inner.fields, ...(inner.toggle ? [inner.toggle] : [])]),
        ...(section.toggle ? [section.toggle] : []),
      ])
      for (const key of named)
        expect(fieldSpec(variant as 'sheet' | 'page', key), `${variant} names ${key}`).toBeTruthy()
    }
  })

  it('drops no field either entry point used to render', () => {
    // The fields the two files rendered before the extraction, by the name of their model.
    const sheetFields: FieldKey[] = ['id', 'label', 'command', 'args', 'cwd', 'port', 'bind', 'autostart', 'persistent', 'enabled', 'onPortConflict', 'logBufferLines', 'maxRssMb', 'envFile', 'dependsOn', 'env', 'dataEnvs', 'backupPaths', 'backupIgnoreGenerated', 'bootstrapEnabled', 'bootstrapCommand', 'bootstrapTimeoutMs', 'bootstrapRunOnce', 'bootstrapArgs', 'bootstrapEnv']
    const pageFields: FieldKey[] = ['label', 'command', 'cwd', 'envFile', 'args', 'env', 'dataEnvs', 'backupPaths', 'backupIgnoreGenerated', 'port', 'bind', 'customBind', 'onPortConflict', 'logBufferLines', 'liveBind', 'enabled', 'autostart', 'persistent', 'dependsOn', 'maxRssMb', 'bootstrapEnabled', 'bootstrapCommand', 'bootstrapTimeoutMs', 'bootstrapRunOnce', 'bootstrapArgs', 'bootstrapEnv']

    for (const key of sheetFields)
      expect(FIELD_SPECS.sheet[key], `sheet lost ${key}`).toBeTruthy()
    for (const key of pageFields)
      expect(FIELD_SPECS.page[key], `page lost ${key}`).toBeTruthy()
  })

  /**
   * The split into a common map and two variant maps must be total **and** disjoint.
   *
   * Totality is a compile error (`Record<DifferingKey, FieldSpec>` refuses a variant that
   * omits a field). Disjointness is not, and it is the half that rots quietly: a field left
   * in the common map that both variants also declare never renders, yet it reads as that
   * field's definition — so the next person edits the copy nobody uses.
   */
  it('splits the catalogue with no field declared in both a variant and the common map', () => {
    const { common, sheet, page } = FIELD_CATALOG_PARTS
    const shared = Object.keys(common)
    const overridden = [...Object.keys(sheet), ...Object.keys(page)]

    const shadowed = shared.filter(key => overridden.includes(key))
    expect(shadowed, 'a common entry both variants override is dead weight').toEqual([])

    // The two variants override the same set, which is what makes the split total: a key
    // only one of them declares would leave the other resolving it from the common map.
    expect(Object.keys(sheet).sort()).toEqual(Object.keys(page).sort())

    // Anti-vacuity: the parts are non-empty and really do resolve to the same fields.
    expect(shared.length).toBeGreaterThan(0)
    expect(Object.keys(sheet).length).toBeGreaterThan(0)
    for (const key of allFields())
      expect(FIELD_SPECS.sheet[key], `sheet resolved ${key}`).toBeTruthy()
    for (const key of allFields())
      expect(FIELD_SPECS.page[key], `page resolved ${key}`).toBeTruthy()
  })

  it('disagrees between the variants only where it means to', () => {
    // Exactly the override set the two files worded differently: a field that "differs" only
    // because one side lost it would appear here as a surprise.
    const differing = allFields()
      .filter(key => JSON.stringify(FIELD_SPECS.sheet[key]) !== JSON.stringify(FIELD_SPECS.page[key]))
      .sort()
    expect(differing).toEqual([
      'args',
      'bind',
      'bootstrapCommand',
      'bootstrapTimeoutMs',
      'command',
      'dependsOn',
      'envFile',
      'logBufferLines',
      'maxRssMb',
      'persistent',
      'port',
    ])
  })

  it('keeps the labels and controls each entry point showed', () => {
    // Spot-checks of the fields the two files genuinely worded differently, which is why the
    // catalogue carries per-variant overrides at all.
    expect(fieldSpec('sheet', 'args').label).toBe('args — space separated')
    expect(fieldSpec('page', 'args').label).toBe('args — one per line, placeholders allowed')
    expect(fieldSpec('sheet', 'args').control).toBe('text')
    expect(fieldSpec('page', 'args').control).toBe('textarea')
    expect(fieldSpec('sheet', 'bind').options?.map(option => option.value)).toEqual(['local', 'lan'])
    expect(fieldSpec('page', 'bind').options?.map(option => option.value)).toEqual(['local', 'lan', 'custom'])
    expect(fieldSpec('sheet', 'persistent').hint).toContain('`down` reports it instead of stopping it')
    expect(fieldSpec('page', 'persistent').hint).toBe('keeps running when the panel stops; stop it explicitly to end it')
  })

  it('renders the sheet’s log-buffer placeholder from the live default, never a stale number', () => {
    // The hint says "inherited (N)"; the number has to be the one the field drops out against.
    expect(fieldSpec('sheet', 'logBufferLines').inheritedPlaceholder).toBe(true)
    expect(fieldSpec('page', 'logBufferLines').inheritedPlaceholder).toBeUndefined()
  })
})

describe('the MiB round-trip', () => {
  it('writes a blank box as no guard and reads 0 back as blank', () => {
    expect(rssBytesFromForm('')).toBe(0)
    expect(rssBytesFromForm('   ')).toBe(0)
    expect(rssBytesFromForm('64')).toBe(64 * 1024 * 1024)
    expect(rssMegabytesFromConfig(0)).toBe('')
    expect(rssMegabytesFromConfig(64 * 1024 * 1024)).toBe('64')
    // A byte count that is not a whole MiB rounds, as the two forms always did.
    expect(rssMegabytesFromConfig(1500 * 1024)).toBe('1')
  })

  /**
   * The reason the helpers exist: the value they produce has to survive the schema the
   * dialog validates with, or the whole create request is refused.
   */
  it('produces a resource group the server patch schema accepts', () => {
    const parsed = serverPatchSchema({ resources: { maxRssBytes: rssBytesFromForm('128') } })
    expect(parsed instanceof Error).toBe(false)
    expect(JSON.stringify(parsed)).toContain('134217728')
  })
})
