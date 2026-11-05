import type { TemplateVars } from '#src/helpers/template'
import type { ServerConfig } from '#src/shared/contracts'
import os from 'node:os'
import { bindHost, displayHost, lanAddress } from '#src/helpers/bind'
import { dataRoot, projectDir } from '#src/helpers/paths'
import { resolveCwd } from '#src/providers/process'

/** The `{placeholder}` values an entry's args, env and hooks expand — the table in `docs/SERVERS.md`. */
export function serverTemplateVars(config: ServerConfig): TemplateVars {
  return {
    id: config.id,
    label: config.label ?? config.id,
    port: config.port ?? '',
    host: bindHost(config.bind),
    displayHost: displayHost(config.bind),
    bind: config.bind,
    lanIp: lanAddress() ?? '127.0.0.1',
    cwd: resolveCwd(config.cwd),
    projectDir,
    dataRoot,
    home: os.homedir(),
  }
}
