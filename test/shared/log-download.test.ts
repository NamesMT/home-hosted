import { describe, expect, it } from 'vitest'
import { existingLogFile } from '#src/shared/log-download'

/**
 * A download link must name a file the panel holds.
 *
 * `GET /api/logs/:id/download` answers `404 UNKNOWN_LOG_FILE` for a name that is not in the entry's
 * file list, so a link built from convention is a control that always fails. Both UIs built one:
 *
 * - `uis/stock`'s server detail page gated on `config.logBufferLines > 0` (the in-memory buffer);
 * - `uis/noc-console`'s Logs page gated on `enabled` (the workspace's `logs.persist` setting).
 *
 * Measured against the running dev panel at 1280 px, `/w/default/servers/python` rendered a visible
 * 32×32 download link and `/w/default/logs` a visible 126×24 one, both to
 * `/api/logs/python/download?file=python.log&workspace=default`, and that URL answered **404** while
 * `/api/logs` reported `files: []` for the same entry.
 */
describe('the log download picks only a file that exists', () => {
  it('offers the conventional name when the panel lists it', () => {
    expect(existingLogFile([{ name: 'web.log' }], 'web.log')).toBe('web.log')
  })

  it('offers nothing when the list is empty, however persistence is configured', () => {
    // The defect: persistence on (`enabled: true`) with no file written yet.
    expect(existingLogFile([], 'web.log')).toBeNull()
  })

  it('offers nothing when only rotations exist, since the conventional name is not among them', () => {
    expect(existingLogFile([{ name: 'web.log.1' }, { name: 'web.log.2' }], 'web.log')).toBeNull()
  })

  it('never answers with a name the panel does not list', () => {
    const listed = [{ name: 'web.log' }, { name: 'web.log.1' }]
    const answer = existingLogFile(listed, 'other.log')
    expect(answer).toBeNull()
    // The contract that matters: whatever comes back is downloadable.
    expect(listed.some(file => file.name === answer)).toBe(false)
  })
})
