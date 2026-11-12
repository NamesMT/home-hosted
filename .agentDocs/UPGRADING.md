# Upgrading

Per-version migration notes, lifted into the GitHub release body by `scripts/release-notes.mjs`.
A section here is what a person reads when they upgrade — the CHANGELOG lists commits, not what to
do about them.

Keep each entry to what someone must *change*, not what was added. If a release has nothing a person
must act on, it needs no section here at all.

The script reads only the section for the version being released, so a section is deleted once that
version ships: its text lives on in that GitHub release's body.

## 0.14.0

**Exposing the panel beyond loopback now needs a password of at least 12 characters.** A panel bound
to a non-loopback address, or reached through a proxy route to the panel, refuses to start while its
password is shorter than that — and `home-hosted set-password` refuses to set one, as does
`POST /api/auth/password` (it answers `400 PASSWORD_TOO_SHORT`). A password short enough to guess
from the network is no longer enough protection. Passwords hashed by an older release carry no length
record and are not measured, so run `home-hosted set-password` once to be sure yours qualifies: a
loopback-only panel still accepts any length.

**`POST /api/servers` with an id that already exists answers `409 SERVER_EXISTS`.** It answered
`400 INVALID_SERVER`, the same code as a schema failure, so a client could not tell "pick another id"
from "fix the entry". Re-running the same declaration now reads as a conflict rather than a bad body.

**The README's hand-written systemd unit is gone; use `home-hosted service install`.** Uninstall the
old unit first (`systemctl --user disable --now home-hosted`), then run the command: it writes the
absolute `node` and CLI path, this home and project, your shell's `PATH`, and the two policies the old
unit got wrong. Its `Restart=always` brings the panel back after `down`, and its default `KillMode`
takes persistent entries down with the panel. On a user install it also prints the
`loginctl enable-linger` hint that keeps the panel running when you log out.

**https upstreams are verified.** A `server` or `external` proxy route to an https upstream with a
self-signed (or otherwise untrusted) certificate stops working. Set `upstreamSkipVerify: true` on that
route to accept it, as the route dialog now offers.

**An upstream with a path (`https://host/sub`) is rejected** and the route is not served — a proxy
route forwards the whole host, and the path part was silently dropped before. Point the route at the
host and keep the prefix in the route's own `path`, or use an upstream that serves it at the root.

**A DNS-01 "Automatic" account answers only for names in its zones.** The zones come from the
account's Dynamic DNS hostnames and from routes that name it, so a route whose hostname is in no zone
of the chosen account falls back to HTTP-01 instead of failing a challenge. Name the account on the
route when you want it used, and add the zone to the account (or to a DDNS hostname on it) when it is
missing.

**A hand-replaced Caddy binary is refused** while `engine.json` records the digest of the binary the
panel downloaded. Reinstall the engine, or delete `engine.json` to run the binary you put there as a
custom build.

**`ui-switch --file http://…` needs `--insecure`.** An installed release is checked against the digest
GitHub publishes, so a release download needs no flag; only a plain-http hand-supplied zip asks for
the opt-in, and plain http from a release URL is refused either way.

**`migrate` asks once for every file, then writes them all.** It planned and asked file by file, so a
person answering "no" partway through had already written the earlier ones. A "no" now writes nothing;
a non-interactive run still needs `--yes` (or `HHOSTED_MIGRATE=allow`).

**A new workspace id is at most 40 characters and cannot be a Windows device name** (`con`, `prn`,
`aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`), which no directory can carry there. Existing ids still
load, whatever their length — only creating one is bounded.

**`setup-temp --clear` leaves the shared helper in place** unless this home's `host.tempCommand` is the
one that runs it. The helper sits in a machine-wide directory, so another home on this machine may be
using it; delete the file yourself if you know none is.
