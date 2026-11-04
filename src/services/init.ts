import type { Stats } from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'
import { shellQuote } from '#src/helpers/shell'
import { appVersion } from '#src/helpers/version'

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

export interface InitOptions {
  dir: string
  name: string
  pm: PackageManager
  install: boolean
  git: boolean
}

export interface InitResult {
  dir: string
  created: boolean
  files: string[]
  installed: boolean
  git: boolean
}

/** The scripts every scaffolded project gets; all of them keep state inside the project. */
export function projectScripts(): Record<string, string> {
  const withState = (args: string): string => `home-hosted ${args} --home ./state`
  return {
    'up': withState('up'),
    'down': withState('down'),
    'restart': withState('restart'),
    'status': withState('status'),
    'set-password': withState('set-password'),
    'set-token': withState('set-token'),
    'migrate': withState('migrate'),
  }
}

/** `home-hosted` is pinned to the version that wrote the project, and open to newer ones. */
export function projectManifest(name: string): string {
  return `${JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    description: 'Servers supervised by home-hosted.',
    type: 'module',
    engines: { node: '>=24.0.0' },
    scripts: projectScripts(),
    dependencies: { 'home-hosted': `^${appVersion()}` },
  }, null, 2)}\n`
}

/**
 * State is generated, so it stays out. The workspace definitions worth committing
 * (`.hh/settings.json`, `.hh/workspaces.json`, and each workspace's
 * `settings.json` + `servers.config.json`) are un-ignored explicitly.
 */
export function projectGitignore(): string {
  // `state/.hh/*` excludes the workspace *directories*, and git will not descend into
  // an excluded directory — so the file-level negations below can never match unless
  // the directories themselves are un-ignored first. Without `!state/.hh/*/` the
  // workspace definitions stayed out of the very repo this scaffold creates.
  return `node_modules/

# home-hosted: state is local, the workspace definitions are tracked
state/.hh/*
!state/.hh/settings.json
!state/.hh/workspaces.json
state/.hh/*/*
!state/.hh/*/
!state/.hh/*/settings.json
!state/.hh/*/servers.config.json
data/
`
}

export function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).every(entry => entry === '.git')
  }
  catch {
    return true
  }
}

function assertUsableDir(dir: string): void {
  let stats: Stats | null = null
  try {
    stats = fs.statSync(dir)
  }
  catch {
    return
  }
  if (!stats.isDirectory())
    throw new Error(`${dir} exists and is not a directory`)
  if (!isEmptyDir(dir))
    throw new Error(`${dir} is not empty — pick another directory, or empty it first`)
}

/** Writes the project skeleton. Nothing is installed or initialized here. */
export function scaffold(options: InitOptions): InitResult {
  const dir = path.resolve(options.dir)
  assertUsableDir(dir)

  const existed = fs.existsSync(dir)
  fs.mkdirSync(dir, { recursive: true })

  const files: Array<[string, string]> = [
    ['package.json', projectManifest(options.name)],
    ['.gitignore', projectGitignore()],
  ]
  for (const [name, contents] of files)
    fs.writeFileSync(path.join(dir, name), contents)

  return {
    dir,
    created: !existed,
    files: files.map(([name]) => name),
    installed: false,
    git: false,
  }
}

export const PACKAGE_MANAGERS: PackageManager[] = ['pnpm', 'npm', 'yarn', 'bun']

/** The package manager this machine actually has, preferring pnpm. */
export function detectPackageManager(exists: (command: string) => boolean): PackageManager {
  const found = PACKAGE_MANAGERS.find(pm => exists(pm))
  return found ?? 'npm'
}

/** How to run one of the project's scripts with a given package manager. */
export function runCommand(pm: PackageManager, script: string): string {
  return pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`
}

/**
 * One line of `init`'s "Next:" block. A step is either a command to type or a prose line beneath
 * the one above it, and the two are kept apart so the block can be asserted without a terminal.
 */
export interface NextStep {
  /** The command, already `cd`-prefixed; `null` when the line is prose about the step above. */
  command: string | null
  /** What the command does, or the prose itself. */
  text: string
}

/**
 * What `init` hands the person once the project is written.
 *
 * Built here rather than printed inline for two reasons, both measured. The install step was
 * missing under `--no-install`, so the scripts it went on to name answered `home-hosted: command
 * not found` (npm exits 127) — the one sequence the scaffold exists to hand over, broken at step
 * one. And the password hint named a page the UI does not have: the sidebar entry is **Global
 * settings**, and "Settings → Authentication" names nothing a person can click.
 */
export function nextSteps(pm: PackageManager, install: boolean, cd: string): NextStep[] {
  // The block is a sequence a person walks down, so `cd` belongs on the first command only: the
  // reader arrives in the project once and every later line runs from there.
  const steps: NextStep[] = []
  const lead = (command: string): string => (steps.length === 0 ? `${cd}${command}` : command)

  // The dependency has to exist before any of the project's scripts resolve: `pnpm run up` shells
  // out to `node_modules/.bin/home-hosted`, which `--no-install` deliberately leaves absent.
  if (!install)
    steps.push({ command: lead(installCommand(pm)), text: 'install the dependency' })
  steps.push({ command: lead(runCommand(pm, 'up')), text: 'start the panel (default password `hh`)' })
  steps.push({ command: null, text: 'then change that password under Global settings → Authentication, and add your servers' })
  steps.push({ command: `${runCommand(pm, 'set-token')} --generate`, text: 'for scripts and agents' })
  return steps
}

/**
 * The `cd` that reaches a scaffolded project, quoted for the shell it will be pasted into.
 *
 * The quoting rule is `shellQuote` (`helpers/shell.ts`), shared with every other string this
 * package prints for a person to copy: `init` printed `cd my servers && npm run up` for a directory
 * with a space, which the shell answers `cd: too many arguments` — an error naming a command the
 * person did not compose, on the one line the scaffold exists to hand them over.
 */
export function cdCommand(where: string): string {
  return `cd ${shellQuote(where)} && `
}

/** Install arguments for a scaffolded project (the manifest already lists the dependency). */
export function installArgs(pm: PackageManager): string[] {
  return pm === 'yarn' ? [] : ['install']
}

/**
 * The install command as a person types it — `pnpm install`, `yarn` with no argument.
 *
 * Distinct from `runCommand`, which runs one of the project's **scripts**: `npm run install` is not
 * an install, it is a script named `install` that this manifest does not declare.
 */
export function installCommand(pm: PackageManager): string {
  return [pm, ...installArgs(pm)].join(' ')
}
