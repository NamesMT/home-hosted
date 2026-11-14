/**
 * Every error code this API can answer, in one place.
 *
 * A code is part of the contract — a script branches on it rather than on English — so it needs one
 * owner: where it exists, what it means, and the status it arrives with. Three things kept drifting
 * without this: "no such backup" had two codes (`UNKNOWN_BACKUP` from `api/backups.ts`,
 * `BACKUP_NOT_FOUND` from `api/control.ts`) for one condition, a Node errno (`ERR_FS_CP_DIR_TO_NON_DIR`)
 * reached a client through the envelope as if it were ours, and the only list of codes was
 * `docs/API.md`, which is prose and cannot be checked against the source.
 *
 * This is a **map, not a constraint**: nothing here validates a code at runtime, and a `DetailedError`
 * built elsewhere still answers with whatever it was given. What it enables is a test that walks every
 * literal `code:` in `src/` and fails on one missing here — `test/shared/error-codes.test.ts`.
 *
 * `AUTH_*` and `SESSION_*` live here too, because a client needs one list: the panel's own guard
 * answers those before any route runs, which is exactly the sort of code a generated client would
 * otherwise miss.
 *
 * Adding a code: add it here with its status and meaning, list it in `docs/API.md`'s error section,
 * and let the walk test tell you if a site was missed.
 */

/** What one code means, and the HTTP status it arrives with. */
export interface ErrorCodeSpec {
  /**
   * The status the envelope carries. A code with more than one (`LOGIN_FAILED` is 401, 409 or 429 —
   * "wrong password", "no password set", "too many attempts") names them in order of likelihood.
   */
  status: number
  /** One line, for a person reading `docs/API.md` or a generated client's comment. */
  meaning: string
}

/**
 * The catalogue, keyed by code.
 *
 * Ordered by area, not alphabetically, so a reader can see the shape of the API: input, auth, config,
 * lifecycle, proxy, backups, notifications, temperature, and the failures no route names.
 */
