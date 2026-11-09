import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliPanelFixture } from '../support/cli-panel-fixture'

/**
 * `start`/`stop` against a real listener and a real run.json: the CLI has to read the
 * token out of the file, speak `/_hh`, and turn the panel's answer into one line —
 * including the panel that is too old to know the route at all.
 *
 * `spawn`, never `spawnSync`: the panel is a listener in *this* process, and a
 * synchronous wait would freeze the event loop that has to answer it.
 */

const { home, runCli, panel, writeRuntime } = await cliPanelFixture()

describe('restart, for one server or the panel', () => {
  /**
   * `restart <id>` is the shell's counterpart to the UI's per-server Restart button, which
   * the CLI could not do at all. It must reach the same kind of control route `start`/`stop`
   * use, and leave the panel itself alone.
   */
  it('sends a per-server restart over the local control channel', async () => {
    const created = await panel(200, JSON.stringify({ ok: true }))
    writeRuntime(created.url)

    const result = await runCli(['restart', 'web'])
    expect(result.status).toBe(0)
    // "restarted", not "stopped": the verb is the action.
    expect(result.stdout).toContain('restarted web')
    expect(created.seen.path).toBe('/_hh/servers/web/restart')
    expect(created.seen.token).toBe('local-token')
  })

  it('carries the workspace through', async () => {
    const created = await panel(200, JSON.stringify({ ok: true }))
    writeRuntime(created.url)

    const result = await runCli(['restart', 'web', '--workspace', 'staging'])
    expect(result.status).toBe(0)
    expect(created.seen.path).toBe('/_hh/servers/web/restart?workspace=staging')
    expect(result.stdout).toContain('restarted staging/web')
  })

  it('reports a refused restart as its reason, and exits 1', async () => {
    const created = await panel(409, JSON.stringify({ ok: false, error: 'server "web" is disabled' }))
    writeRuntime(created.url)

    const result = await runCli(['restart', 'web'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('server "web" is disabled')
  })

  /**
   * The id is optional, and that is the delicate half: `restart` meant the panel before this,
   * so a bare call must still take the down-then-up path rather than reaching `/_hh`.
   */
  it('keeps bare `restart` meaning the panel, not a server', async () => {
    // `--print-config` is what makes this safe: bare `restart` runs `down` then `up`, and a
    // real `up` would detach a daemon — which is slow, and on Windows leaves the state
    // directory locked for the cleanup that follows. `--print-config` returns from `up`
    // before it detaches, so the panel path is observable and nothing is started.
    //
    // No run.json either: `down` would otherwise signal the pid in it, and the fixture's pid
    // is this very test process. That is how an earlier draft shot its own worker.
    const result = await runCli(['restart', '--print-config'])

    // The panel path prints the effective config, which a server action never would.
    expect(result.stdout).toContain('servers')
    expect(result.stderr).not.toContain('server id')
  })

  /**
   * `--workspace` without an id is refused rather than ignored.
   *
   * The panel's own restart is not a per-server idea, so the flag is meaningless there — and
   * silently running `down` then `up` would restart *every* server while the caller believed it had
   * scoped the action to one workspace. This branch had no test.
   */
  it('refuses `restart --workspace` when no server id is given', async () => {
    const result = await runCli(['restart', '--workspace', 'default', '--print-config'])

    expect(result.status, 'the flag must be refused, not ignored').toBe(1)
    expect(result.stderr).toContain('restart --workspace needs a server id')
    // It names the corrected form, so the reader does not have to infer it.
    expect(result.stderr).toContain('--workspace <id>')
  })

  it('does not reach the control channel when no id is given', async () => {
    const created = await panel(200, JSON.stringify({ ok: true }))
    writeRuntime(created.url)

    // `restart --workspace x` without an id is refused *before* anything is attempted, so
    // this proves the id-less path never routes to `/_hh` — and it must not run `down`
    // either, because the run.json here names this very process as the panel.
    //
    // This subsumes a sibling case that asserted only exit 1 and `needs a server id`: strictly fewer
    // assertions over the same two calls, so it could not fail where this one passes. The
    // "says what to write instead" half lives in the `--print-config` case above, which is the one
    // that proves the corrected form is named.
    const result = await runCli(['restart', '--workspace', 'staging'])

    expect(result.status).toBe(1)
    expect(created.seen.path, 'the control channel must not be touched').toBeUndefined()
    expect(result.stderr).toContain('needs a server id')
  })

  /**
   * `restart <id>` takes no panel option, and says so instead of dropping it.
   *
   * The command spreads `up`'s whole flag set, because the **bare** form really does forward it —
   * `restart --print-config` is how the panel path is observable, pinned above. The id form is a
   * different command: it asks the panel to restart one entry over `/_hh` and never runs `down` or
   * `up`, so a panel-level flag has nothing to act on. They were parsed and discarded, which is how
   * `restart web --print-config` came to restart a live server while reading as "show me the
   * config". `--with-persistent` already had this guard; these six did not.
   */
  it('refuses a panel-level flag on `restart <id>`, and names it', async () => {
    const cases = [
      ['--port', '5000'],
      ['--host', 'lan'],
      ['--no-autostart'],
      ['--open'],
      ['--foreground'],
      ['--print-config'],
    ] as const

    for (const extra of cases) {
      const created = await panel(200, JSON.stringify({ ok: true }))
      writeRuntime(created.url)

      const result = await runCli(['restart', 'web', ...extra])

      expect(result.status, extra.join(' ')).toBe(1)
      expect(result.stderr, extra.join(' ')).toContain('takes no panel option')
      // It names the flag, so the reader does not have to work out which one was dropped.
      expect(result.stderr, extra.join(' ')).toContain(extra[0])
      // And nothing reached the panel: a refusal must not restart the entry on its way out.
      expect(created.seen.path, extra.join(' ')).toBeUndefined()
    }

    // `--port=5000` is one token, and must be refused the same way.
    const created = await panel(200, JSON.stringify({ ok: true }))
    writeRuntime(created.url)
    const equals = await runCli(['restart', 'web', '--port=5000'])
    expect(equals.status).toBe(1)
    expect(equals.stderr).toContain('takes no panel option')

    // The bare form still forwards it — the flag is not wrong, only wrong *here*.
    //
    // With **no** run.json: the fixture's pid is this very process, and bare `restart` runs `down`,
    // which would signal it. The sibling test above carries the same warning; this is the second
    // time it has been earned.
    fs.rmSync(path.join(home, '.hh', 'run.json'), { force: true })
    const bare = await runCli(['restart', '--print-config'])
    expect(bare.status, 'a bare restart still honours --print-config').toBe(0)
    expect(bare.stdout).toContain('servers')
  })
})
