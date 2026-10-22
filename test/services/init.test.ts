import type { InitOptions } from '#src/services/init'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { appVersion } from '#src/helpers/version'
import {
  cdCommand,
  detectPackageManager,
  installArgs,
  isEmptyDir,
  projectGitignore,
  projectManifest,
  projectScripts,
  runCommand,
  scaffold,
} from '#src/services/init'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function tempDir(name = 'hh-init-'): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), name))
  dirs.push(dir)
  return dir
}

function options(overrides: Partial<InitOptions> = {}): InitOptions {
  return { dir: '', name: 'my-servers', pm: 'pnpm', install: false, git: false, ...overrides }
}

describe('scaffold contents', () => {
  it('writes a manifest whose scripts all keep state in the project', () => {
    const manifest = JSON.parse(projectManifest('my-servers')) as {
      name: string
      private: boolean
      engines: { node: string }
      scripts: Record<string, string>
      dependencies: Record<string, string>
    }

    expect(manifest.name).toBe('my-servers')
    expect(manifest.private).toBe(true)
    expect(manifest.engines.node).toBe('>=24.0.0')
    // `^` the version that wrote the project, so newer releases still fit.
    expect(manifest.dependencies['home-hosted']).toBe(`^${appVersion()}`)
    expect(Object.keys(manifest.scripts)).toEqual(Object.keys(projectScripts()))
    for (const command of Object.values(manifest.scripts))
      expect(command).toContain('--home ./state')
  })

  it('ignores state and data, but never the workspace definitions', () => {
    const ignore = projectGitignore()

    expect(ignore).toContain('state/.hh/*')
    // The registry and the global settings stay tracked, so a clone knows its workspaces.
    expect(ignore).toContain('!state/.hh/settings.json')
    expect(ignore).toContain('!state/.hh/workspaces.json')
    // Each workspace's settings and servers stay tracked too; its secrets and logs do not.
    expect(ignore).toContain('!state/.hh/*/settings.json')
    expect(ignore).toContain('!state/.hh/*/servers.config.json')
    expect(ignore).toContain('data/')
  })

  /**
   * The patterns above are only *text* until git is asked. `state/.hh/*` excludes the
   * workspace directory itself, and git does not descend into an excluded directory, so
   * the file-level negations matched nothing and a scaffolded project kept its own
   * `servers.config.json` out of the repo. Asserting the strings were present is what
   * let that ship; this asks `git check-ignore` instead.
   */
  it('actually leaves the workspace definitions trackable, and the secrets ignored', async () => {
    const dir = await tempDir()
    scaffold({ ...options(), dir, install: false, git: false })
    fs.writeFileSync(path.join(dir, '.gitignore'), projectGitignore())
    fs.mkdirSync(path.join(dir, 'state', '.hh', 'default', '.logs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'state', '.hh', 'workspaces.json'), '{}')
    fs.writeFileSync(path.join(dir, 'state', '.hh', 'default', 'settings.json'), '{}')
    fs.writeFileSync(path.join(dir, 'state', '.hh', 'default', 'servers.config.json'), '{}')
    fs.writeFileSync(path.join(dir, 'state', '.hh', 'default', '.secrets.json'), '{}')
    fs.writeFileSync(path.join(dir, 'state', '.hh', 'default', '.logs', 'web.jsonl'), '')

    // `git init` is what makes check-ignore meaningful; it touches only this temp dir.
    execFileSync('git', ['init', '-q'], { cwd: dir })

    const ignored = (file: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', file], { cwd: dir })
        return true
      }
      catch {
        return false
      }
    }

    // The definitions a clone needs.
    expect(ignored('state/.hh/workspaces.json')).toBe(false)
    expect(ignored('state/.hh/default/settings.json')).toBe(false)
    expect(ignored('state/.hh/default/servers.config.json')).toBe(false)
    // The things that must never be committed.
    expect(ignored('state/.hh/default/.secrets.json')).toBe(true)
    expect(ignored('state/.hh/default/.logs/web.jsonl')).toBe(true)
  })

  it('detects the first package manager on PATH, preferring pnpm', () => {
    expect(detectPackageManager(() => true)).toBe('pnpm')
    expect(detectPackageManager(command => command === 'npm')).toBe('npm')
    expect(detectPackageManager(() => false)).toBe('npm')
  })

  it('spells the commands each manager actually takes', () => {
    expect(runCommand('pnpm', 'up')).toBe('pnpm run up')
    expect(runCommand('npm', 'up')).toBe('npm run up')
    expect(installArgs('pnpm')).toEqual(['install'])
    expect(installArgs('npm')).toEqual(['install'])
    // `yarn` installs with no argument at all.
    expect(installArgs('yarn')).toEqual([])
  })
})

/**
 * `init` ends by printing the exact command that starts the project, and the directory is the
 * person's to choose. A space in it is ordinary on every platform — `C:\Users\Ann Lee`,
 * `/srv/my apps` — and unquoted, `cd my servers && npm run up` is answered `cd: too many
 * arguments`: a failure in the one line the scaffold exists to hand over.
 *
 * Run through a real shell rather than compared against a string, because the quoting rule is a
 * claim about `sh` and a literal expectation would happily encode a form the shell rejects — the
 * escaped-quote case exists precisely because wrapping in `''` alone is not enough.
 */
describe('cdCommand', () => {
  const savedPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true })
  })

  /** The real interpreter the printed line will be pasted into. */
  function posixShellAccepts(command: string): boolean {
    try {
      execFileSync('sh', ['-c', command], { stdio: 'ignore' })
      return true
    }
    catch {
      return false
    }
  }

  it('quotes a directory with a space so a real shell runs it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh cd-'))
    dirs.push(dir)
    const command = `${cdCommand(dir)}pwd`
    expect(posixShellAccepts(command), `sh refused: ${command}`).toBe(true)

    // The unquoted shape is the defect, and it must still be refused — otherwise the assertion
    // above would pass on a shell that simply tolerates anything.
    expect(posixShellAccepts(`cd ${dir} && pwd`)).toBe(false)
  })

  it('escapes a quote in the directory name instead of ending the string early', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh cd-'))
    dirs.push(dir)
    const quoted = path.join(dir, 'it\'s here')
    fs.mkdirSync(quoted)
    expect(posixShellAccepts(`${cdCommand(quoted)}pwd`), `sh refused: ${cdCommand(quoted)}`).toBe(true)
  })

  it('uses the double quotes cmd.exe understands on Windows, which has no single-quote quoting', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(cdCommand('C:\\Users\\Ann Lee\\my servers')).toBe('cd "C:\\Users\\Ann Lee\\my servers" && ')
  })
})

describe('scaffold', () => {
  it('creates the project in an empty directory', async () => {
    const parent = await tempDir()
    const dir = path.join(parent, 'my-servers')

    const result = scaffold(options({ dir }))

    expect(result.created).toBe(true)
    expect(result.files).toEqual(['package.json', '.gitignore'])
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))).toMatchObject({ name: 'my-servers' })
  })

  it('scaffolds into a directory that only holds a .git', async () => {
    const dir = await tempDir()
    fs.mkdirSync(path.join(dir, '.git'))
    expect(isEmptyDir(dir)).toBe(true)

    expect(scaffold(options({ dir })).files).toHaveLength(2)
  })

  it('refuses to write into a directory that already has files', async () => {
    const dir = await tempDir()
    await fs.promises.writeFile(path.join(dir, 'important.txt'), 'mine')

    expect(() => scaffold(options({ dir }))).toThrow(/not empty/)
    // Nothing was touched.
    expect(fs.readdirSync(dir)).toEqual(['important.txt'])
  })

  it('refuses a path that is a file', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'a-file')
    await fs.promises.writeFile(file, '')

    expect(() => scaffold(options({ dir: file }))).toThrow(/not a directory/)
  })
})
