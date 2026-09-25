import { spawn } from 'node:child_process'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { identifyHolders, matchesSpawn, splitCommandLine, windowsProcessInfo } from '#src/providers/identity'
import { resolveCommand, resolveCwd } from '#src/providers/process'

/**
 * Temporary diagnostic for the Windows platform run: the supervisor's `follow`/`reclaim`
 * adoption still fails there even though the provider-level identification passes. This
 * reproduces the supervisor test's own successor and prints what the probe sees, so the
 * mismatch can be read instead of guessed. Remove once understood.
 */
describe('windows identity diagnostic', () => {
  it.runIf(process.platform === 'win32')('reports what it sees for the test successor', async () => {
    const port = 45000 + (process.pid % 500)
    // The supervisor test's own entry, argument for argument.
    const args = ['-e', 'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")']
    const env: Record<string, string> = { ...process.env, PORT: String(port) }
    delete env.HHOSTED_SERVER_ID

    const child = spawn(process.execPath, args, { env, stdio: 'ignore' })
    await new Promise(resolve => setTimeout(resolve, 600))

    try {
      const pid = child.pid
      const cwd = resolveCwd('.')
      const spawnInfo = { command: resolveCommand(process.execPath, cwd, cwd), args, cwd }
      const info = pid === undefined ? null : await windowsProcessInfo(pid)

      console.warn(JSON.stringify({
        pid,
        probe: {
          commandLine: info?.commandLine ?? null,
          words: info ? splitCommandLine(info.commandLine) : null,
          matchesResolved: info ? matchesSpawn({ words: splitCommandLine(info.commandLine), imagePath: info.imagePath }, spawnInfo) : null,
        },
        resolved: { command: spawnInfo.command, args: spawnInfo.args },
        identified: pid === undefined ? null : (await identifyHolders('web', spawnInfo, [pid])).length,
      }, null, 2))

      expect(pid).toBeDefined()
    }
    finally {
      try {
        child.kill('SIGKILL')
      }
      catch {
        // already gone
      }
    }
  })
})
