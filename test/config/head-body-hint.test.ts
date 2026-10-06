import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseServersFile } from '#src/config/parse'

/**
 * The `HEAD`-cannot-check-a-body rule must be warned about where the field is set.
 *
 * The server reports it through `configWarnings`, which both UIs render on the **Settings** page — not
 * in the server editor where the mistake is made. `HEAD` plus a body requirement silently drops the
 * assertion, and a health check that quietly stops checking is worse than one that fails: `http` mode
 * with `forceRestartAfterMs` exists to restart a server that stopped working, and a probe that skips its
 * assertion reports healthy either way.
 *
 * Each UI now reacts on the field itself. This pins the condition against the server's own rule, so a
 * change to one cannot leave the hint showing when the server no longer warns (or vice versa).
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

/** The exact predicate the parser uses, exercised rather than transcribed. */
function serverWarns(method: string, expectBody: string): boolean {
  const { warnings } = parseServersFile({
    servers: [{ id: 'app', command: 'node', health: { mode: 'http', http: { method, expectBody } } }],
  }, {})
  return warnings.some(warning => warning.includes('requires a response body with method HEAD'))
}

describe('the HEAD/body rule', () => {
  it('fires for a HEAD with a body requirement, and not otherwise', () => {
    expect(serverWarns('HEAD', 'ready'), 'the rule itself').toBe(true)
    expect(serverWarns('GET', 'ready'), 'a GET body check works').toBe(false)
    expect(serverWarns('HEAD', ''), 'no requirement, nothing to skip').toBe(false)
  })

  it('is mirrored by both UIs on the field where it is set', () => {
    const noc = fs.readFileSync(path.join(root, 'uis/noc-console/src/views/ServerConfigView.vue'), 'utf8')
    const stock = fs.readFileSync(path.join(root, 'uis/stock/src/components/server/LifecycleFields.vue'), 'utf8')

    // Each must test the method and the body length, the two halves of the rule.
    for (const [name, source] of [['noc-console', noc], ['stock', stock]] as const) {
      expect(source, `${name} must react to HEAD`).toMatch(/httpMethod === 'HEAD'|http\.method === 'HEAD'/)
      expect(source, `${name} must react to a non-empty body requirement`).toMatch(/[Ee]xpectBody\.length > 0/)
      expect(source, `${name} must say the check is ignored`).toMatch(/ignored/i)
    }
  })
})
