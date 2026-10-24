import type { ComposeTarget, ContainerRow } from '#src/providers/docker'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attributeContainers,
  composeTarget,

  DockerMetrics,
  findComposeFile,
  isComposeCommand,
  isOwnStack,
  parseComposeHead,
  parseDockerPs,
  parseDockerStats,
  parseHumanBytes,
  parseMemUsage,
  parsePercent,
  stopComposeContainers,
  sumContainers,
} from '#src/providers/docker'
import { hasDockerTestImage } from '../support/capabilities'

/**
 * Fixtures below are **captured from the real CLI** on this machine (docker 29.8.0 / compose
 * v5.6.0), not written from memory: the `ps` lines are the tab-separated `--format` this provider
 * asks for, and the stats lines are the untouched `docker stats --no-stream --format json` output
 * of a real two-container project. The live suite at the bottom drives a real stack as well; these
 * pin the parsing and the attribution, which a live run cannot assert exactly.
 */
const PS_OUTPUT = [
  'b460f60e4c26\thhmetricsprobe-burner-1\thhmetricsprobe\t/tmp/hh-metrics-probe/compose.yaml',
  'f1c24ecd33bd\thhmetricsprobe-idle-1\thhmetricsprobe\t/tmp/hh-metrics-probe/compose.yaml',
  'a04f5e0a8696\tcloudflare-ddns\t\t',
].join('\n')

/** Real stats lines: one busy container and one idle, from the same project. */
const STATS_OUTPUT = [
  '{"BlockIO":"0B / 0B","CPUPerc":"99.61%","Container":"b460f60e4c264b10de1b5e08e45ddc41b0ce3869171f7a5ba3ee5f021aed3bf5","ID":"b460f60e4c26","MemPerc":"1.25%","MemUsage":"816KiB / 64MiB","Name":"hhmetricsprobe-burner-1","NetIO":"538B / 126B","PIDs":"1"}',
  '{"BlockIO":"0B / 0B","CPUPerc":"2.18%","Container":"f1c24ecd33bddc91503be0b57a533e7242281ee3283f10002ec3669c7b93c38b","ID":"f1c24ecd33bd","MemPerc":"0.00%","MemUsage":"1.035MiB / 27.21GiB","Name":"hhmetricsprobe-idle-1","NetIO":"1.7kB / 126B","PIDs":"2"}',
].join('\n')

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A throwaway project directory, optionally holding a named compose file. */
function project(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-compose-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}

describe('docker CLI output parsing', () => {
  it('reads the tab-separated ps lines, keeping a container with no compose labels unattributed', () => {
    const rows = parseDockerPs(PS_OUTPUT)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      id: 'b460f60e4c26',
      name: 'hhmetricsprobe-burner-1',
      project: 'hhmetricsprobe',
      configFiles: ['/tmp/hh-metrics-probe/compose.yaml'],
    })
    // A `docker run` container has no project, and must not be attributed to one.
    expect(rows[2]!.project).toBeNull()
    expect(rows[2]!.configFiles).toEqual([])
  })

  it('reads one JSON object per line, including a container with no reading', () => {
    const readings = parseDockerStats(STATS_OUTPUT)
    expect(readings.get('b460f60e4c26')).toEqual({ cpuPercent: 99.61, rssBytes: 816 * 1024, processes: 1 })
    expect(readings.get('f1c24ecd33bd')).toEqual({ cpuPercent: 2.18, rssBytes: Math.round(1.035 * 1024 * 1024), processes: 2 })
  })

  it('refuses a container whose stats say nothing, rather than reading it as zero', () => {
    // `--` is what docker prints for a container it has no figure for; `0%` would be a measurement.
    const readings = parseDockerStats('{"CPUPerc":"--","ID":"abc","MemUsage":"-- / --","PIDs":"--"}')
    expect(readings.size).toBe(0)
  })

  it('ignores a line that is not JSON at all', () => {
    const readings = parseDockerStats(`${STATS_OUTPUT}\nnot json`)
    expect(readings.size).toBe(2)
  })

  it('parses docker human sizes, and refuses one it cannot read', () => {
    expect(parseHumanBytes('0B')).toBe(0)
    expect(parseHumanBytes('816KiB')).toBe(816 * 1024)
    expect(parseHumanBytes('251.4MiB')).toBeCloseTo(251.4 * 1024 * 1024)
    expect(parseHumanBytes('1.5GiB')).toBeCloseTo(1.5 * 1024 ** 3)
    expect(parseHumanBytes('12MB')).toBe(12_000_000)
    // An unknown unit is "no reading", never a zero.
    expect(parseHumanBytes('12XB')).toBeNull()
    expect(parseHumanBytes('')).toBeNull()
  })

  it('takes only the used half of MemUsage', () => {
    expect(parseMemUsage('816KiB / 64MiB')).toBe(816 * 1024)
    expect(parseMemUsage('0B / 0B')).toBe(0)
    expect(parseMemUsage('-- / --')).toBeNull()
  })

  it('parses a CPU percentage, and treats docker’s missing value as absent', () => {
    expect(parsePercent('99.61%')).toBe(99.61)
    expect(parsePercent('0.00%')).toBe(0)
    expect(parsePercent('--')).toBeNull()
  })
})

