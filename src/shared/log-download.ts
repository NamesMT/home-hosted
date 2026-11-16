/**
 * Which log file a download link may point at.
 *
 * A link is only honest once the file exists. `GET /api/logs/:id/download` refuses an unknown name
 * with `404 UNKNOWN_LOG_FILE` — so a link built from convention (`<id>.log`) rather than from the
 * file list is a button that always fails, on exactly the entry a person reaches first: a server
 * that has not produced output yet, or one whose workspace has persistence off.
 *
 * Both UIs had this, gated on something that is *not* the file's existence:
 *
 * - `uis/stock`'s server detail page gated on `config.logBufferLines > 0`, which describes the
 *   in-memory buffer and says nothing about disk, so it offered "Download the persisted file" for
 *   an entry that had never written one;
 * - `uis/noc-console`'s Logs page gated on `enabled`, which is the workspace's `logs.persist`
 *   setting — true with no file on disk.
 *
 * Measured on the dev panel: `/w/default/servers/python` and `/w/default/logs` each rendered a
 * visible 32×32 / 126×24 link to
 * `/api/logs/python/download?file=python.log&workspace=default`, and that URL answered **404**,
 * while the same page reported `files: []` and listed nothing on disk.
 *
 * The list is the only trustworthy answer: the panel builds it by stating the files that are
 * actually there (`logFiles.info()`), so an entry is present exactly when a download can succeed.
 */

/** The part of a log file entry this needs; narrowed so a test needs no whole view. */
export interface LogFileEntry {
  name: string
}

/**
 * The file named `preferred` when it is on disk, else `null` — so a caller can hide the control
 * instead of aiming it at a 404.
 *
 * `preferred` is a convention (`<id>.log`) because that is the name the current file has while it
 * is being written; the answer still comes from the list, so a rotation-only set (`<id>.log.1`)
 * yields `null` here and a caller that wants those links offers each listed name instead.
 */
export function existingLogFile(files: readonly LogFileEntry[], preferred: string): string | null {
  return files.some(file => file.name === preferred) ? preferred : null
}
