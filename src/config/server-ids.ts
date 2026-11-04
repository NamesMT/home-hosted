import { readStateFile } from '#src/helpers/config-text'
import { isRecord } from '#src/shared/shape'

/**
 * The server ids a workspace's `servers.config.json` declares — or `null` when the file cannot
 * answer, which is a different fact from "it declares none".
 *
 * Read-only and tolerant on purpose. `WorkspaceStore.load()` *seeds* a missing file, so a
 * diagnostic command that reached for it would write to the state root it was only reading; and a
 * config this release cannot parse must not turn a log lookup into a refusal. Both of those
 * collapse to `null`, and every caller then answers as it did before, because "I cannot tell"
 * is not "there is no such entry".
 *
 * The entries are not validated against `serverSchema`: this answers which *files* may exist
 * (`<id>.log`), and an entry with a bad field still writes a log under its own id.
 */
export function readDeclaredServerIds(file: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readStateFile(file))
  }
  catch {
    // Missing or not JSON: nothing to decide from.
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.servers))
    return null

  const ids: string[] = []
  for (const entry of parsed.servers) {
    if (isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0)
      ids.push(entry.id)
  }
  return ids
}
