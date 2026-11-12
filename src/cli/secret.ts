import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, green, invocation, promptHidden } from '#src/cli/io'

/**
 * `secret set|unset|ls <id> [NAME]` — a server's secret environment, without ever printing a value.
 *
 * Through the running panel's `/_hh` channel when it is up (so the panel's own store writes it), else
 * the workspace's `.secrets.json` directly. Either path goes through `SecretsStore`, which is what
 * enforces the 0600 file and the name rule.
 *
 * **Nothing here prints a value**, on any path, including an error: a value that reaches a terminal
 * reaches a shell history, a scrollback buffer and whatever captures the session.
 */

export const secretSetArgs = {
  id: { type: 'positional', required: true, description: 'the server id' },
  name: { type: 'positional', required: true, description: 'the variable name (A-Z, 0-9 and _)' },
  stdin: { type: 'boolean', description: 'read the value from stdin instead of prompting' },
  workspace: { type: 'string', alias: 'w', description: 'the workspace that owns it (default: the default workspace)' },
} as const

export const secretUnsetArgs = {
  id: { type: 'positional', required: true, description: 'the server id' },
  name: { type: 'positional', required: true, description: 'the variable name' },
  workspace: { type: 'string', alias: 'w', description: 'the workspace that owns it' },
} as const

export const secretLsArgs = {
  id: { type: 'positional', required: true, description: 'the server id' },
  workspace: { type: 'string', alias: 'w', description: 'the workspace that owns it' },
  json: { type: 'boolean', description: 'print one document on stdout' },
} as const

interface SecretContext {
  /** The workspace the entry lives in, as named on the command line (empty means default). */
  workspace: string
  store: import('#src/config/store').WorkspaceStore
  secrets: import('#src/config/secrets').SecretsStore
  /** The entry, once found. */
  secretEnv: string[]
}

/**
 * Everything a command needs, through the panel or from disk.
 *
 * The online path asks `/_hh` for the entry list rather than reading the config, so the panel's own
 * store is the authority while it runs. A 404 from a panel that predates the route is reported as
 * "restart it", not as "no such server" — the two need different actions.
 */
async function readContext(id: string, workspaceFlag: string | undefined, online: boolean, runtime: import('#src/helpers/daemon').Runtime): Promise<SecretContext> {
  const { readDefaultWorkspaceId } = await import('#src/config/workspaces')
  const { workspacesPath } = await import('#src/helpers/paths')
  const fs = await import('node:fs')
  const workspace = workspaceFlag === undefined || workspaceFlag.length === 0 ? readDefaultWorkspaceId(workspacesPath) : workspaceFlag

  if (online) {
    const { requestControl } = await import('#src/helpers/daemon')
    const where = workspace === 'default' ? '' : `?workspace=${encodeURIComponent(workspace)}`
    const answer = await requestControl(runtime, `/_hh/servers${where}`, 15_000, 'GET')
    if (answer === null)
      fail(`the control panel is not answering on ${runtime.probeUrl}`)
    if (answer.status === 404) {
      const code = (answer.body as { code?: string } | null)?.code
      fail(code === 'UNKNOWN_WORKSPACE'
        ? `unknown workspace "${workspace}"`
        : `the panel on ${runtime.url} is home-hosted ${runtime.version}, which cannot read secrets from the CLI — restart it on this release`)
    }
    if (answer.status !== 200)
      fail((answer.body as { message?: string } | null)?.message ?? `the panel answered ${answer.status}`)
    const servers = (answer.body as { servers?: Array<{ id: string, config?: { secretEnv?: string[] } }> } | null)?.servers ?? []
    const found = servers.find(server => server.id === id)
    if (found === undefined)
      fail(`unknown server "${id}" in workspace "${workspace}"`)
    return { workspace, store: null as never, secrets: null as never, secretEnv: found.config?.secretEnv ?? [] }
  }

  const [{ WorkspaceStore }, { SecretsStore }, { workspaceSecretsPath, workspaceServersPath, workspaceSettingsPath }] = await Promise.all([
    import('#src/config/store'),
    import('#src/config/secrets'),
    import('#src/helpers/paths'),
  ])
  // The registry is the authority on which workspaces exist. Without this check an unknown id fell
  // through to the store — which would have **seeded** that workspace's files — and then reported
  // "unknown server", naming the wrong mistake and creating state to describe it.
  const { WorkspaceRegistry } = await import('#src/config/workspaces')
  if (fs.existsSync(workspacesPath)) {
    const registry = new WorkspaceRegistry(workspacesPath)
    registry.load({ write: false })
    if (registry.configError !== null)
      fail(`cannot read ${workspacesPath}: ${registry.configError}`)
    if (!registry.all().some(known => known.id === workspace)) {
      const known = registry.all().map(entry => entry.id).join(', ')
      fail(`unknown workspace "${workspace}"${known.length === 0 ? '' : ` (known: ${known})`}`)
    }
  }
  else if (workspace !== 'default') {
    fail(`unknown workspace "${workspace}" — this home has only the default workspace`)
  }

  const store = new WorkspaceStore(workspace, workspaceSettingsPath(workspace), workspaceServersPath(workspace))
  // Read-only: a command that promises to look must not seed `.hh` or its configs.
  store.load({ write: false })
  if (store.configError !== null)
    fail(`cannot read the config for workspace "${workspace}": ${store.configError}`)
  const entry = store.getServer(id)
  if (entry === undefined)
    fail(`unknown server "${id}" in workspace "${workspace}"`)
  const secrets = new SecretsStore(workspaceSecretsPath(workspace), undefined, 'workspace')
  return { workspace, store, secrets, secretEnv: entry.secretEnv }
}

