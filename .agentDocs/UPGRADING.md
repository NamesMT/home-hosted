# Upgrading

Per-version migration notes, lifted into the GitHub release body by `scripts/release-notes.mjs`.
A section here is what a person reads when they upgrade — the CHANGELOG lists commits, not what to
do about them.

Keep each entry to what someone must *change*, not what was added. If a release has nothing a person
must act on, it needs no section here at all.

The script reads only the section for the version being released, so a section is deleted once that
version ships: its text lives on in that GitHub release's body.

## 0.13.0

**A config save can now answer `409 CONFIG_CHANGED_ON_DISK`.** When a `settings.json` or
`servers.config.json` was edited on disk after the panel last read it, a write through the API is
refused instead of silently overwriting that edit. The panel reloads the file; retry the request. A
script that treats every non-2xx as fatal should retry this one once.