export const ERROR_CODES = {
  // ── Input and routing ────────────────────────────────────────────────────────────────────────────
  INVALID_INPUT: { status: 400, meaning: 'the body, query or path did not validate; `detail` lists the fields' },
  ID_MISMATCH: { status: 400, meaning: 'a `PUT` body\'s `id` does not match the path id' },
  NOT_FOUND: { status: 404, meaning: 'no route matches this method and path' },
  PAYLOAD_TOO_LARGE: { status: 413, meaning: 'the sign-in body was larger than the panel accepts' },
  INTERNAL_ERROR: { status: 500, meaning: 'a failure with no more specific code; the panel logged it' },
  DETAILED_ERROR: { status: 500, meaning: 'a `DetailedError` thrown without a code — a bug in the panel' },

  // ── Authentication and exposure ──────────────────────────────────────────────────────────────────
  AUTH_REQUIRED: { status: 401, meaning: 'no valid session or token; show the login screen' },
  AUTH_UNARMED: { status: 401, meaning: 'authentication is on but no password is set, and the caller is not this machine' },
  AUTH_DISABLED_REMOTE: { status: 401, meaning: 'authentication is off and the caller is not this machine (a proxy counts)' },
  LOGIN_FAILED: { status: 401, meaning: 'a sign-in failed: wrong password (401), no password set (409), or too many attempts (429)' },
  SESSION_REQUIRED: { status: 403, meaning: 'this operation needs a signed-in session, not an API token' },
  TOKEN_SCOPE: { status: 403, meaning: 'the API token\'s scopes do not cover this route, or its workspace limit excludes it; `detail` names what it needed and what it holds' },
  CURRENT_PASSWORD_REQUIRED: { status: 400, meaning: 'changing an existing password needs `currentPassword`' },
  CURRENT_PASSWORD_WRONG: { status: 401, meaning: '`currentPassword` was incorrect' },
  PASSWORD_TOO_SHORT: { status: 400, meaning: 'a password below the 12-character bar while the panel is exposed' },
  EXPOSED_WITHOUT_PASSWORD: { status: 400, meaning: 'this would expose the panel with authentication off or no password' },
  EXPOSURE_BLOCKED: { status: 400, meaning: 'the listener change would expose the panel without auth and a long-enough password' },
  PROXY_EXPOSURE_BLOCKED: { status: 400, meaning: 'a proxy route to the panel would expose it without auth and a long-enough password' },
  CROSS_ORIGIN: { status: 403, meaning: 'a cookie-authenticated write from another origin' },
  HOST_NOT_ALLOWED: { status: 421, meaning: 'the `Host` header names a host this panel does not answer to' },
  INVALID_TOKEN: { status: 403, meaning: 'the local `/_hh` token does not match `run.json`' },
  NOT_LOOPBACK: { status: 403, meaning: 'this local-only operation was called from another machine' },

  // ── Configuration ────────────────────────────────────────────────────────────────────────────────
  INVALID_SETTINGS: { status: 400, meaning: 'the settings patch was rejected by the store' },
  CONFIG_CHANGED_ON_DISK: { status: 409, meaning: 'the config file was edited since the panel read it; it reloads, so retry' },
  UNKNOWN_WORKSPACE: { status: 404, meaning: '`?workspace=` names no workspace this panel has' },
  SERVER_EXISTS: { status: 409, meaning: 'a server with this id already exists in the workspace' },
  NO_DEPLOY: { status: 400, meaning: 'this server has no deploy steps — nothing to run. Add a `deploy` block to its entry' },
  DEPLOY_RUNNING: { status: 409, meaning: 'a deploy is already running for this server; wait for it, or stop the server to cancel it' },
  DEPLOY_FAILED: { status: 409, meaning: 'a deploy step failed — the previous process is still running, and its log names the step' },
  ACCOUNT_EXISTS: { status: 409, meaning: 'an account with that id already exists — ids are what a login is keyed on, so two cannot share one' },
  UNKNOWN_JOB: { status: 404, meaning: 'no job has that id in this workspace' },
  JOB_EXISTS: { status: 409, meaning: 'a job with that id already exists — the id names its log and its history, so two would interleave output that cannot be untangled' },
  JOB_RUNNING: { status: 409, meaning: 'that job is already running; a second copy is refused rather than queued behind the first' },
  INVALID_JOB: { status: 400, meaning: 'the job would not be runnable — the message names the field and the fix (usually a cron expression that does not parse)' },
  INVALID_CONFIG: { status: 400, meaning: 'the jobs file could not be read, or is not a jobs file — it was left untouched so a hand-edit is not lost' },
  UNKNOWN_ACCOUNT: { status: 404, meaning: 'no account has that id' },
  CANNOT_REVOKE_SELF: { status: 400, meaning: 'that is the account making the request — sign in as another one to revoke it, or the caller signs itself out mid-action' },
  LAST_ACCOUNT: { status: 400, meaning: 'that is the last account that can sign in; revoking it would leave the panel with no way in' },
  TOKEN_EXISTS: { status: 409, meaning: 'an API token with that name already exists — two tokens with one name cannot be told apart' },
  UNKNOWN_TOKEN: { status: 404, meaning: 'no API token has that id' },

  // ── Server lifecycle ─────────────────────────────────────────────────────────────────────────────
  UNKNOWN_SERVER: { status: 404, meaning: 'no server has that id in the workspace' },
  SERVER_DISABLED: { status: 409, meaning: 'the entry is switched off (`enabled: false`)' },
  SERVER_BUSY: { status: 409, meaning: 'a stop, or the same action, is already in flight' },
  // Still reached by the embedded job path on a server entry (`kind: "job"`), which the jobs domain
  // replaces. They go with that path, in the commit that removes it.
  NOT_A_JOB: { status: 409, meaning: '`run` is for a job — a service is started and supervised instead, with `start`' },
  JOB_FAILED: { status: 409, meaning: 'the run happened and failed — its exit code is the outcome, and its log says why' },
  JOB_START_FAILED: { status: 400, meaning: 'the run could not be spawned at all (an unusable `command` or `cwd`)' },
  PORT_IN_USE: { status: 409, meaning: 'the entry\'s port is held and could not be freed' },
  DEPENDENCY_FAILED: { status: 409, meaning: 'an entry in `dependsOn` could not be started' },
  ACTION_FAILED: { status: 409, meaning: 'a lifecycle refusal none of the more specific codes describes' },
  UNKNOWN_ORPHAN: { status: 404, meaning: 'no orphaned process is running under that id' },
  ORPHAN_SURVIVED: { status: 409, meaning: 'an orphaned process ignored the stop' },
  UNKNOWN_LOG_FILE: { status: 404, meaning: 'that file is not one of this entry\'s log rotations' },
  CURSOR_OUT_OF_RANGE: { status: 400, meaning: 'a `?since=`/`?before=` cursor is older than the lines this route reads; download the log file for the full history' },

  // ── Reverse proxy ────────────────────────────────────────────────────────────────────────────────
  INVALID_PROXY: { status: 400, meaning: 'the proxy configuration failed validation; `detail` lists the problems' },
  PROXY_DISABLED: { status: 400, meaning: 'the reverse proxy is switched off' },
  PROXY_ROUTE_UNKNOWN: { status: 404, meaning: 'no proxy route has that id' },
  PROXY_CERT_NOT_MANAGED: { status: 400, meaning: 'that host is not one a CA issues for, so there is no certificate to retry' },
  PROXY_CERT_RETRY_LAST_ROUTE: { status: 409, meaning: 'that is the only route on its name; the certificate could not be dropped for a retry' },
  PROXY_TLS_IN_USE: { status: 400, meaning: 'that certificate is still used by a route' },
  PROXY_PORT_IN_USE: { status: 409, meaning: 'a proxy port is held by something else; `detail.holders` names them' },
  PROXY_CONFIG_REJECTED: { status: 400, meaning: 'the engine refused the generated configuration' },
  PROXY_NO_PREVIOUS: { status: 400, meaning: 'there is no earlier engine configuration to revert to' },
  PROXY_NO_ADMIN_PORT: { status: 500, meaning: 'no free loopback port was found for the engine admin endpoint' },
  INVALID_CERTIFICATE: { status: 400, meaning: 'an uploaded PEM pair was rejected' },
  UNKNOWN_ENGINE: { status: 500, meaning: 'the configured proxy engine name is not one this panel implements' },
  ENGINE_MISSING: { status: 400, meaning: 'the proxy engine is not installed yet' },
  ENGINE_NOT_RUNNING: { status: 400, meaning: 'the proxy engine is not running' },
  ENGINE_NOT_READY: { status: 502, meaning: 'the engine started but never answered on its admin endpoint' },
  ENGINE_UNREACHABLE: { status: 502, meaning: 'the engine admin endpoint did not answer' },
  ENGINE_ALREADY_RUNNING: { status: 409, meaning: 'an engine is running whose admin endpoint the panel does not know' },
  ENGINE_BUSY: { status: 409, meaning: 'the engine is running, so it cannot be replaced' },
  ENGINE_INTEGRITY: { status: 409, meaning: 'the installed engine binary is not the one the panel downloaded' },
  ENGINE_MODULE_NOT_INSTALLED: { status: 400, meaning: 'the engine module is not available in this install' },
  ENGINE_DOWNLOAD_FAILED: { status: 502, meaning: 'the engine download or its verification failed' },
  ENGINE_DOWNLOAD_UNTRUSTED: { status: 502, meaning: 'the engine download did not come from where it should' },
  INVALID_ENGINE_VERSION: { status: 400, meaning: 'that is not a version of this engine' },
  UNSUPPORTED_PLATFORM: { status: 400, meaning: 'the engine has no build for this platform/architecture' },

  // ── Backups and restore ──────────────────────────────────────────────────────────────────────────
  BACKUP_FAILED: { status: 400, meaning: 'the archive could not be written' },
  /** The one code for "no such backup": `api/backups.ts` used `UNKNOWN_BACKUP` for the same condition. */
  BACKUP_NOT_FOUND: { status: 404, meaning: 'no archive has that name' },
  MISSING_ARCHIVE: { status: 400, meaning: 'a restore needs a backup name or an uploaded file' },
  MISSING_FILE: { status: 400, meaning: 'the multipart body carried no `file` field' },
  MISSING_NAME: { status: 400, meaning: 'a restore needs `name` (or `from`)' },
  NAME_AND_FROM: { status: 400, meaning: 'a restore takes `name` or `from`, not both' },
  FROM_NOT_ABSOLUTE: { status: 400, meaning: '`from` must be an absolute path' },
  RESTORE_FAILED: { status: 400, meaning: 'the restore plan could not be applied; `detail` names the items' },
  RESTORE_IN_PROGRESS: { status: 409, meaning: 'a restore is already running' },
  INVALID_UI: { status: 400, meaning: 'the uploaded UI zip was rejected' },
  UPLOAD_TOO_LARGE: { status: 413, meaning: 'the upload is larger than the limit' },
  CONFIG_COPY_CONFLICT: { status: 400, meaning: 'a directory could not be copied over a non-directory (this used to leak the Node code `ERR_FS_CP_DIR_TO_NON_DIR`)' },

  // ── Notifications, DDNS and the temperature bridge ──────────────────────────────────────────────
  TELEGRAM_TOKEN_REJECTED: { status: 400, meaning: 'Telegram did not accept the bot token' },
  TELEGRAM_LIST_FAILED: { status: 400, meaning: 'listing chats from Telegram failed' },
  WEBHOOK_SEND_FAILED: { status: 400, meaning: 'the test webhook could not be delivered' },
  INVALID_DDNS: { status: 400, meaning: 'the DDNS configuration failed validation; `detail` lists the problems' },
  INVALID_DDNS_CREDENTIALS: { status: 400, meaning: 'the DDNS account credentials were rejected by their provider' },
  UNKNOWN_DDNS_PROVIDER: { status: 400, meaning: 'no DDNS provider has that id' },
  NOT_WSL: { status: 400, meaning: 'the temperature bridge is WSL2-only' },
  WINDOWS_DRIVE_MISSING: { status: 400, meaning: 'the Windows drive is not mounted where the helper must be written' },
  SCRIPT_WRITE_FAILED: { status: 400, meaning: 'the temperature helper could not be written' },
  LIBRARY_INSTALL_FAILED: { status: 400, meaning: 'LibreHardwareMonitor could not be installed' },
} as const satisfies Record<string, ErrorCodeSpec>

/** Every code this API may answer with. */
export type ErrorCode = keyof typeof ERROR_CODES

/** The status a code arrives with — the catalogue's own answer, for a test or a generated client. */
export function statusOfCode(code: string): number | null {
  return code in ERROR_CODES ? ERROR_CODES[code as ErrorCode].status : null
}
