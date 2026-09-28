import { describe, expect, it } from 'vitest'
import { captureItems, dataId, includeIds } from '../src/components/settings/backupSelection'

function pathEntry(overrides: Partial<Parameters<typeof dataId>[0]> = {}) {
  return { path: '/srv/app/data', origin: 'app:DATA_DIR', included: true, note: null, ...overrides }
}

describe('backup selection', () => {
  it('offers the panel state, then every path a backup would capture', () => {
    const items = captureItems([
      pathEntry({ id: 'data:/srv/app/data' }),
      pathEntry({ path: '/srv/covered', origin: 'global', included: false, note: 'covered by /srv/app/data' }),
    ])

    expect(items.map(item => item.id)).toEqual(['config', 'secrets', 'tls', 'data:/srv/app/data'])
    expect(items.at(-1)).toMatchObject({ label: '/srv/app/data', hint: 'from app:DATA_DIR' })
  })

  it('falls back to the id scheme an older panel does not send', () => {
    expect(dataId(pathEntry())).toBe('data:/srv/app/data')
    expect(captureItems([pathEntry()]).at(-1)?.id).toBe('data:/srv/app/data')
  })

  it('omits the selection when everything is checked, so the request stays unqualified', () => {
    const items = captureItems([pathEntry()]).map(item => ({ ...item, selected: true }))
    expect(includeIds(items)).toBeUndefined()

    items[0]!.selected = false
    expect(includeIds(items)).toEqual(['secrets', 'tls', 'data:/srv/app/data'])
  })

  it('sends an empty list only when nothing at all is checked', () => {
    const items = captureItems([]).map(item => ({ ...item, selected: false }))
    expect(includeIds(items)).toEqual([])
  })
})