describe('compose detection', () => {
  it('detects `docker compose` and `docker-compose`, and nothing else', () => {
    const cwd = project({ 'compose.yaml': 'services: {}' })
    expect(composeTarget({ command: 'docker', args: ['compose', 'up'], cwd, env: {} })).not.toBeNull()
    expect(composeTarget({ command: 'docker-compose', args: ['up'], cwd, env: {} })).not.toBeNull()
    // The documented limits, asserted so the module comment cannot drift from the code.
    expect(composeTarget({ command: 'bash', args: ['-c', 'docker compose up'], cwd, env: {} }), 'a shell that runs docker is not detectable').toBeNull()
    expect(composeTarget({ command: 'docker', args: ['run', 'nginx'], cwd, env: {} }), 'docker run has no compose project').toBeNull()
    expect(composeTarget({ command: 'node', args: ['server.js'], cwd, env: {} })).toBeNull()
  })

  it('reads the project name from -p, --project-name, the attached form and the environment', () => {
    const cwd = project({ 'compose.yaml': 'services: {}' })
    const name = (args: string[], env: Record<string, string> = {}): string | null =>
      composeTarget({ command: 'docker', args, cwd, env })?.key ?? null
    expect(name(['compose', '-p', 'blog', 'up'])).toBe('project:blog')
    expect(name(['compose', '--project-name', 'blog', 'up'])).toBe('project:blog')
    expect(name(['compose', '--project-name=blog', 'up'])).toBe('project:blog')
    expect(name(['compose', '-pblog', 'up'])).toBe('project:blog')
    expect(name(['compose', 'up'], { COMPOSE_PROJECT_NAME: 'blog' })).toBe('project:blog')
    // A flag after the subcommand never reaches compose itself (`unknown shorthand flag: 'p'`).
    expect(name(['compose', 'up', '-p', 'blog'])).toBe(`files:${path.join(cwd, 'compose.yaml')}`)
  })

  it('finds the compose file the way compose does: cwd, then a parent directory', () => {
    const root = project({ 'compose.yml': 'services: {}' })
    const nested = path.join(root, 'apps', 'web')
    fs.mkdirSync(nested, { recursive: true })
    expect(composeTarget({ command: 'docker', args: ['compose', 'up'], cwd: nested, env: {} })?.configFiles)
      .toEqual([path.join(root, 'compose.yml')])
  })

  it('honours an explicit compose file, resolved against the project directory', () => {
    const cwd = project({})
    const elsewhere = project({ 'stack.yaml': 'services: {}' })
    const file = path.join(elsewhere, 'stack.yaml')
    expect(composeTarget({ command: 'docker', args: ['compose', '-f', file, 'up'], cwd, env: {} })?.configFiles).toEqual([file])
    expect(composeTarget({ command: 'docker', args: ['compose', '--file', file, 'up'], cwd, env: {} })?.configFiles).toEqual([file])
    expect(composeTarget({ command: 'docker', args: ['compose', '--file=stack.yaml', 'up'], cwd: elsewhere, env: {} })?.configFiles).toEqual([file])
  })

  it('reads flags that sit before the docker subcommand without treating their value as the subcommand', () => {
    const cwd = project({ 'compose.yaml': 'services: {}' })
    expect(composeTarget({ command: 'docker', args: ['--context', 'remote', 'compose', 'up'], cwd, env: {} })).not.toBeNull()
    expect(composeTarget({ command: 'docker', args: ['--context=remote', 'compose', 'up'], cwd, env: {} })).not.toBeNull()
  })

  it('refuses an entry with neither a project name nor a compose file to attribute by', () => {
    // Nothing to match containers against, so guessing would sum the whole box into this entry.
    expect(composeTarget({ command: 'docker', args: ['compose', 'up'], cwd: project({}), env: {} })).toBeNull()
  })

  it('reports the subcommand position, so an option value is never read as the subcommand', () => {
    expect(parseComposeHead(['-p', 'blog', 'up', '-d']).subcommandAt).toBe(2)
    expect(parseComposeHead(['-p', 'blog', 'up', '-d']).projectName).toBe('blog')
    expect(parseComposeHead(['up', '-d']).subcommandAt).toBe(0)
  })
})

