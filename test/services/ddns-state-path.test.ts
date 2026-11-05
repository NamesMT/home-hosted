import type { NotificationService } from '#src/services/notifications'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceDdnsStatePath, workspaceLegacyDdnsStatePath } from '#src/helpers/paths'
import { DdnsService } from '#src/services/ddns'
import { parseDdnsConfig } from '../support/capabilities'

/**
 * `.state/` holds `<id>.json` (nanny state), `<id>.spec.json` and `<id>.run.json` for every entry,
 * so the DDNS cache beside them must have a name no server id produces — `ddns.json` was a persistent
 * `ddns` entry's nanny state too, and each overwrote the other.
 */
const SERVER_ID = /^[a-z0-9][a-z0-9_-]*$/ // `serverSchema.id` in src/shared/contracts.ts

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function service(statePath: string, legacyStatePath: string): DdnsService {
  return new DdnsService({
    getConfig: () => parseDdnsConfig({ enabled: false, intervalMs: 60000, accounts: [], domains: [] }),
    getCredentials: () => null,
    notifications: { notify: () => {} } as unknown as NotificationService,
    statePath,
    legacyStatePath,
  })
}

describe('the DDNS cache file', () => {
  it('has a name no server entry’s state file can take', () => {
    const name = path.basename(workspaceDdnsStatePath('default'))
    for (const suffix of ['.run.json', '.spec.json', '.json']) {
      if (name.endsWith(suffix))
        expect(SERVER_ID.test(name.slice(0, -suffix.length)), `${name} is <id>${suffix} for a valid id`).toBe(false)
    }
  })

  it('adopts the cache an older release left under the old name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-ddns-legacy-'))
    dirs.push(dir)
    const legacy = path.join(dir, 'ddns.json')
    const current = path.join(dir, 'ddns.cache.json')
    fs.writeFileSync(legacy, JSON.stringify({ version: 1, updatedAt: 1, records: { 'home.example.com|A': { ip: '203.0.113.7', updatedAt: 1 } } }))

    service(current, legacy)

    expect(JSON.parse(fs.readFileSync(current, 'utf8')).records['home.example.com|A'].ip).toBe('203.0.113.7')
    expect(fs.existsSync(legacy)).toBe(false)
  })

  it('leaves a persistent `ddns` entry’s nanny state where it is', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-ddns-legacy-'))
    dirs.push(dir)
    const legacy = path.join(dir, 'ddns.json')
    const nanny = JSON.stringify({ serverId: 'ddns', nannyPid: 1234, childPid: 1235, startedAt: 1, logFile: '', heartbeatAt: 1 })
    fs.writeFileSync(legacy, nanny)

    service(path.join(dir, 'ddns.cache.json'), legacy)

    expect(fs.readFileSync(legacy, 'utf8')).toBe(nanny)
    expect(fs.existsSync(path.join(dir, 'ddns.cache.json'))).toBe(false)
  })

  it('keeps the two paths distinct', () => {
    expect(workspaceDdnsStatePath('w')).not.toBe(workspaceLegacyDdnsStatePath('w'))
  })
})
