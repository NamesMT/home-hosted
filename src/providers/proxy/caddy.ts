import type { ProxyEngine, ProxyEngineDownload, ProxyEngineRun, ProxyEngineTarget } from '#src/providers/proxy/types'

/**
 * Caddy, driven through its admin API.
 *
 * The panel generates the whole JSON configuration and applies it with
 * `POST /load`, which is atomic: a configuration that does not load leaves the
 * running one in place. Plugins are compiled into the binary by Caddy's own build
 * service, so the download is a single URL that names them.
 *
 * The release is **not** pinned: an install takes whatever the build service
 * currently serves, so a security fix reaches the user by pressing Update. What the
 * panel is known to work against is written down in `docs/REVERSE_PROXY.md`; the
 * version that actually arrived is read from the binary and recorded.
 */

/** The Next.js-style build service that returns a ready binary, plugins included. */
const BUILD_URL = 'https://caddyserver.com/api/download'

/**
 * The one module this build carries: the ACMEProxy DNS provider, which lets the
 * engine ask the panel to write a DNS-01 challenge record instead of holding DNS
 * credentials itself. It is compiled in for every install, not only when DNS-01 is
 * switched on, so the binary does not depend on a setting that can change later.
 */
const PLUGINS = ['github.com/caddy-dns/acmeproxy']

/** `process.platform` matches Caddy's own GOOS names; only the arch needs mapping. */
function goArch(arch: string): string | null {
  switch (arch) {
    case 'x64': return 'amd64'
    case 'arm64': return 'arm64'
    case 'arm': return 'armv7'
    case 'ia32': return '386'
    default: return null
  }
}

export const caddyEngine: ProxyEngine = {
  info: {
    id: 'caddy',
    label: 'Caddy',
    docsUrl: 'https://caddyserver.com/docs/',
    releaseUrl: 'https://github.com/caddyserver/caddy/releases',
    acme: true,
    internalCa: true,
    // Compiled in (see PLUGINS): the panel answers the challenge, the engine asks it.
    dns01: true,
    tcp: false,
  },

  binaryName(platform: NodeJS.Platform): string {
    return platform === 'win32' ? 'hh-caddy.exe' : 'hh-caddy'
  },

  download(target: ProxyEngineTarget): ProxyEngineDownload | null {
    const arch = goArch(target.arch)
    if (arch === null)
      return null
    if (target.platform !== 'linux' && target.platform !== 'darwin' && target.platform !== 'win32')
      return null

    // No `version` unless one was asked for, which is how "the current release" is
    // spelled. A named release is only a request: the build service answers a URL
    // that names plugins with its own current release either way.
    const wanted = target.version.length > 0 ? `&version=${encodeURIComponent(target.version)}` : ''
    const plugins = PLUGINS.map(plugin => `&p=${encodeURIComponent(plugin)}`).join('')
    const url = `${BUILD_URL}?os=${target.platform}&arch=${arch}${wanted}${plugins}`
    return { url, version: target.version }
  },

  runArgs(run: ProxyEngineRun): string[] {
    // No `--adapter`: the `.json` extension already selects the native adapter,
    // and Caddy has no adapter it calls "json".
    return ['run', '--config', run.configPath]
  },

  /**
   * Only a belt beside the generated config's own `storage.root`: the engine must
   * never scatter certificates under a home directory the panel does not own.
   * `APPDATA` is what Caddy calls the data directory on Windows.
   */
  env(run: ProxyEngineRun): Record<string, string> {
    return {
      XDG_DATA_HOME: `${run.engineDir}/data`,
      XDG_CONFIG_HOME: `${run.engineDir}/config`,
      APPDATA: `${run.engineDir}/appdata`,
      LOCALAPPDATA: `${run.engineDir}/localappdata`,
    }
  },

  /** `caddy version` prints `v2.11.4 h1:...`; the first token is the release. */
  parseVersion(output: string): string | null {
    const match = output.trim().match(/^v?(\d+\.\d+\.\d[\w.+-]*)/)
    return match?.[1] ?? null
  },
}
