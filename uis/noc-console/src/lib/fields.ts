/**
 * The server form's textarea round-trips now live in one place shared by both UIs —
 * see `src/shared/fields.ts`. Re-exported here so this UI's imports stay local.
 */
export { commaList, envToText, linesToArray, textToEnv } from '@shared/fields'
