import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { identifyHolders, matchesSpawn, splitCommandLine, windowsProcessInfo } from '#src/providers/identity'
import { resolveCommand } from '#src/providers/process'

/**
 * Temporary diagnostic for the Windows platform run: prints what the CIM probe actually
 * returns for a spawned child, and which comparison step refuses it. Remove once the
 * Windows supervisor failures are understood.
 */
describe('windows identity diagnostic', () => {
  it.runIf(process.platform === 'win32')('reports what it sees for a spawned successor', async () => {
    const { spawn } = await import('node:child_process')
    const args = ['-e', 'setInterval(()=>{},1000)']
    const env: Record<string, string> = { ...process.env }
    delete env.HHOSTED_SERVER_ID
    const child = spawn(process.execPath, args, { env, stdio: 'ignore' })
    await new Promise(resolve => setTimeout(resolve, 400))

    try {
      const info = child.pid === undefined ? null : await windowsProcessInfo(child.pid)
      const spawnInfo = {
        command: resolveCommand(process.execPath, process.cwd(), process.cwd()),
        args,
        cwd: process.cwd(),
      }

      console.warn(JSON.stringify({
        pid: child.pid,
        execPath: process.execPath,
        resolvedCommand: spawnInfo.command,
        expectedArgs: args,
        cimInfo: info,
        cimWords: info ? splitCommandLine(info.commandLine) : null,
        basenameMatch: info ? path.basename(info.imagePath ?? '') === path.basename(spawnInfo.command) : null,
        matches: info ? matchesSpawn({ words: splitCommandLine(info.commandLine), imagePath: info.imagePath }, spawnInfo) : null,
        identified: child.pid === undefined ? null : (await identifyHolders('web', spawnInfo, [child.pid])).length,
      }, null, 2))

      expect(info).not.toBeNull()
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
