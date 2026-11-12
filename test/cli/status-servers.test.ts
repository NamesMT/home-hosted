import { describe, expect, it } from 'vitest'
import { serverLines } from '#src/cli/status'

/**
 * `status` said "running — a server needs attention" and named none: the person had to open the
 * panel or run `usage` to find out which. It now lists every server, the broken ones first.
 */
describe('the servers status lists', () => {
  it('names the one needing attention first, and marks it', () => {
    const lines = serverLines([
      { id: 'web', workspaceId: 'default', status: 'running' },
      { id: 'worker', workspaceId: 'default', status: 'crashed' },
      { id: 'jellyfin', workspaceId: 'media', status: 'stopped' },
    ])
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^worker +crashed +← needs attention$/)
    expect(lines.slice(1).join('\n')).toContain('web')
    expect(lines.slice(1).join('\n')).toContain('media/jellyfin')
    expect(lines.slice(1).join('\n')).not.toContain('needs attention')
  })

  it('marks a port conflict too', () => {
    expect(serverLines([{ id: 'api', workspaceId: 'default', status: 'conflict' }])[0]).toContain('needs attention')
  })

  it('prints nothing for a panel with no servers', () => {
    expect(serverLines([])).toEqual([])
  })
})