const ROWS: ContainerRow[] = parseDockerPs(PS_OUTPUT)

/**
 * Which stack a published port belongs to, so the refusal can name the right escape hatch.
 *
 * A docker-published port held by *this entry's own* stack is not a stranger and not a conflict: it
 * is the server, already up. The sentence offered only `kill` — which throws the stack away to reach
 * the state it was already in — while the hatch a person wants is to let the panel attach to it.
 * `isOwnStack` is the one predicate that decides which sentence is true, so it is pinned here.
 */
describe('telling this entry’s own stack from a stranger’s', () => {
  const target: ComposeTarget = { key: 'project:blog', project: 'blog', configFiles: ['/srv/blog/compose.yaml'] }

  it('matches the project name docker reports against the one the entry declares', () => {
    expect(isOwnStack({ project: 'blog', composeDir: null }, target), 'the same project is this entry’s own stack').toBe(true)
    expect(isOwnStack({ project: 'other', composeDir: null }, target), 'another project is not').toBe(false)
  })

  it('falls back to the working directory when neither side names a project', () => {
    // Most entries never pass `-p`, so both projects are null — the directory compose recorded is
    // then the only evidence, and it is the one holding this entry's compose file.
    const unnamed: ComposeTarget = { key: 'files:/srv/blog/compose.yaml', project: null, configFiles: ['/srv/blog/compose.yaml'] }
    expect(isOwnStack({ project: null, composeDir: '/srv/blog' }, unnamed)).toBe(true)
    expect(isOwnStack({ project: null, composeDir: '/srv/other' }, unnamed), 'a different directory is another stack').toBe(false)
  })

  it('refuses to guess when there is nothing to hold the two together', () => {
    // A plain `docker run` container has neither label, and a bare project with no directory cannot
    // be attributed to a compose file either.
    expect(isOwnStack({ project: null, composeDir: null }, target)).toBe(false)
    expect(isOwnStack({ project: 'blog', composeDir: null }, null)).toBe(false)
    expect(isOwnStack({ project: 'blog', composeDir: null }, { key: 'files:/srv/x/compose.yaml', project: null, configFiles: [] })).toBe(false)
    // `null === null` must not read as a match on the project half.
    expect(isOwnStack({ project: null, composeDir: '/srv/blog' }, { key: 'files:/srv/x/compose.yaml', project: null, configFiles: ['/srv/x/compose.yaml'] })).toBe(false)
  })

  it('recognizes a compose argv without resolving anything, for a stop of an entry never started', () => {
    expect(isComposeCommand('docker', ['compose', 'up'])).toBe(true)
    expect(isComposeCommand('docker-compose', ['up'])).toBe(true)
    expect(isComposeCommand('docker', ['run', 'nginx'])).toBe(false)
    expect(isComposeCommand('node', ['server.js'])).toBe(false)
  })
})

