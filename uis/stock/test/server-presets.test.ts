import { serverCreateSchema } from '@shared/contracts'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { addServerPayload } from '../src/components/server/addServerForm'
import { applyPreset, SERVER_PRESETS } from '../src/components/server/serverPresets'
import { SCHEMA_HEALTH, SCHEMA_RESTART, SCHEMA_STOP } from '../src/components/settings/settingsForm'
import { t } from '../src/i18n'

/** The workspace defaults a payload needs; the dialog passes the real ones in. */
const DEFAULTS = {
  enabled: true,
  autostart: false,
  bind: 'local' as const,
  onPortConflict: 'block' as const,
  restart: SCHEMA_RESTART,
  health: SCHEMA_HEALTH,
  stop: SCHEMA_STOP,
  logBufferLines: 500,
}

/**
 * A preset is only useful if it produces an entry the panel accepts.
 *
 * The failure mode is silent: a preset whose command still carries its arguments (the exact
 * mistake the gallery exists to prevent) or whose port is a string produces a form that looks
 * filled and a submit that fails.
 */
describe('server presets', () => {
  it('fills a form that the panel schema accepts, as-is', () => {
    for (const preset of SERVER_PRESETS) {
      const payload = addServerPayload(applyPreset(preset, { defaults: DEFAULTS }), DEFAULTS)
      const parsed = serverCreateSchema(payload)
      expect(parsed instanceof type.errors, `${preset.id}: ${parsed instanceof type.errors ? parsed.summary : ''}`).toBe(false)
    }
  })

  it('never puts a whole command line in `command`', () => {
    // `java -jar server.jar` in the command field is what produced `spawn … ENOENT` for a new
    // user. A preset must split it: program in `command`, the rest in `args`.
    for (const preset of SERVER_PRESETS) {
      expect(preset.command, preset.id).not.toContain(' ')
      expect(preset.command.trim().length).toBeGreaterThan(0)
    }
  })

  it('gives every preset an id the schema accepts, and a name a person reads', () => {
    const ids = new Set<string>()
    for (const preset of SERVER_PRESETS) {
      expect(preset.id).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
      expect(ids.has(preset.id), `duplicate preset id ${preset.id}`).toBe(false)
      ids.add(preset.id)
      // Both keys resolve to real words, not the key name echoed back.
      expect(t(preset.nameKey), preset.nameKey).not.toBe(preset.nameKey)
      expect(t(preset.descriptionKey), preset.descriptionKey).not.toBe(preset.descriptionKey)
    }
  })

  it('keeps an id and label the person already typed', () => {
    const form = applyPreset(SERVER_PRESETS[0]!, { id: 'my-mc', label: 'For the kid' })
    expect(form.id).toBe('my-mc')
    expect(form.label).toBe('For the kid')
    // Everything else still comes from the preset.
    expect(form.command).toBe(SERVER_PRESETS[0]!.command)
    expect(form.port).toBe(SERVER_PRESETS[0]!.port)
  })

  it('puts each argument on its own line, which is how the form stores them', () => {
    const form = applyPreset(SERVER_PRESETS[0]!)
    expect(form.args.split('\n')).toEqual(SERVER_PRESETS[0]!.args)
  })

  /**
   * Environment is how a preset configures a program that has no config file on a first run.
   *
   * A rootless Gitea is the case: its web port and its SSH port are env-only until its install
   * wizard writes `app.ini`, so a preset that dropped the env would start it on the wrong ports.
   */
  it('carries the environment into the form, one KEY=value per line', () => {
    const gitea = SERVER_PRESETS.find(preset => preset.id === 'gitea')
    expect(gitea, 'the rootless Gitea preset must exist').toBeDefined()
    expect(gitea!.env?.length, 'it needs its ports set, or it listens where the form says it does not').toBeGreaterThan(0)

    const form = applyPreset(gitea!)
    expect(form.env.split('\n')).toEqual(gitea!.env)
    // …and the payload the route receives is the parsed record, not the text block.
    const payload = addServerPayload(form, DEFAULTS)
    // The value is the *placeholder*, which the supervisor substitutes at spawn time — this test
    // originally pinned the literal `3000`, codifying the very bug it now guards against.
    expect(payload.env).toMatchObject({ GITEA__server__HTTP_PORT: '{port}' })
  })

  /**
   * A preset's port must come from the form, not be typed twice.
   *
   * The first Gitea preset hardcoded `HTTP_PORT=3000` while the entry declared port 3000. Change
   * the port in the form and the panel probes 3001 while Gitea still listens on 3000 — a "failing"
   * health check with no visible cause. `{port}` is the placeholder that makes the two agree, and
   * the supervisor resolves it in `env` as well as in `args`.
   */
  it('never hardcodes the port a preset also declares', () => {
    const offenders: string[] = []
    for (const preset of SERVER_PRESETS) {
      if (preset.port === null)
        continue
      const declared = String(preset.port)
      for (const line of preset.env ?? []) {
        const [key, value] = line.split('=')
        // A port-ish env var carrying the literal default instead of `{port}` pins it.
        if (/PORT/i.test(key ?? '') && value === declared)
          offenders.push(`${preset.id}: ${line}`)
      }
      for (const arg of preset.args) {
        if (arg === declared)
          offenders.push(`${preset.id}: arg "${arg}" should be {port}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('passes {port} through to whatever carries the port', () => {
    const byId = new Map(SERVER_PRESETS.map(preset => [preset.id, preset]))

    // Where the program takes a port argument, the placeholder is in the args.
    expect(byId.get('python')!.args).toContain('{port}')
    expect(byId.get('mongodb')!.args).toContain('{port}')

    // Where it takes the port from its environment, the placeholder is in the env.
    expect(byId.get('gitea')!.env).toContain('GITEA__server__HTTP_PORT={port}')
    expect(byId.get('node')!.env).toContain('PORT={port}')

    // And where the program owns its port (a properties/xml file), there is deliberately none —
    // asserted so the omission reads as a decision rather than an oversight.
    expect(byId.get('minecraft')!.args.join(' ')).not.toContain('{port}')
    expect(byId.get('jellyfin')!.args.join(' ')).not.toContain('{port}')
  })

  it('offers the three that were asked for, and no Plex', () => {
    const ids = SERVER_PRESETS.map(preset => preset.id)
    expect(ids).toEqual(expect.arrayContaining(['jellyfin', 'gitea', 'mongodb']))
    expect(ids).not.toContain('plex')
  })
})
