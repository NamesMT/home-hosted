import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, invocation } from '#src/cli/io'

/**
 * `home-hosted deploy <id>` — run an entry's deploy steps and report the outcome.
 *
 * **Waits**, and exits 1 on failure: a deploy is an action a script or a person is watching, and a
 * command that answered "accepted" would leave the caller believing it worked. The steps' own output
 * goes to the entry's log (`home-hosted logs <id>`), so this prints the outcome rather than streaming
 * it back.
 *
 * Through the panel when it runs (so its supervisor owns the sequence and its history record), else
 * the same `runDeploy` the panel calls — a deploy is a fact about the config, not about the panel
 * being up.
 */

export const deployArgs = {
  id: { type: 'positional', required: true, description: 'the server id' },
  workspace: { type: 'string', alias: 'w', description: 'the workspace that owns it' },
  json: { type: 'boolean', description: 'print one document on stdout' },
} as const

export const deployCommand = defineCommand({
  meta: { name: 'deploy' },
  args: deployArgs,
  async run({ args }) {
    const id = String(args.id ?? '')
    if (id.length === 0)
      fail(`which server? \`${invocation()} deploy <id>\``)
    const workspace = typeof args.workspace === 'string' ? args.workspace : undefined

    const { readRuntime, requestControl, runtimeIsAlive } = await import('#src/helpers/daemon')
    const recorded = readRuntime()
    const live = recorded !== null && await runtimeIsAlive(recorded)
    const where = workspace === undefined || workspace.length === 0 ? '' : `?workspace=${encodeURIComponent(workspace)}`

    if (live) {
      const answer = await requestControl(recorded, `/_hh/servers/${encodeURIComponent(id)}/deploy${where}`, 600_000, 'POST')
      if (answer === null)
        fail(`the control panel is not answering on ${recorded.probeUrl}`)
      if (answer.status !== 200) {
        const body = answer.body as { message?: string, code?: string } | null
        if (body?.code === 'DEPLOY_RUNNING' || body?.code === 'NO_DEPLOY' || body?.code === 'UNKNOWN_SERVER')
          fail(body.message ?? `the panel answered ${answer.status}`)
        fail(body?.message ?? `the panel answered ${answer.status}`)
      }
      if (args.json === true) {
        process.stdout.write(`${JSON.stringify({ server: id, ok: true })}\n`)
        return
      }
      process.stdout.write(`${green('deployed')} ${id}\n`)
      return
    }

    // Offline: the same service the panel would call, over the workspace's own config.
    const [{ WorkspaceStore }, { readDefaultWorkspaceId }, { workspaceServersPath, workspaceSettingsPath, workspacesPath }] = await Promise.all([
      import('#src/config/store'),
      import('#src/config/workspaces'),
      import('#src/helpers/paths'),
    ])
    const workspaceId = workspace === undefined || workspace.length === 0 ? readDefaultWorkspaceId(workspacesPath) : workspace
    const store = new WorkspaceStore(workspaceId, workspaceSettingsPath(workspaceId), workspaceServersPath(workspaceId))
    store.load({ write: false })
    if (store.configError !== null)
      fail(`cannot read the config for workspace "${workspaceId}": ${store.configError}`)
    const entry = store.getServer(id)
    if (entry === undefined)
      fail(`unknown server "${id}" in workspace "${workspaceId}"`)
    if (entry.deploy === undefined || entry.deploy === null)
      fail(`server "${id}" has no deploy steps — add a \`deploy\` block to its entry`)

    const { runDeploy } = await import('#src/services/deploy')
    const { resolveRecord } = await import('#src/helpers/template')
    const { serverTemplateVars } = await import('#src/providers/server-vars')
    /**
     * The environment the steps run with, offline: the tracked `env` and `dataEnvs`.
     *
     * `envFile` and declared `secretEnv` values are **not** reachable here — the file may be anywhere
     * and the secrets live in the workspace store this command does not read — so they are missing
     * and said so, rather than silently absent. With the panel up the same deploy goes through the
     * panel's supervisor, which resolves the entry's real environment.
     */
    const vars = serverTemplateVars(entry)
    const withFile = entry.envFile.trim().length > 0
    const withSecrets = (entry.secretEnv ?? []).length > 0
    if (withFile || withSecrets) {
      process.stdout.write(`${dim(`note: running without ${withFile ? 'envFile' : ''}${withFile && withSecrets ? ' and ' : ''}${withSecrets ? 'declared secretEnv values' : ''} — start the panel and re-run to get them`)}${'\n'}`)
    }
    const outcome = await runDeploy(entry, { cancelled: () => false }, {
      log: (stream, text) => process.stdout.write(`${dim(`[${stream}]`)} ${text}\n`),
      env: () => resolveRecord({ ...entry.env, ...entry.dataEnvs }, vars),
    })
    if (args.json === true) {
      process.stdout.write(`${JSON.stringify({ server: id, ...outcome })}\n`)
      if (!outcome.ok)
        process.exitCode = 1
      return
    }
    if (!outcome.ok) {
      fail(`deploy failed at step ${outcome.failedStep ?? '?'}: ${outcome.error ?? 'unknown'} — the old process is still what runs`)
    }
    process.stdout.write(`${green('deployed')} ${id} in ${Math.round(outcome.durationMs / 1000)}s\n`)
    process.stdout.write(`${dim(`the panel is not running, so nothing was restarted — \`${invocation()} restart ${id}\` when it is`)}\n`)
  },
})