/** Writes through the panel when it runs, else straight to the workspace's secrets file. */
async function apply(id: string, workspace: string, body: { set?: Record<string, string>, unset?: string[] }, runtime: import('#src/helpers/daemon').Runtime | null): Promise<void> {
  if (runtime !== null) {
    const { requestControl } = await import('#src/helpers/daemon')
    const where = workspace === 'default' ? '' : `?workspace=${encodeURIComponent(workspace)}`
    const answer = await requestControl(runtime, `/_hh/servers/secrets/${encodeURIComponent(id)}${where}`, 15_000, 'POST', body)
    if (answer === null)
      fail(`the control panel is not answering on ${runtime.probeUrl}`)
    if (answer.status === 404)
      fail(`the panel on ${runtime.url} is home-hosted ${runtime.version}, which cannot write secrets from the CLI — restart it on this release`)
    if (answer.status !== 200)
      fail((answer.body as { message?: string } | null)?.message ?? `the panel answered ${answer.status}`)
    return
  }

  const [{ SecretsStore }, { workspaceSecretsPath }] = await Promise.all([
    import('#src/config/secrets'),
    import('#src/helpers/paths'),
  ])
  const secrets = new SecretsStore(workspaceSecretsPath(workspace), undefined, 'workspace')
  if ((body.unset ?? []).length > 0)
    secrets.unsetServerEnv(id, body.unset ?? [])
  if (body.set !== undefined && Object.keys(body.set).length > 0) {
    const next = { ...secrets.serverEnv(id), ...body.set }
    secrets.setServerEnv(id, next)
  }
}

/**
 * The value, without echo and without a shell history entry.
 *
 * `--stdin` reads one line, which is how a script passes a secret without a prompt. An interactive
 * run prompts with echo off. Empty is refused: an empty environment variable is indistinguishable
 * from one that was never set, so it is almost always a mistake rather than an intent.
 */
async function readValue(id: string, name: string, fromStdin: boolean): Promise<string> {
  let value: string
  if (fromStdin) {
    const { readFileSync } = await import('node:fs')
    try {
      value = readFileSync(0, 'utf8')
    }
    catch {
      fail('could not read the value from stdin')
    }
  }
  else if (process.stdin.isTTY === true) {
    value = await promptHidden(`${id}/${name}: `)
  }
  else {
    fail(`no value: pass \`--stdin\` and pipe one line in, or run this at a terminal to be prompted`)
  }
  // `readFileSync(0)` keeps the trailing newline a `printf` or an `echo` adds.
  const trimmed = value.replace(/\r?\n$/, '')
  if (trimmed.length === 0)
    fail(`a secret cannot be empty — an empty variable reads as unset, so \`${invocation()} secret unset ${id} ${name}\` is what you want instead`)
  return trimmed
}

