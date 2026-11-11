import { describe, expect, it } from 'vitest'
import {
  authSchema,
  backupsSchema,
  controlSchema,
  defaultsSchema,
  hostSchema,
  logsSchema,
  notificationsSchema,
  proxyConfigSchema,
  proxyPatchSchema,
  settingsPatchSchema,
  tlsSchema,
  workspaceSettingsPatchSchema,
} from '#src/shared/contracts'

/**
 * Every nested patch group must mirror its base schema, field for field.
 *
 * This is the risk `contracts.ts` carries: 22 patch schemas restate 124 fields of their base schemas
 * with `?` on every member and the defaults removed, because `.partial()` keeps a default (measured —
 * `type({ a: 'boolean = true' }).partial()({})` is still `{ a: true }`), so a patch cannot be derived
 * from its base in one line.
 *
 * A hand-maintained mirror drifts silently in one direction only: add a field to the base and forget
 * the patch, and the API refuses a value it advertises; add it to the patch and forget the base, and
 * a config the panel cannot read gets written. `contracts.test.ts` guarded three of the server's
 * groups; the settings, workspace-settings and proxy groups had no such check at all.
 *
 * Compared by **key set**, never by value: a patch deliberately widens a type (`number?` for
 * `number`), so only the field list has to agree.
 */
type Props = Record<string, { properties?: Props }>
function properties(schema: { toJsonSchema: () => unknown }): Props {
  return (schema.toJsonSchema() as { properties: Props }).properties
}
const keysOf = (schema: { toJsonSchema: () => unknown }): string[] => Object.keys(properties(schema)).sort()

describe('a nested patch group mirrors its base schema', () => {
  /** A base group schema (the group itself, not a container holding it) and where its patch lives. */
  const pairs: Array<{
    name: string
    base: { toJsonSchema: () => unknown }
    container: { toJsonSchema: () => unknown }
    key: string
  }> = [
    { name: 'settings.control', base: controlSchema, container: settingsPatchSchema, key: 'control' },
    { name: 'settings.host', base: hostSchema, container: settingsPatchSchema, key: 'host' },
    { name: 'settings.backups', base: backupsSchema, container: settingsPatchSchema, key: 'backups' },
    { name: 'workspace.defaults', base: defaultsSchema, container: workspaceSettingsPatchSchema, key: 'defaults' },
    { name: 'workspace.logs', base: logsSchema, container: workspaceSettingsPatchSchema, key: 'logs' },
    { name: 'workspace.notifications', base: notificationsSchema, container: workspaceSettingsPatchSchema, key: 'notifications' },
    { name: 'proxy.dns01', base: proxyConfigSchema, container: proxyPatchSchema, key: 'dns01' },
  ]

  for (const { name, base, container, key } of pairs) {
    it(`${name}`, () => {
      // `dns01` is the one group whose base is itself inside a container, so it is resolved by name;
      // every other pair names the group schema directly.
      const baseGroup = key === 'dns01' ? properties(base)[key]?.properties : properties(base)
      expect(baseGroup, `${name}: the base has a nested group`).toBeDefined()
      const patchGroup = properties(container)[key]?.properties
      expect(patchGroup, `${name}: the patch declares ${key}`).toBeDefined()
      expect(Object.keys(patchGroup!).sort(), name).toEqual(Object.keys(baseGroup!).sort())
    })
  }

  /**
   * The groups one level deeper still: `control.auth` and `control.tls` are nested inside the control
   * patch, so a flat key comparison of `settingsPatch.control` never sees them. Found by attacking
   * this guard — renaming `lockoutMs` in `authPatchSchema` passed, which is exactly the drift the
   * guard exists to catch.
   */
  const deep: Array<{ name: string, base: { toJsonSchema: () => unknown }, key: string }> = [
    { name: 'control.auth', base: authSchema, key: 'auth' },
    { name: 'control.tls', base: tlsSchema, key: 'tls' },
  ]

  for (const { name, base, key } of deep) {
    it(`${name} (nested under control)`, () => {
      const controlPatch = properties(settingsPatchSchema).control?.properties
      expect(controlPatch, 'settingsPatch has a control group').toBeDefined()
      const patchGroup = controlPatch![key]?.properties
      expect(patchGroup, `the control patch declares ${key}`).toBeDefined()
      expect(Object.keys(patchGroup!).sort(), name).toEqual(keysOf(base))
    })
  }

  it('the proxy patch covers every proxy config field', () => {
    expect(keysOf(proxyPatchSchema)).toEqual(keysOf(proxyConfigSchema))
  })
})
