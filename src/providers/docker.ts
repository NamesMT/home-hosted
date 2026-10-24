import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { type } from 'arktype'

const execFileAsync = promisify(execFile)

/**
 * CPU and memory of a compose project's **containers**, which the process-tree sampler cannot see.
 *
 * A compose stack is not a process tree: `docker compose up` is a wrapper, and its containers live
 * in another namespace. A stack burning 99% CPU reported `cpuPercent: 0` — the wrapper — so
 * `resources.maxRssBytes` could never fire for a leaking container.
 *
 * Detection is deliberately narrow: `command` must be `docker` (with `compose`) or `docker-compose`.
 * A shell that runs docker and a `docker run` are not recognized and keep the process-tree sample,
 * because a wrong guess attributes a stranger's containers to an entry. An entry's own `env` and
 * `envFile` **are** read; the panel's own environment is not. Attribution is by compose's own
 * labels, never "every container on this machine".
 *
 * See `.agentDocs/GOTCHAS.md` ("Metrics") for the measured failure and the deliberate limits.
 */

/** How long a completed reading is reused. */
const DOCKER_CACHE_MS = 10_000

/**
 * `docker stats --no-stream` samples for about a second before printing (measured 2.0–2.2 s per
 * call here), so it is not a read to perform inside the 1 s supervisor tick: it would delay the
 * whole state frame. Nor one per entry per 5 s sample, which is why one call names every container
 * of every docker-backed entry.
 *
 * Reusing a reading for ten seconds keeps the frame responsive and cuts the spawns from roughly
 * 17 000 a day per entry to about 8 600 for the whole workspace; a memory ceiling that acts up to
 * ~12 s late is still a ceiling. The same discipline, and for the same reason, as `SWAP_CACHE_MS`
 * in `src/providers/host.ts`.
 */

/** The file names compose itself tries, in order, in the directory it runs from (or a parent of it). */
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']

/** A compose global option before the subcommand, whose value is the next word. */
const COMPOSE_VALUE_FLAGS = new Set(['-p', '--project-name', '-f', '--file', '--project-directory', '--env-file', '--profile', '--ansi', '--progress', '--parallel'])

/** A compose global option before the subcommand that takes no value. */
const COMPOSE_VALUELESS_FLAGS = new Set(['--compatibility', '--dry-run', '--no-ansi', '--verbose', '-h', '--help'])

/** `docker`'s own options before `compose`, whose value is the next word. */
const DOCKER_VALUE_FLAGS = new Set(['-c', '--context', '-H', '--host', '-l', '--log-level', '--config'])

const PS_FORMAT = '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.config_files"}}'

/** One container docker reports, with the labels that attribute it to a project. */
export interface ContainerRow {
  id: string
  name: string
  project: string | null
  configFiles: string[]
}

/** What one compose entry's containers add up to. */
export interface ComposeReading {
  /** Summed CPU share, so 200 is two saturated cores. */
  cpuPercent: number
  rssBytes: number
  /** Processes inside the containers — the same question the tree sampler answers. */
  processes: number
  /** How many containers the sum covers. */
  containers: number
}

/** The evidence that an entry runs a compose project, and the key its containers are attributed by. */
export interface ComposeTarget {
  /** What the caller looks the reading up by: the project, else the compose files. */
  key: string
  project: string | null
  configFiles: string[]
}

const EMPTY: ReadonlyMap<string, ComposeReading> = new Map()

/** One `docker stats --format json` line. Unknown keys are normal — docker adds fields over time. */
const statsLineSchema = type({
  'CPUPerc': 'string',
  'ID': 'string',
  'MemUsage': 'string',
  'PIDs': 'string',
  '+': 'ignore',
})

const BYTE_SCALES: Record<string, number> = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
  tb: 1000 ** 4,
  tib: 1024 ** 4,
}

/** `816KiB` -> bytes. Docker prints binary units for memory, and `0B` for a container that is not running. */
export function parseHumanBytes(value: string): number | null {
  const match = /^([\d.]+)\s*([a-z]+)$/i.exec(value.trim())
  if (match === null)
    return null
  const amount = Number.parseFloat(match[1]!)
  const scale = BYTE_SCALES[match[2]!.toLowerCase()]
  if (scale === undefined || !Number.isFinite(amount))
    return null
  return amount * scale
}

/** `MemUsage` is `used / limit`; only the used part measures this stack. */
export function parseMemUsage(value: string): number | null {
  const [used = ''] = value.split('/')
  return parseHumanBytes(used)
}

/** `99.61%` -> 99.61. `--` is docker's "no reading", which must not become a zero. */
export function parsePercent(value: string): number | null {
  const match = /^([\d.]+)%$/.exec(value.trim())
  if (match === null)
    return null
  const parsed = Number.parseFloat(match[1]!)
  return Number.isFinite(parsed) ? parsed : null
}

