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
    expect(payload.env).toMatchObject({ GITEA__server__HTTP_PORT: '3000' })
  })

  it('offers the three that were asked for, and no Plex', () => {
    const ids = SERVER_PRESETS.map(preset => preset.id)
    expect(ids).toEqual(expect.arrayContaining(['jellyfin', 'gitea', 'mongodb']))
    expect(ids).not.toContain('plex')
  })
})