describe('attribution', () => {
  function target(overrides: Partial<ComposeTarget>): ComposeTarget {
    return { key: 'k', project: null, configFiles: [], ...overrides }
  }

  it('matches a named project exactly, excluding another project in the same directory', () => {
    const rows = parseDockerPs([
      'aaa\tone-web-1\tproj-one\t/srv/shared/compose.yaml',
      'bbb\ttwo-web-1\tproj-two\t/srv/shared/compose.yaml',
    ].join('\n'))
    const matched = attributeContainers(target({ project: 'proj-one' }), rows)
    expect(matched?.map(row => row.name)).toEqual(['one-web-1'])
  })

  it('falls back to the compose file, which still separates two projects by label', () => {
    const rows = parseDockerPs([
      'aaa\tone-web-1\tproj-one\t/srv/shared/compose.yaml',
      'bbb\ttwo-web-1\tproj-two\t/srv/shared/compose.yaml',
    ].join('\n'))
    // Same file, two projects: matching by file alone could not tell them apart, so the file key
    // is only used when the project label is uniform.
    expect(attributeContainers(target({ configFiles: ['/srv/shared/compose.yaml'] }), rows), 'two projects behind one file is ambiguous').toBeNull()
  })

  it('matches by compose file when every container agrees on the project', () => {
    const matched = attributeContainers(target({ configFiles: ['/tmp/hh-metrics-probe/compose.yaml'] }), ROWS)
    expect(matched?.map(row => row.name)).toEqual(['hhmetricsprobe-burner-1', 'hhmetricsprobe-idle-1'])
    // The unattributed `docker run` container is never included.
    expect(matched?.map(row => row.name)).not.toContain('cloudflare-ddns')
  })

  it('matches a compose file with the case-insensitivity the platform has', () => {
    const rows = parseDockerPs('aaa\tone-web-1\tproj-one\tC:\\srv\\Blog\\compose.yaml')
    const matched = attributeContainers(target({ configFiles: ['c:/srv/blog/compose.yaml'] }), rows)
    // On this Linux runner the two paths differ; on Windows they are the same file.
    const expected = process.platform === 'win32' ? 1 : 0
    expect(matched).toHaveLength(expected)
  })
})

describe('summing one project', () => {
  const readings = parseDockerStats(STATS_OUTPUT)

  it('sums CPU, RSS and processes across the project’s containers', () => {
    const summed = sumContainers(attributeContainers({ key: 'k', project: 'hhmetricsprobe', configFiles: [] }, ROWS)!, readings)
    expect(summed).toEqual({
      cpuPercent: 101.8,
      rssBytes: 816 * 1024 + Math.round(1.035 * 1024 * 1024),
      processes: 3,
      containers: 2,
    })
  })

  it('answers no reading for an empty project, not a zero', () => {
    // The distinction the repo rule turns on: `0` is a measured idle stack.
    expect(sumContainers([], readings)).toBeNull()
  })

  it('refuses a sum it cannot complete, rather than under-reporting', () => {
    // A container in the listing without a stats line would make the total smaller than the truth,
    // which is the one direction a memory ceiling must not miss.
    const rows = attributeContainers({ key: 'k', project: 'hhmetricsprobe', configFiles: [] }, ROWS)!
    const partial = new Map(readings)
    partial.delete(rows[1]!.id)
    expect(sumContainers(rows, partial)).toBeNull()
  })
})

/**
 * A `docker` shim first on `PATH` that answers `ps` and `stats` from fixture **files**.
 *
 * The fixtures go in files rather than in the shim's `printf` because docker's JSON is full of `%`
 * — `CPUPerc` is `"99.61%"` — and `printf` would interpret that as a format specifier, quietly
 * writing a fixture that no longer matches the real output. `body` records each argv line and
 * restores `PATH` afterwards.
 *
 * A `#!/bin/sh` shim, so these tests are skipped on Windows rather than faked there.
 */