/** The containers docker reports, from the tab-separated `--format` above. */
export function parseDockerPs(text: string): ContainerRow[] {
  const rows: ContainerRow[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0)
      continue
    const [id = '', name = '', project = '', files = ''] = line.split('\t')
    if (id.trim().length === 0)
      continue
    rows.push({
      id: id.trim(),
      name: name.trim(),
      project: project.trim().length > 0 ? project.trim() : null,
      configFiles: files.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0),
    })
  }
  return rows
}

/** Per-container readings from `docker stats --no-stream --format json`, keyed by container id. */
export function parseDockerStats(text: string): Map<string, Omit<ComposeReading, 'containers'>> {
  const readings = new Map<string, Omit<ComposeReading, 'containers'>>()
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0)
      continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    }
    catch {
      continue
    }
    const parsed = statsLineSchema(raw)
    if (parsed instanceof type.errors)
      continue
    const cpuPercent = parsePercent(parsed.CPUPerc)
    const rssBytes = parseMemUsage(parsed.MemUsage)
    const processes = Number.parseInt(parsed.PIDs, 10)
    // One unreadable field makes the container unmeasured; a zero there would be invented.
    if (cpuPercent === null || rssBytes === null || !Number.isInteger(processes))
      continue
    /*
     * A container with no processes is not idle — it is not running this stack's work.
     *
     * `docker stats` prints `0.00% / 0B / 0 PIDs` for one in `Restarting`, and publishing that is
     * the zero the repo forbids: measured, a flapping entry served `hh_server_rss_bytes 0` and
     * `hh_server_cpu_percent 0`, steady while reported `running`, indistinguishable from a real
     * idle reading and structurally unable to trip `resources.maxRssBytes`. `PIDs 0` is the one
     * field that says so — a live container always has at least one.
     */
    if (processes === 0)
      continue
    // Docker prints a rounded human size (`1.035MiB`), so the byte value is fractional; rounded to
    // a whole byte here, so every reading has the same unit whatever produced it.
    readings.set(parsed.ID, { cpuPercent, rssBytes: Math.round(rssBytes), processes })
  }
  return readings
}

/** Same file, on a platform whose paths are case-insensitive. */
function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** The argv of the compose command this entry runs, or null when the entry is not docker-backed. */
function composeArgv(command: string, args: string[]): string[] | null {
  const name = path.basename(command).toLowerCase().replace(/\.exe$/, '')
  if (name === 'docker-compose')
    return args
  if (name !== 'docker')
    return null

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === 'compose')
      return args.slice(index + 1)
    if (arg.startsWith('-')) {
      // `docker --context box compose up`: the flag's value is not the subcommand.
      if (DOCKER_VALUE_FLAGS.has(arg) && !arg.includes('='))
        index += 1
      continue
    }
    // A different docker subcommand, so there is no compose project behind this entry.
    return null
  }
  return null
}

/**
 * The compose options before the subcommand, and where the subcommand starts.
 *
 * Compose requires its global options **before** the subcommand — it answers `unknown shorthand
 * flag: 'p'` for `up -p x` — so only this leading run can carry the project name or the file.
 */
export function parseComposeHead(args: string[]): {
  subcommandAt: number
  projectName: string | null
  files: string[]
  projectDirectory: string | null
} {
  const result = { subcommandAt: args.length, projectName: null as string | null, files: [] as string[], projectDirectory: null as string | null }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith('-')) {
      result.subcommandAt = index
      return result
    }
    // `--file=compose.yml` and the short attached `-fcompose.yml` / `-pblog` forms.
    if (arg.startsWith('--') && arg.includes('=')) {
      const [flag, value = ''] = [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      if (flag === '--project-name' || flag === '--file' || flag === '--project-directory') {
        if (flag === '--project-name')
          result.projectName = value
        else if (flag === '--file')
          result.files.push(value)
        else result.projectDirectory = value
      }
      continue
    }
    if (!arg.startsWith('--') && arg.length > 2 && COMPOSE_VALUE_FLAGS.has(arg.slice(0, 2))) {
      const value = arg.slice(2)
      if (arg.startsWith('-p'))
        result.projectName = value
      else if (arg.startsWith('-f'))
        result.files.push(value)
      continue
    }

    if (COMPOSE_VALUELESS_FLAGS.has(arg))
      continue
    if (!COMPOSE_VALUE_FLAGS.has(arg))
      // An option this does not know: it still takes no *subcommand* position, so keep scanning.
      continue

    const value = args[index + 1]
    if (value === undefined)
      return result
    index += 1
    if (arg === '-p' || arg === '--project-name')
      result.projectName = value
    else if (arg === '-f' || arg === '--file')
      result.files.push(value)
    else if (arg === '--project-directory')
      result.projectDirectory = value
  }

  return result
}

