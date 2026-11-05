import fs from 'node:fs'
import path from 'node:path'
import { readStateFile } from '#src/helpers/config-text'

/**
 * Where an installed UI lives and whether one is there — deliberately free of the schema module, so
 * a CLI command that only *names* the UI (`status`) does not pay for compiling every contract.
 */
export function uiDirectory(dataRoot: string): string {
  return path.join(dataRoot, '.ui')
}

export function customUiInstalled(dataRoot: string): boolean {
  return fs.existsSync(path.join(uiDirectory(dataRoot), 'index.html'))
}

/** `name`/`version` from `ui.json` when they are strings; the full, validated read is `UiService.readMeta`. */
export function uiIdentity(dataRoot: string): { name: string | null, version: string | null } {
  try {
    const raw = JSON.parse(readStateFile(path.join(uiDirectory(dataRoot), 'ui.json'))) as Record<string, unknown>
    return {
      name: typeof raw.name === 'string' ? raw.name : null,
      version: typeof raw.version === 'string' ? raw.version : null,
    }
  }
  catch {
    return { name: null, version: null }
  }
}