export const secretCommand = defineCommand({
  // No `description`: citty's usage printer never runs (the curated surface in `cli.ts` owns the one
  // reachable summary), and `test/cli/cli-smoke.test.ts` fails on a second copy that would drift.
  meta: { name: 'secret' },
  args: {
    command: { type: 'positional', required: false, description: 'set, unset or ls' },
    id: { type: 'positional', required: false, description: 'the server id' },
    name: { type: 'positional', required: false, description: 'the variable name' },
    stdin: { type: 'boolean', description: 'read the value from stdin instead of prompting' },
    workspace: { type: 'string', alias: 'w', description: 'the workspace that owns it' },
    json: { type: 'boolean', description: 'print one document on stdout' },
  },
  async run({ args }) {
    const command = String(args.command ?? '')
    const id = String(args.id ?? '')
    const name = String(args.name ?? '')
    // citty types a positional as `string | number | boolean | string[]`; only a string is a workspace.
    const workspace = typeof args.workspace === 'string' ? args.workspace : undefined
    if (command !== 'set' && command !== 'unset' && command !== 'ls')
      fail(`use \`${invocation()} secret set|unset|ls <id> [NAME]\``)
    if (id.length === 0)
      fail(`which server? \`${invocation()} secret ${command} <id>${command === 'ls' ? '' : ' NAME'}\``)

    const { readRuntime, runtimeIsAlive } = await import('#src/helpers/daemon')
    const recorded = readRuntime()
    const runtime = recorded !== null && await runtimeIsAlive(recorded) ? recorded : null
    const context = await readContext(id, workspace, runtime !== null, runtime as import('#src/helpers/daemon').Runtime)

    if (command === 'ls') {
      const stored = runtime === null
        ? context.secrets.serverEnvNames(id)
        : await (async () => {
            // Through the panel: its view knows which declared names have a value.
            const { requestControl } = await import('#src/helpers/daemon')
            const where = context.workspace === 'default' ? '' : `?workspace=${encodeURIComponent(context.workspace)}`
            const answer = await requestControl(runtime, `/_hh/servers${where}`, 15_000, 'GET')
            const servers = (answer?.body as { servers?: Array<{ id: string, secretEnvSet?: string[] }> } | null)?.servers ?? []
            return servers.find(server => server.id === id)?.secretEnvSet ?? []
          })()
      if (args.json === true) {
        process.stdout.write(`${JSON.stringify({ server: id, workspace: context.workspace, declared: context.secretEnv, set: stored })}\n`)
        return
      }
      if (context.secretEnv.length === 0) {
        process.stdout.write(`no secret environment is declared for ${bold(id)} — add names to \`secretEnv\` first\n`)
        return
      }
      for (const declared of context.secretEnv) {
        const isSet = stored.includes(declared)
        process.stdout.write(`${isSet ? green('set ') : dim('    ')} ${declared}\n`)
      }
      return
    }

    if (name.length === 0)
      fail(`which variable? \`${invocation()} secret ${command} ${id} NAME\``)
    // Refuse a name the entry does not declare *before* asking for a value: the value is the thing
    // that must not be typed for nothing.
    if (!context.secretEnv.includes(name))
      fail(`"${name}" is not declared in ${id}'s secretEnv — add it to the entry's \`secretEnv\` first (declared: ${context.secretEnv.length === 0 ? 'none' : context.secretEnv.join(', ')})`)

    if (command === 'set') {
      const value = await readValue(id, name, args.stdin === true)
      await apply(id, context.workspace, { set: { [name]: value } }, runtime)
      process.stdout.write(`${green('set')} ${bold(name)} on ${id}${runtime === null ? dim(' (the panel is not running; it reads this on its next start)') : ''}\n`)
      return
    }

    await apply(id, context.workspace, { unset: [name] }, runtime)
    process.stdout.write(`${green('unset')} ${bold(name)} on ${id}\n`)
  },
})
