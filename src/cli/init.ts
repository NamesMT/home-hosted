import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, confirm, dim, fail, green, invocation, prompt, refusal } from '#src/cli/io'
import { cdCommand, detectPackageManager, installArgs, nextSteps, PACKAGE_MANAGERS, scaffold } from '#src/services/init'
import { errorMessage } from '#src/shared/error-message'

/**
 * `init` scaffolds a project that keeps its whole setup — state, data and the
 * server definitions — inside its own directory. Interactive by nature, but
 * `--yes` takes every default so an agent or a CI job can run it unattended.
 */

export const initArgs = {
  dir: { type: 'string', description: 'where to scaffold (default: ./my-servers)' },
  name: { type: 'string', description: 'package name (default: the directory name)' },
  pm: { type: 'string', description: 'pnpm | npm | yarn | bun (default: the first one installed)' },
  install: { type: 'boolean', default: true, negativeDescription: 'write the files, install nothing' },
  yes: { type: 'boolean', alias: 'y', description: 'take every default, ask nothing' },
} as const

function which(command: string): boolean {
  const probe = spawnSync(command, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
  return probe.status === 0
}

export async function runInit(options: { dir?: string, name?: string, pm?: string, noInstall: boolean, yes: boolean }): Promise<void> {
  const assumeYes = options.yes
  if (!assumeYes && process.stdin.isTTY !== true) {
    fail(`init needs a terminal to ask in.\n  take the defaults with: ${invocation()} init --yes [--dir <dir>]`)
  }

  const defaultDir = options.dir ?? './my-servers'
  const dir = assumeYes ? defaultDir : (await prompt(`Project directory (${defaultDir}) `)).trim() || defaultDir
  const defaultName = path.basename(path.resolve(dir))
  const name = options.name ?? (assumeYes ? defaultName : (await prompt(`Package name (${defaultName}) `)).trim() || defaultName)

  let pm = options.pm
  if (pm !== undefined && !(PACKAGE_MANAGERS as string[]).includes(pm))
    fail(`unknown package manager: ${pm} (expected one of ${PACKAGE_MANAGERS.join(', ')})`)
  const detected = detectPackageManager(which)
  if (pm === undefined)
    pm = assumeYes ? detected : (await prompt(`Package manager (${detected}) `)).trim() || detected

  const install = options.noInstall
    ? false
    : assumeYes || (await confirm('Install the dependencies now?', true))
  const git = assumeYes ? which('git') : which('git') && (await confirm('Initialize a git repository?', true))

  try {
    const result = scaffold({ dir, name, pm: pm as never, install, git })
    process.stdout.write(`${green('project created')} in ${result.dir}\n`)
    for (const file of result.files)
      process.stdout.write(`  ${dim(file)}\n`)
  }
  catch (error) {
    fail(errorMessage(error))
  }

  const target = path.resolve(dir)
  if (git) {
    spawnSync('git', ['init', '-q'], { cwd: target, stdio: 'inherit', shell: process.platform === 'win32' })
    process.stdout.write(`  ${dim('git repository initialized')}\n`)
  }

  let installed = install
  if (install) {
    process.stdout.write(`${dim(`installing with ${pm}…`)}\n`)
    const result = spawnSync(pm as string, installArgs(pm as never), {
      cwd: target,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    // A failed install is a failed `init`: the files are there, but the next steps do not work yet.
    // Said on stderr with exit 1, so `init --yes && …` in a script stops; "Next" then lists the install.
    if (result.status !== 0) {
      installed = false
      refusal(`the ${pm} install failed — the project is in ${target}, but its dependencies are not installed`)
      process.exitCode = 1
    }
  }

  // A path inside the working directory reads better relative; anything else absolute.
  const relative = path.relative(process.cwd(), target)
  const where = relative.length === 0 || relative.startsWith('..') ? target : relative
  const cd = relative.length === 0 ? '' : cdCommand(where)
  process.stdout.write(`\nNext:\n`)
  for (const step of nextSteps(pm as never, installed, cd)) {
    if (step.command === null) {
      process.stdout.write(`  ${dim(step.text)}\n`)
      continue
    }
    // The command is the bold half; the line's own explanation keeps its place beside it.
    const padding = ' '.repeat(5)
    process.stdout.write(`  ${bold(step.command)}${padding}${step.text}\n`)
  }
}

export const initCommand = defineCommand({
  meta: { name: 'init' },
  args: initArgs,
  run: async ({ args }) => {
    await runInit({
      dir: args.dir,
      name: args.name,
      pm: args.pm,
      noInstall: args.install === false,
      yes: args.yes === true,
    })
  },
})
