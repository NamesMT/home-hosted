import type { Stats } from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'
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

/** Install arguments for a scaffolded project (the manifest already lists the dependency). */
export function installArgs(pm: PackageManager): string[] {
  return pm === 'yarn' ? [] : ['install']
}
