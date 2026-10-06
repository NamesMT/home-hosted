import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every `server` and `log` frame must carry `workspaceId`, and the UI contract must say so.
 *
 * The frame table in `docs/UI_CREATION.md` showed `{ ts, serverId, server }` and `{ ts, serverId, lines }`
 * — no `workspaceId`. It is optional in `sseMessageSchema` only so an **older** panel still parses, which
 * the stock UI handles deliberately (`useControlPlane.ts`: "a `server` frame may omit `workspaceId` (an
 * older panel)… anything else is dropped rather than guessed at"). A UI author reading the table would
 * not know to handle it, and a server id is unique only inside its workspace.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))
const SUPERVISOR = fs.readFileSync(path.join(root, 'src/services/supervisor.ts'), 'utf8')

/** A `hub.publish({ … })` body for one of the frame types that names a server. */
function publishBodies(type: string): string[] {
  return [...SUPERVISOR.matchAll(/publish\(\{([\s\S]{0,400}?)\}\)/g)]
    .map(m => m[1]!)
    .filter(body => new RegExp(`type:\\s*'${type}'`).test(body))
}

describe('server-scoped SSE frames', () => {
  it('always carry workspaceId in the code', () => {
    for (const type of ['log', 'server']) {
      const bodies = publishBodies(type)
      // Anti-vacuity: each type must actually be published somewhere.
      expect(bodies.length, `expected at least one '${type}' publish`).toBeGreaterThan(0)
      for (const body of bodies)
        expect(body.replace(/\s+/g, ' '), `a '${type}' frame without workspaceId`).toContain('workspaceId')
    }
  })

  it('and the UI contract names it in the frame table', () => {
    const doc = fs.readFileSync(path.join(root, 'docs/UI_CREATION.md'), 'utf8')
    for (const type of ['server', 'log']) {
      const row = doc.split('\n').find(line => line.startsWith(`| \`${type}\``))
      expect(row, `the '${type}' row must exist`).toBeDefined()
      expect(row, `the '${type}' row must show workspaceId`).toContain('workspaceId')
    }
  })
})
