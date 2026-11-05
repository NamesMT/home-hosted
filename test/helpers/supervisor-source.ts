import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The supervisor's whole source: `src/services/supervisor.ts` plus every module under
 * `src/services/supervisor/`. A scan that read the entry file alone would pass vacuously for code
 * that moved into a module.
 */
export function supervisorSources(): string {
  const dir = path.join(root, 'src/services/supervisor')
  const files = [
    path.join(root, 'src/services/supervisor.ts'),
    ...fs.readdirSync(dir).filter(name => name.endsWith('.ts')).sort().map(name => path.join(dir, name)),
  ]
  return files.map(file => fs.readFileSync(file, 'utf8')).join('\n')
}