/** The compose file compose would pick: the first known name here or in a parent directory. */
export function findComposeFile(from: string): string[] {
  let dir = path.resolve(from)
  for (;;) {
    for (const name of COMPOSE_FILES) {
      const candidate = path.join(dir, name)
      try {
        if (fs.statSync(candidate).isFile())
          return [candidate]
      }
      catch {
        // Not this name.
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir)
      return []
    dir = parent
  }
}

/** Whether this argv runs a compose stack, without resolving anything — a cheap pre-check. */
export function isComposeCommand(command: string, args: string[]): boolean {
  return composeArgv(command, args) !== null
}

/**
 * The compose project an entry runs, from evidence in its own config: the command it spawns, its
 * argv, its cwd and its environment. `null` means "sample the process tree", which is the right
 * answer for every entry this cannot attribute honestly — see the module comment for the limits.
 */
export function composeTarget(input: {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string | undefined>
}): ComposeTarget | null {
  const composeArgs = composeArgv(input.command, input.args)
  if (composeArgs === null)
    return null

  const head = parseComposeHead(composeArgs)
  /*
   * The entry's own environment only — **not** `process.env`.
   *
   * The panel itself often runs under compose, and inheriting its `COMPOSE_PROJECT_NAME` made that
   * one name every entry's project: measured with two entries and the panel's env carrying
   * `COMPOSE_PROJECT_NAME=shared-stack`, both reported `cpuPercent: 199.4, rssBytes: 183500800` —
   * each summing both stacks — and a memory ceiling on one fired on the other's containers. The
   * panel's environment is not the entry's.
   */
  const project = head.projectName
    ?? (input.env?.COMPOSE_PROJECT_NAME !== undefined && input.env.COMPOSE_PROJECT_NAME.length > 0
      ? input.env.COMPOSE_PROJECT_NAME
      : null)

  const directory = head.projectDirectory === null ? input.cwd : path.resolve(input.cwd, head.projectDirectory)
  const configFiles = head.files.length > 0
    ? head.files.map(file => path.resolve(directory, file))
    : findComposeFile(directory)

  if (project === null && configFiles.length === 0)
    // Neither label to attribute by: these containers cannot be told from the rest of the box's.
    return null

  return { key: project === null ? `files:${configFiles.join('\u0000')}` : `project:${project}`, project, configFiles }
}

/**
 * The containers belonging to one target, or `null` when that cannot be decided.
 *
 * `null` is the ambiguity refusal: two projects sharing a compose file can only be told apart by an
 * explicit project name, so picking one would report another stack's CPU and RSS as this entry's.
 */
export function attributeContainers(target: ComposeTarget, rows: ContainerRow[]): ContainerRow[] | null {
  if (target.project !== null)
    return rows.filter(row => row.project === target.project)

  const matched = rows.filter(row => row.configFiles.some(file => target.configFiles.some(own => samePath(file, own))))
  const projects = new Set(matched.map(row => row.project))
  return projects.size <= 1 ? matched : null
}

/**
 * The sum over one project's containers.
 *
 * Exported so the arithmetic is testable against the shapes docker actually prints; the class below
 * only decides when to spawn. `null` for no containers, and for a listed container without a
 * reading — an under-report is the one direction a memory ceiling must not miss.
 */
export function sumContainers(rows: ContainerRow[], readings: Map<string, Omit<ComposeReading, 'containers'>>): ComposeReading | null {
  if (rows.length === 0)
    return null
  let cpuPercent = 0
  let rssBytes = 0
  let processes = 0
  for (const row of rows) {
    const reading = readings.get(row.id)
    if (reading === undefined)
      return null
    cpuPercent += reading.cpuPercent
    rssBytes += reading.rssBytes
    processes += reading.processes
  }
  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    rssBytes: Math.round(rssBytes),
    processes,
    containers: rows.length,
  }
}

/** Whether a container publishing a port belongs to the stack this entry itself declares. */
export function isOwnStack(holder: { project: string | null, composeDir: string | null }, target: ComposeTarget | null): boolean {
  if (target === null)
    return false
  // A non-null project on both sides is the exact answer, and `null === null` must not read as one.
  if (holder.project !== null && target.project !== null)
    return holder.project === target.project
  // Otherwise the working directory compose recorded is the one holding this entry's compose file.
  // Most entries never pass `-p`, so the project name is unknown on both sides and the directory is
  // the evidence that remains — measured: without this, an entry's own already-up stack read as a
  // stranger, and the only escape hatch offered was `kill`.
  if (holder.composeDir === null)
    return false
  return target.configFiles.some(file => samePath(path.dirname(file), holder.composeDir!))
}

