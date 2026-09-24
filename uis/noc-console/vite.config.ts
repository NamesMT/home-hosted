import { fileURLToPath } from 'node:url'
import { createUiConfig } from '../vite.shared'

export default createUiConfig(fileURLToPath(new URL('.', import.meta.url)))
