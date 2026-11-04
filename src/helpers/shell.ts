import process from 'node:process'

/**
 * A value quoted for the shell it will be pasted into.
 *
 * One rule for every string this package prints for a person to copy: a directory, an id, a
 * workspace. `init` printed `cd my servers && npm run up` for the default `./my-servers`-style
 * directory a person picks, which the shell answers `cd: too many arguments` — a failure in the one
 * line the scaffold exists to hand over.
 *
 * POSIX gets single quotes, with an embedded quote closed and reopened (`'\''`), the one form that is
 * safe inside a single-quoted string. Windows' `cmd.exe` has no single-quote quoting at all, so it
 * gets double quotes: that is what it understands, and a path whose name contains a `"` is not
 * representable there either way.
 *
 * It cannot use the platform to *decide the shell*, only to pick the dialect: a POSIX path is
 * quoted for `sh` even when the process is running on Windows (the panel's CLI under Git Bash), and
 * a Windows path for `cmd.exe`. `process.platform` is the only signal available, so the rule is
 * documented rather than guessed at each call site.
 */
export function shellQuote(value: string): string {
  return process.platform === 'win32'
    ? `"${value}"`
    : `'${value.replace(/'/g, `'\\''`)}'`
}
