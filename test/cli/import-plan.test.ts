import { describe, expect, it } from 'vitest'
import { composeEntry, parseMemoryLimit, planPm2Apps, slugifyId, splitArgs } from '#src/cli/import-plan'

/**
 * The pure half of `import`: pm2's fields onto this panel's, and the refusals.
 *
 * Every case here is a decision a person would notice. The mapping is where an import either carries
 * a setup faithfully or silently changes how it runs, so each field is pinned against the container
 * it claims — and each thing pm2 has that this panel does not is a **reported** warning, never a
 * silent drop.
 */

describe('the pm2 mapping', () => {
  it('runs the interpreter with the script as its first argument', () => {
    // pm2 runs `node server.js`; this panel spawns `command` with `args`, so the script has to move
    // into the args or the entry asks for a program named `server.js`.
    const { entries } = planPm2Apps([{ name: 'api', script: 'server.js', interpreter: 'node' }])
    expect(entries[0]).toMatchObject({ id: 'api', command: 'node', args: ['server.js'] })
  })

  it('defaults the interpreter to node, as pm2 does', () => {
    const { entries } = planPm2Apps([{ name: 'api', script: 'server.js' }])
    expect(entries[0]).toMatchObject({ command: 'node', args: ['server.js'] })
  })

  it('keeps a non-node interpreter', () => {
    const { entries } = planPm2Apps([{ name: 'py', script: 'main.py', interpreter: 'python3' }])
    expect(entries[0]).toMatchObject({ command: 'python3', args: ['main.py'] })
  })

  it('carries cwd, env, autorestart, retries and a memory ceiling', () => {
    const { entries } = planPm2Apps([{
      name: 'api',
      script: 'server.js',
      cwd: '/srv/api',
      env: { NODE_ENV: 'production', PORT: 4000 },
      autorestart: false,
      max_restarts: 5,
      max_memory_restart: '512M',
    }])
    expect(entries[0]).toMatchObject({
      cwd: '/srv/api',
      // A numeric env value becomes a string: the child's environment is text.
      env: { NODE_ENV: 'production', PORT: '4000' },
      restart: { enabled: false, maxRetries: 5 },
      resources: { maxRssBytes: 512 * 1024 * 1024 },
    })
  })

  it('reports what it cannot carry, naming the app', () => {
    const { entries, warnings } = planPm2Apps([{ name: 'api', script: 'server.js', watch: true, cron_restart: '0 3 * * *', instances: 4, exec_mode: 'cluster' }])
    expect(entries).toHaveLength(1)
    expect(warnings.join('\n')).toContain('watch')
    expect(warnings.join('\n')).toContain('cron_restart')
    expect(warnings.join('\n')).toContain('cluster')
    for (const warning of warnings)
      expect(warning, 'a warning names the app it is about').toContain('api')
  })

  it('refuses two names that become one id, and keeps the rest', () => {
    const { entries, errors } = planPm2Apps([
      { name: 'my app', script: 'a.js' },
      { name: 'my-app', script: 'b.js' },
      { name: 'other', script: 'c.js' },
    ])
    expect(entries.map(entry => entry.id)).toEqual(['my-app', 'other'])
    expect(errors.join('\n')).toContain('collision')
  })

  it('refuses an app with no script or no name', () => {
    const { entries, errors } = planPm2Apps([{ name: 'broken' }, { script: 'x.js' }])
    expect(entries).toEqual([])
    expect(errors).toHaveLength(2)
  })
})

describe('the small parsers', () => {
  it('slugifies a free-text pm2 name into an id', () => {
    expect(slugifyId('My App')).toBe('my-app')
    expect(slugifyId('  api/worker  ')).toBe('api-worker')
    expect(slugifyId('already-fine_1')).toBe('already-fine_1')
    // A name that is all punctuation still needs an id, and `app` is the honest placeholder.
    expect(slugifyId('***')).toBe('app')
  })

  it('splits pm2 args on whitespace and flags a quoted one', () => {
    expect(splitArgs('--port 4000 --verbose')).toEqual({ args: ['--port', '4000', '--verbose'], quoted: false })
    expect(splitArgs('   ')).toEqual({ args: [], quoted: false })
    // Quoting is reported rather than guessed: a shell parse is where an import silently changes a
    // program's arguments.
    expect(splitArgs('--msg "hello world"').quoted).toBe(true)
  })

  it.each([
    ['200M', 200 * 1024 * 1024],
    ['1G', 1024 ** 3],
    ['512K', 512 * 1024],
    ['1024', 1024],
    ['  100m  ', 100 * 1024 ** 2],
    [2048, 2048],
  ])('reads a memory limit of %s', (raw, expected) => {
    expect(parseMemoryLimit(raw)).toBe(expected)
  })

  it.each([['nonsense'], [''], [0], [-1], [null], [undefined]])('answers null for %s', (raw) => {
    expect(parseMemoryLimit(raw)).toBeNull()
  })

  it('writes a compose entry whose argv the panel can detect as a stack', () => {
    const entry = composeEntry('/srv/stack/docker-compose.yml', 'stack', '/srv/stack')
    expect(entry).toMatchObject({
      id: 'stack',
      command: 'docker',
      args: ['compose', '-f', '/srv/stack/docker-compose.yml', 'up'],
      cwd: '/srv/stack',
      autostart: true,
    })
  })
})
