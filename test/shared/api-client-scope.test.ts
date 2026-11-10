import { expect, it } from 'vitest'
import { scoped, useWorkspaceResolver } from '#src/shared/api-client'

/**
 * The one rule for a workspace-scoped URL, and the two cases a caller gets wrong.
 *
 * A blank id is "not named", not "the default workspace": `?workspace=` is a 404 on any panel whose
 * default has a name, so `scoped` has to fall through to the resolver exactly as an omission does.
 * `??` alone keeps `''` (it is not nullish) and silently skips the resolver — which is why a blank
 * reactive id used to mean "panel default" instead of "whatever is selected".
 *
 * The separator is the other half: a path that already carries a query appends with `&`. `stock`'s
 * old copy used `?` unconditionally and was only saved by having no such caller; shared, it would
 * have become both UIs' bug.
 */
it('treats a blank workspace as unnamed, and appends to a path that already has a query', () => {
  useWorkspaceResolver(() => 'alpha')
  // Blank and null both mean "ask the resolver".
  expect(scoped('/api/logs/x', '')).toBe('/api/logs/x?workspace=alpha')
  expect(scoped('/api/logs/x', null)).toBe('/api/logs/x?workspace=alpha')
  expect(scoped('/api/logs/x')).toBe('/api/logs/x?workspace=alpha')
  // A named workspace wins over the resolver.
  expect(scoped('/api/logs/x', 'beta')).toBe('/api/logs/x?workspace=beta')
  // The `?`-in-path case, which is what the log download link is.
  expect(scoped('/api/logs/x/download?file=a.log', 'alpha'))
    .toBe('/api/logs/x/download?file=a.log&workspace=alpha')

  // A resolver with no answer adds nothing, in either spelling.
  useWorkspaceResolver(() => null)
  expect(scoped('/api/logs/x', '')).toBe('/api/logs/x')
  expect(scoped('/api/logs/x')).toBe('/api/logs/x')
  expect(scoped('/api/logs/x/download?file=a.log')).toBe('/api/logs/x/download?file=a.log')
})