async function withDockerShim(files: { ps?: string, stats?: string }, body: (calls: () => string[]) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-docker-shim-'))
  dirs.push(dir)
  if (files.ps !== undefined)
    fs.writeFileSync(path.join(dir, 'ps.out'), files.ps)
  if (files.stats !== undefined)
    fs.writeFileSync(path.join(dir, 'stats.out'), files.stats)

  const calls = path.join(dir, 'calls')
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh
printf '%s ' "$@" >> '${calls}'
printf '\\n' >> '${calls}'
case "$1" in
  ps) [ -f '${dir}/ps.out' ] && cat '${dir}/ps.out' ;;
  stats) [ -f '${dir}/stats.out' ] && cat '${dir}/stats.out' ;;
esac
exit 0
`, { mode: 0o755 })

  const original = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${original ?? ''}`
  try {
    await body(() => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [])
  }
  finally {
    process.env.PATH = original
  }
}

/** The shim is a `#!/bin/sh` script, so Windows cannot run it; the production path is cross-platform. */
const posixShim = it.runIf(process.platform !== 'win32')

/**
 * Stopping a stack answers from a **fresh listing**, never from `docker stop`'s exit code.
 *
 * `docker stop` exits 0 for a container it could not end, so trusting it is the empty success these
 * cases exist to refuse — a stop the page reports as done over a stack that is still serving. The
 * shim keeps a running set in a file that `stop` rewrites, so "did it stop" is read the same way the
 * real code reads it: by asking docker again.
 */
describe('stopping a compose stack', () => {
  posixShim('stops every container and reports the ones that are gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-docker-stack-'))
    dirs.push(dir)
    const running = path.join(dir, 'running')
    const survivors = path.join(dir, 'survivors')
    const calls = path.join(dir, 'calls')
    fs.writeFileSync(running, 'blog-web-1\nblog-db-1\n')
    fs.writeFileSync(survivors, '')
    fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh
printf '%s ' "$@" >> '${calls}'
printf '\\n' >> '${calls}'
case "$1" in
  ps)
    while read -r name; do
      [ -n "$name" ] && printf 'id-%s\\t%s\\tblog\\t/srv/blog/compose.yaml\\n' "$name" "$name"
    done < '${running}'
    ;;
  stop)
    shift
    for name in "$@"; do
      if ! grep -qx "$name" '${survivors}' 2>/dev/null; then
        grep -vx "$name" '${running}' > '${running}.tmp' || true
        mv '${running}.tmp' '${running}'
      fi
    done
    ;;
esac
exit 0
`, { mode: 0o755 })

    const original = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${original ?? ''}`
    try {
      const target: ComposeTarget = { key: 'project:blog', project: 'blog', configFiles: [] }
      const outcome = await stopComposeContainers(target)
      expect(outcome).toEqual({ stopped: ['blog-web-1', 'blog-db-1'], survivors: [] })
      // One ps, one stop naming both, one ps: the answer is the listing after, not the exit code.
      const invoked = fs.readFileSync(calls, 'utf8').trim().split('\n')
      expect(invoked[0]).toContain('ps')
      expect(invoked[1]).toContain('stop blog-web-1 blog-db-1')
      expect(invoked[2]).toContain('ps')
    }
    finally {
      process.env.PATH = original
    }
  })

  posixShim('reports a container that stayed up as a survivor, not as stopped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-docker-stack-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'running'), 'blog-web-1\nblog-db-1\n')
    fs.writeFileSync(path.join(dir, 'survivors'), 'blog-db-1\n')
    fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh
case "$1" in
  ps)
    while read -r name; do
      [ -n "$name" ] && printf 'id-%s\\t%s\\tblog\\t/srv/blog/compose.yaml\\n' "$name" "$name"
    done < '${dir}/running'
    ;;
  stop)
    shift
    for name in "$@"; do
      if ! grep -qx "$name" '${dir}/survivors' 2>/dev/null; then
        grep -vx "$name" '${dir}/running' > '${dir}/running.tmp' || true
        mv '${dir}/running.tmp' '${dir}/running'
      fi
    done
    exit 0
    ;;