/** One target's running containers from a fresh `docker ps`, or `null` when docker cannot answer. */
export async function composeContainers(target: ComposeTarget): Promise<ContainerRow[] | null> {
  try {
    const listing = await execFileAsync('docker', [
      'ps',
      '--filter',
      'label=com.docker.compose.project',
      '--format',
      PS_FORMAT,
    ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    return attributeContainers(target, parseDockerPs(listing.stdout))
  }
  catch {
    // Docker absent, down or not permissioned. "Cannot ask" is not "nothing is running".
    return null
  }
}

/**
 * Stops every container of one target and reports what is still running afterwards.
 *
 * The answer comes from a **fresh listing**, not from `docker stop`'s exit code: a stop that
 * printed success for a container still listed is the empty success this exists to refuse.
 * `null` means docker could not be asked, which is not the same as "it stopped".
 */
export async function stopComposeContainers(target: ComposeTarget): Promise<{ stopped: string[], survivors: string[] } | null> {
  const before = await composeContainers(target)
  if (before === null)
    return null
  if (before.length === 0)
    return { stopped: [], survivors: [] }

  try {
    await execFileAsync('docker', ['stop', ...before.map(row => row.name)], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  }
  catch {
    // A non-zero exit only means one name failed; the relisting below is what decides.
  }

  const after = await composeContainers(target)
  if (after === null)
    return null
  const remaining = new Set(after.map(row => row.name))
  return {
    stopped: before.map(row => row.name).filter(name => !remaining.has(name)),
    survivors: after.map(row => row.name),
  }
}

/**
 * Container readings per compose project, refreshed out of band.
 *
 * One `docker ps` and one batched `docker stats` serve every docker-backed entry, however many
 * there are. When docker cannot be reached the cache is emptied rather than filled with zeros: the
 * caller keeps the process-tree sample, which is at least true of the wrapper, and a metric with no
 * reading is never published as an idle one.
 */
export class DockerMetrics {
  private cache: { at: number, byKey: Map<string, ComposeReading> } | null = null
  private refreshing: Promise<void> | null = null

  /**
   * The last completed readings, and a refresh started when they are stale.
   *
   * Deliberately synchronous: the spawn takes seconds, and awaiting it here would stretch the
   * supervisor tick that publishes the whole state frame. A fresh reading lands on a later tick.
   */
  readings(targets: ComposeTarget[], now = Date.now()): ReadonlyMap<string, ComposeReading> {
    // A stamp in the future (a backwards clock step) counts as stale, so a reading cannot stick.
    const fresh = this.cache !== null && now >= this.cache.at && now - this.cache.at < DOCKER_CACHE_MS
    if (!fresh && targets.length > 0 && this.refreshing === null) {
      this.refreshing = this.refresh(targets, now).finally(() => {
        this.refreshing = null
      })
    }
    return this.cache?.byKey ?? EMPTY
  }

  /** Resolves once the refresh in flight, if any, has finished. */
  async settle(): Promise<void> {
    await this.refreshing
  }

  /** One listing and one batched stats call; replaces the cache only with a complete answer. */
  async refresh(targets: ComposeTarget[], now = Date.now()): Promise<void> {
    const byKey = new Map<string, ComposeReading>()
    try {
      const listing = await execFileAsync('docker', [
        'ps',
        // A compose container is the only kind this can attribute, and the filter also keeps a box
        // full of `docker run` containers out of the listing.
        '--filter',
        'label=com.docker.compose.project',
        '--format',
        PS_FORMAT,
      ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })

      const rows = parseDockerPs(listing.stdout)
      const perTarget = new Map<string, ContainerRow[]>()
      const ids = new Set<string>()
      for (const target of targets) {
        const matched = attributeContainers(target, rows)
        // No running container of this project: there is nothing of the stack to measure, and the
        // wrapper the entry spawned is the truth of what is running. The caller keeps its sample.
        if (matched === null || matched.length === 0)
          continue
        perTarget.set(target.key, matched)
        for (const row of matched) ids.add(row.id)
      }
      if (ids.size === 0) {
        this.cache = { at: now, byKey }
        return
      }

      const stats = await execFileAsync('docker', ['stats', '--no-stream', '--format', 'json', ...ids], {
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      const readings = parseDockerStats(stats.stdout)
      for (const [key, matched] of perTarget) {
        // A partial sum is not a smaller reading, it is a wrong one; only complete sums are kept.
        const summed = sumContainers(matched, readings)
        if (summed !== null)
          byKey.set(key, summed)
      }
    }
    catch {
      // docker absent, not running or not permissioned: no reading, never a zero.
      byKey.clear()
    }
    this.cache = { at: now, byKey }
  }
}