esac
exit 0
`, { mode: 0o755 })

    const original = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${original ?? ''}`
    try {
      const target: ComposeTarget = { key: 'project:blog', project: 'blog', configFiles: [] }
      const outcome = await stopComposeContainers(target)
      // The shim exits 0 for the container it kept — which is exactly why the exit code is not read.
      expect(outcome!.survivors, 'a stop that printed success is not a stop that worked').toEqual(['blog-db-1'])
      expect(outcome!.stopped).toEqual(['blog-web-1'])
    }
    finally {
      process.env.PATH = original
    }
  })

  posixShim('answers null when docker cannot be asked, rather than "nothing is running"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-docker-stack-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const original = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${original ?? ''}`
    try {
      const target: ComposeTarget = { key: 'project:blog', project: 'blog', configFiles: [] }
      expect(await stopComposeContainers(target)).toBeNull()
    }
    finally {
      process.env.PATH = original
    }
  })
})

describe('the container metrics reader', () => {
  posixShim('batches every target into one stats call naming all their containers', async () => {
    // The assertion is about *one* spawn carrying both containers, so the shim records argv.
    await withDockerShim({ ps: PS_OUTPUT, stats: STATS_OUTPUT }, async (calls) => {
      const metrics = new DockerMetrics()
      const targets: ComposeTarget[] = [{ key: 'project:hhmetricsprobe', project: 'hhmetricsprobe', configFiles: [] }]
      metrics.readings(targets, 1000)
      await metrics.settle()

      const invoked = calls()
      expect(invoked).toHaveLength(2)
      expect(invoked[0]).toContain('ps')
      // One `stats` spawn naming both containers of the project, and no container of another.
      expect(invoked[1]).toContain('stats --no-stream --format json b460f60e4c26 f1c24ecd33bd')

      expect(metrics.readings(targets, 1000).get('project:hhmetricsprobe')).toEqual({
        cpuPercent: 101.8,
        rssBytes: 816 * 1024 + Math.round(1.035 * 1024 * 1024),
        processes: 3,
        containers: 2,
      })
    })
  })

  posixShim('reuses a reading inside the cache window instead of spawning again', async () => {
    await withDockerShim({ ps: PS_OUTPUT, stats: STATS_OUTPUT }, async (calls) => {
      const metrics = new DockerMetrics()
      const targets: ComposeTarget[] = [{ key: 'project:hhmetricsprobe', project: 'hhmetricsprobe', configFiles: [] }]
      metrics.readings(targets, 1000)
      await metrics.settle()
      expect(calls()).toHaveLength(2)

      // Well inside the window: no spawn at all.
      metrics.readings(targets, 5000)
      await metrics.settle()
      expect(calls(), 'a reading younger than the window must be reused').toHaveLength(2)

      // Past it, one more pair of calls — not one per entry.
      metrics.readings(targets, 60_000)
      await metrics.settle()
      expect(calls()).toHaveLength(4)
    })
  })

  posixShim('reports no reading when docker is unavailable, never a zero', async () => {
    // A shim that fails like a stopped daemon: docker prints its error on stderr and exits 1.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-docker-down-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n', { mode: 0o755 })
    const original = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${original ?? ''}`
    try {
      const metrics = new DockerMetrics()
      const targets: ComposeTarget[] = [{ key: 'project:blog', project: 'blog', configFiles: [] }]
      metrics.readings(targets, 1000)
      await metrics.settle()

      expect(metrics.readings(targets, 1000).size, 'docker being down must not look like an idle stack').toBe(0)
      expect(metrics.readings(targets, 1000).get('project:blog')).toBeUndefined()
    }
    finally {
      process.env.PATH = original
    }
  })

  it('starts no refresh when no entry is docker-backed', async () => {
    const metrics = new DockerMetrics()
    expect(metrics.readings([], 1000).size).toBe(0)
    // Nothing was spawned, so this resolves immediately and the cache stays empty.
    await metrics.settle()
    expect(metrics.readings([], 1000).size).toBe(0)
  })

  posixShim('leaves an entry with no running container to the process-tree sample', async () => {
    await withDockerShim({ ps: '' }, async () => {
      const metrics = new DockerMetrics()
      const targets: ComposeTarget[] = [{ key: 'project:stopped', project: 'stopped', configFiles: [] }]
      metrics.readings(targets, 1000)
      await metrics.settle()
      expect(metrics.readings(targets, 1000).has('project:stopped')).toBe(false)
    })
  })
})

describe('findComposeFile', () => {
  it('prefers the names compose prefers, in order', () => {
    const dir = project({ 'docker-compose.yml': '', 'compose.yml': '', 'compose.yaml': '' })
    expect(findComposeFile(dir)).toEqual([path.join(dir, 'compose.yaml')])
  })

  it('answers nothing for a directory tree with no compose file', () => {
    expect(findComposeFile(project({}))).toEqual([])
  })
})

/**
 * The live path, driven against a **real** docker daemon when this machine has one.
 *
 * Everything above pins parsing and attribution, which a live stack cannot assert exactly. What it
 * can answer, and no fixture can, is the question the feature exists for: does a busy container show
 * up at all, where the compose wrapper reports idle? The first test asserts the summed CPU is a real
 * measurement of the spinning container, and the second that another project's containers are not
 * summed in.
 *
 * Skipped, not silently passed, when there is no daemon or no `alpine:3.20` image on this machine —
 * `hasDockerTestImage` probes both, and `docker version` rather than `docker --version`, because a
 * client with no daemon behind it would make this a false pass. A skip here means the live path was
 * **not exercised**.
 */
describe('against a real docker daemon', () => {
  const live = it.runIf(hasDockerTestImage && process.platform !== 'win32')

  /** A project directory with one busy and one idle container, and no other project in that file. */
  function composeProject(): string {
    const dir = project({
      'compose.yaml': [
        'services:',
        '  burner:',
        '    image: alpine:3.20',
        '    command: ["sh", "-c", "i=0; while true; do i=$((i+1)); done"]',
        '  idle:',
        '    image: alpine:3.20',
        '    command: ["sh", "-c", "while true; do sleep 1; done"]',
      ].join('\n'),
    })
    // `docker compose` derives the project name from the directory, so it has to be a legal one.
    return dir
  }

  /** Runs compose in this test's own project directory; throws with its output on failure. */
  async function compose(dir: string, args: string[]): Promise<string> {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('docker', ['compose', ...args], { cwd: dir, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
    return stdout
  }

  live('sums a real stack’s containers where the wrapper reads idle', async () => {
    const dir = composeProject()
    const projectName = `hhlive${path.basename(dir).replace(/[^a-z0-9]/gi, '').toLowerCase()}`
    try {
      await compose(dir, ['-p', projectName, 'up', '-d'])
      // The stack needs a moment before stats report the burner's real CPU.
      await new Promise(resolve => setTimeout(resolve, 4000))

      const target = composeTarget({ command: 'docker', args: ['compose', '-p', projectName, 'up'], cwd: dir, env: {} })
      expect(target, 'a real `docker compose` argv must be detected').not.toBeNull()

      const metrics = new DockerMetrics()
      metrics.readings([target!], Date.now())
      await metrics.settle()
      const reading = metrics.readings([target!], Date.now()).get(target!.key)

      expect(reading, 'the project’s containers must be measured, not the wrapper').toBeDefined()
      expect(reading!.containers).toBe(2)
      // The burner spins a core, so the summed CPU is a real measurement of it — the defect was
      // `cpuPercent: 0` for exactly this stack.
      expect(reading!.cpuPercent).toBeGreaterThan(50)
      expect(reading!.rssBytes).toBeGreaterThan(0)
    }
    finally {
      await compose(dir, ['-p', projectName, 'down', '--volumes', '--remove-orphans']).catch(() => {})
    }
  }, 240_000)

  live('excludes a container belonging to a different real project', async () => {
    const mine = composeProject()
    const other = composeProject()
    const mineName = `hhlivemine${path.basename(mine).replace(/[^a-z0-9]/gi, '').toLowerCase()}`
    const otherName = `hhliveother${path.basename(other).replace(/[^a-z0-9]/gi, '').toLowerCase()}`
    try {
      await compose(mine, ['-p', mineName, 'up', '-d'])
      await compose(other, ['-p', otherName, 'up', '-d'])
      await new Promise(resolve => setTimeout(resolve, 2000))

      const target = composeTarget({ command: 'docker', args: ['compose', '-p', mineName, 'up'], cwd: mine, env: {} })!
      const metrics = new DockerMetrics()
      metrics.readings([target], Date.now())
      await metrics.settle()
      const reading = metrics.readings([target], Date.now()).get(target.key)

      expect(reading).toBeDefined()
      // Only this project's two containers, never the three running in the other one.
      expect(reading!.containers, 'another project’s containers must not be summed in').toBe(2)
    }
    finally {
      await compose(mine, ['-p', mineName, 'down', '--volumes', '--remove-orphans']).catch(() => {})
      await compose(other, ['-p', otherName, 'down', '--volumes', '--remove-orphans']).catch(() => {})
    }
  }, 240_000)
})

/**
 * The panel's own environment is not the entry's.
 *
 * The panel often runs under compose, and inheriting its `COMPOSE_PROJECT_NAME` made that one name
 * every entry's project: measured with two entries, both reported the *same* `cpuPercent: 199.4,
 * rssBytes: 183500800` — each summing both stacks — and a `resources.maxRssBytes` ceiling on one
 * fired on the other's containers. That is the "attributes a stranger's containers" failure the
 * module exists to avoid, arriving through the panel's own env.
 */
describe('composeTarget and the panel environment', () => {
  const saved = process.env.COMPOSE_PROJECT_NAME
  afterEach(() => {
    if (saved === undefined)
      delete process.env.COMPOSE_PROJECT_NAME
    else
      process.env.COMPOSE_PROJECT_NAME = saved
  })

  it('ignores COMPOSE_PROJECT_NAME inherited from the panel process', () => {
    process.env.COMPOSE_PROJECT_NAME = 'shared-stack'
    const target = composeTarget({ command: 'docker', args: ['compose', 'up'], cwd: '/srv/one' })
    // The panel's own project name must not become this entry's key.
    expect(target?.key ?? '').not.toContain('shared-stack')
  })

  it('still honours the entry\'s own COMPOSE_PROJECT_NAME', () => {
    const target = composeTarget({
      command: 'docker',
      args: ['compose', 'up'],
      cwd: '/srv/one',
      env: { COMPOSE_PROJECT_NAME: 'entry-own' },
    })
    expect(target).toEqual(expect.objectContaining({ project: 'entry-own', key: 'project:entry-own' }))
  })

  it('still honours an explicit -p over any environment', () => {
    process.env.COMPOSE_PROJECT_NAME = 'shared-stack'
    const target = composeTarget({
      command: 'docker',
      args: ['compose', '-p', 'from-flag', 'up'],
      cwd: '/srv/one',
      env: { COMPOSE_PROJECT_NAME: 'entry-own' },
    })
    expect(target?.project).toBe('from-flag')
  })
})

/**
 * A restarting container must not publish as an idle one.
 *
 * `docker stats` prints `0.00% / 0B / 0 PIDs` for a container in `Restarting`, and every field
 * parses, so the sampler accepted it: measured, a flapping compose entry served
 * `hh_server_rss_bytes 0` and `hh_server_cpu_percent 0` steadily while the panel reported it
 * `running` — the zero the repo forbids, and structurally unable to trip `maxRssBytes`.
 * `PIDs 0` is the field that distinguishes "no processes" from "idle".
 */
describe('a container with no processes', () => {
  it('reports no reading rather than a zero', () => {
    const text = JSON.stringify({ ID: 'flap', CPUPerc: '0.00%', MemUsage: '0B / 1GiB', PIDs: '0' })
    expect(parseDockerStats(text).size).toBe(0)
  })

  it('still reads a genuinely idle container that has a process', () => {
    // Idle is not the same as absent: this one has a pid and a real memory figure.
    const text = JSON.stringify({ ID: 'calm', CPUPerc: '0.00%', MemUsage: '12.5MiB / 1GiB', PIDs: '1' })
    const reading = parseDockerStats(text).get('calm')
    expect(reading).toEqual(expect.objectContaining({ cpuPercent: 0 }))
    expect(reading?.rssBytes).toBeGreaterThan(0)
  })
})
