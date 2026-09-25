# Changelog


## v0.6.1

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.6.0...v0.6.1)

### 🚀 Enhancements

- **ui:** Let a UI declare where it came from, and follow it ([b52ee2a](https://github.com/NamesMT/home-hosted/commit/b52ee2a))

### 🩹 Fixes

- **ui:** Close the reinstall loop, and the boot-path defects behind it ([ed798b8](https://github.com/NamesMT/home-hosted/commit/ed798b8))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.6.0

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.5.0...v0.6.0)

### 🚀 Enhancements

- **cli:** An hh alias for the installed command ([eead327](https://github.com/NamesMT/home-hosted/commit/eead327))
- **cli:** Per-command --help ([bd5f5d3](https://github.com/NamesMT/home-hosted/commit/bd5f5d3))
- **cli:** Color the curated help text ([818e6a8](https://github.com/NamesMT/home-hosted/commit/818e6a8))
- **supervisor:** Add a `kill` policy to onPortConflict ([fd46fbd](https://github.com/NamesMT/home-hosted/commit/fd46fbd))
- **supervisor:** Identify a detached successor by its argv, not only the env marker ([f0f07b9](https://github.com/NamesMT/home-hosted/commit/f0f07b9))

### 🩹 Fixes

- **identity:** Stop trimming argv words when comparing a spawn ([d5a6aae](https://github.com/NamesMT/home-hosted/commit/d5a6aae))
- **identity:** Compare arguments literally, never by basename ([03fef51](https://github.com/NamesMT/home-hosted/commit/03fef51))
- **supervisor:** Honour stop.graceMs, stop adopted successors when disabled ([173b740](https://github.com/NamesMT/home-hosted/commit/173b740))
- Windows and macOS findings from the first cross-platform run ([40f9ea1](https://github.com/NamesMT/home-hosted/commit/40f9ea1))
- **identity:** Read an argument through the quoting Windows reports ([164e197](https://github.com/NamesMT/home-hosted/commit/164e197))

### 💅 Refactors

- ⚠️  Rename hh2 to hh ([add94d7](https://github.com/NamesMT/home-hosted/commit/add94d7))

### 📖 Documentation

- Rework the README's why, flags and endpoint tables ([c655f9e](https://github.com/NamesMT/home-hosted/commit/c655f9e))

### ✅ Tests

- Temporary Windows identity diagnostic ([2413ae5](https://github.com/NamesMT/home-hosted/commit/2413ae5))
- Refine the Windows identity diagnostic ([e7fd9b5](https://github.com/NamesMT/home-hosted/commit/e7fd9b5))

### 🤖 CI

- **release:** Give npm five minutes to show the publish ([6990c51](https://github.com/NamesMT/home-hosted/commit/6990c51))
- Run the suite on macOS and Windows, dispatched or called ([467e1d0](https://github.com/NamesMT/home-hosted/commit/467e1d0))
- **release:** Gate the release on the macOS and Windows suite ([6f0c78f](https://github.com/NamesMT/home-hosted/commit/6f0c78f))
- **release:** Run the gate on a dry run, and stop trusting `!${{ inputs.dry-run }}` ([e020b33](https://github.com/NamesMT/home-hosted/commit/e020b33))

#### ⚠️ Breaking Changes

- ⚠️  Rename hh2 to hh ([add94d7](https://github.com/NamesMT/home-hosted/commit/add94d7))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.5.0

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.4.1...v0.5.0)

### 🚀 Enhancements

- **backups:** Skip known generated directories per entry ([9932a41](https://github.com/NamesMT/home-hosted/commit/9932a41))
- **ui:** One switch per boolean, advanced options when adding, a change review ([0e70e26](https://github.com/NamesMT/home-hosted/commit/0e70e26))
- **ui:** Let the add dialog set the lifecycle groups too ([e84c7cf](https://github.com/NamesMT/home-hosted/commit/e84c7cf))
- **noc-console:** Scrollable pages, a resizable split, and settings that stay put ([b639f17](https://github.com/NamesMT/home-hosted/commit/b639f17))
- **cli:** Ui-switch — install a UI from a release asset, a zip or a URL ([c483b91](https://github.com/NamesMT/home-hosted/commit/c483b91))
- **ui:** Create a server with only what was decided ([c321b64](https://github.com/NamesMT/home-hosted/commit/c321b64))
- **config:** Pick up a hand-edited config without a restart ([00894ea](https://github.com/NamesMT/home-hosted/commit/00894ea))

### 🩹 Fixes

- **ui:** Fill each settings block on its own, and reach every dialog footer ([45ab153](https://github.com/NamesMT/home-hosted/commit/45ab153))
- **shared:** Compare a nested patch member by value ([5346c29](https://github.com/NamesMT/home-hosted/commit/5346c29))
- **shared:** Treat a null member and a reordered key as the same value ([47d485f](https://github.com/NamesMT/home-hosted/commit/47d485f))
- **ui:** Open the event stream when authentication is off ([15dece9](https://github.com/NamesMT/home-hosted/commit/15dece9))
- **supervisor:** Never wedge an entry, and never let a tick end the daemon ([8fe4ffb](https://github.com/NamesMT/home-hosted/commit/8fe4ffb))
- **index:** End the process even if shutdown throws ([e4ebb12](https://github.com/NamesMT/home-hosted/commit/e4ebb12))
- **ports:** Never sweep a listener this panel supervises ([fd60d85](https://github.com/NamesMT/home-hosted/commit/fd60d85))
- **config:** Merge the panel defaults into a nested group key by key ([9e77c52](https://github.com/NamesMT/home-hosted/commit/9e77c52))
- **cli:** Read a bare help after a command as an option value ([c68aff0](https://github.com/NamesMT/home-hosted/commit/c68aff0))
- **auth:** Refuse a corrupt API token hash instead of throwing ([ac87da0](https://github.com/NamesMT/home-hosted/commit/ac87da0))
- **logs:** Cap the partial line a child can buffer ([7a64da1](https://github.com/NamesMT/home-hosted/commit/7a64da1))
- **api:** Describe /api/settings, cap the per-server stream, harden backups ([648f224](https://github.com/NamesMT/home-hosted/commit/648f224))
- **process:** Find a Windows shim, and expand a `~\` path ([48eca51](https://github.com/NamesMT/home-hosted/commit/48eca51))

### 💅 Refactors

- **cli:** Move dispatch and argument parsing to citty ([7215319](https://github.com/NamesMT/home-hosted/commit/7215319))

### 📖 Documentation

- Bring back the Why? section, and tip a project-specific panel port ([0d6cc50](https://github.com/NamesMT/home-hosted/commit/0d6cc50))
- **ui:** What the API does not tell a UI author ([e79f6fe](https://github.com/NamesMT/home-hosted/commit/e79f6fe))
- **agents:** A create body writes only what was decided ([9b13731](https://github.com/NamesMT/home-hosted/commit/9b13731))
- Move the topic docs into docs/ ([ea9c96f](https://github.com/NamesMT/home-hosted/commit/ea9c96f))
- The hand-edit reload, the current file tree, per-command help ([7ee2702](https://github.com/NamesMT/home-hosted/commit/7ee2702))
- **ui:** The stream gate, and partial entry bodies ([a433425](https://github.com/NamesMT/home-hosted/commit/a433425))
- **agents:** The flags, the defaults merge and the wedged stop ([12cdb73](https://github.com/NamesMT/home-hosted/commit/12cdb73))
- **uis:** A README for each UI ([badb18d](https://github.com/NamesMT/home-hosted/commit/badb18d))
- README minor ([6f707c3](https://github.com/NamesMT/home-hosted/commit/6f707c3))

### 🏡 Chore

- **media:** Regenerate the README's screenshots ([2ac0e49](https://github.com/NamesMT/home-hosted/commit/2ac0e49))
- **media:** Stop tracking the generated PNGs ([f3aa80d](https://github.com/NamesMT/home-hosted/commit/f3aa80d))
- **media:** Regenerate the tour after the UI fixes ([1eff85c](https://github.com/NamesMT/home-hosted/commit/1eff85c))
- Add the `pnpm run restart` script AGENTS.md already lists ([efcdad1](https://github.com/NamesMT/home-hosted/commit/efcdad1))
- **notifications:** The test message is not `home-hosted-2` ([36c527d](https://github.com/NamesMT/home-hosted/commit/36c527d))

### ✅ Tests

- Floor the coverage, and stop reading the shell's HHOSTED_PROJECT ([46a25e2](https://github.com/NamesMT/home-hosted/commit/46a25e2))

### 🤖 CI

- **release:** Make the tag follow a rebase and verify the notes ([363e2b8](https://github.com/NamesMT/home-hosted/commit/363e2b8))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.4.1

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.4.0...v0.4.1)

### 🩹 Fixes

- **ui:** Make numeric fields keep what was typed into them ([a32cd13](https://github.com/NamesMT/home-hosted/commit/a32cd13))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.4.0

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.3.0...v0.4.0)

### 🚀 Enhancements

- **auth:** API tokens, so scripts and agents can skip the login dance ([e0922f0](https://github.com/NamesMT/home-hosted/commit/e0922f0))
- **servers:** Kill whatever holds a conflicted port, from the panel ([497444f](https://github.com/NamesMT/home-hosted/commit/497444f))
- **ui:** Confirm the port kill in a popover, not an armed button ([5a21a7d](https://github.com/NamesMT/home-hosted/commit/5a21a7d))
- **config:** ⚠️  Stamp what wrote the file, tolerate newer keys, refuse broken ones ([81500f7](https://github.com/NamesMT/home-hosted/commit/81500f7))
- **servers:** Adopt a detached restart of a server instead of blocking on its port ([9d9a2e5](https://github.com/NamesMT/home-hosted/commit/9d9a2e5))
- **servers:** Split the self-restart policy into follow and reclaim ([8a50f0a](https://github.com/NamesMT/home-hosted/commit/8a50f0a))
- **cli:** An interactive init, and a README that reads in one pass ([cac355f](https://github.com/NamesMT/home-hosted/commit/cac355f))

### 🩹 Fixes

- **ui:** The live output view never re-rendered ([a2bad59](https://github.com/NamesMT/home-hosted/commit/a2bad59))
- **ui:** Make the live output actually update, and survive an older panel ([4b207e7](https://github.com/NamesMT/home-hosted/commit/4b207e7))
- **supervisor:** Publish a state frame when a resource sample lands ([87724e8](https://github.com/NamesMT/home-hosted/commit/87724e8))

### 📖 Documentation

- **agents:** Write down the compatibility policy ([6cc0427](https://github.com/NamesMT/home-hosted/commit/6cc0427))

### 🏡 Chore

- **devcontainer:** Migrate from Alpine (musl) to Arch (glibc) image ([c0a9d42](https://github.com/NamesMT/home-hosted/commit/c0a9d42))
- **media:** A demo stack that reads like one, and a panel that names itself ([1030211](https://github.com/NamesMT/home-hosted/commit/1030211))

### 🤖 CI

- **release:** Verify the publish landed, and name staging when it did not ([8cd2811](https://github.com/NamesMT/home-hosted/commit/8cd2811))
- **release:** Attest the tarball, and drop a machine-flavoured sample path ([1aaa3ec](https://github.com/NamesMT/home-hosted/commit/1aaa3ec))

#### ⚠️ Breaking Changes

- **config:** ⚠️  Stamp what wrote the file, tolerate newer keys, refuse broken ones ([81500f7](https://github.com/NamesMT/home-hosted/commit/81500f7))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.3.0

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.2.0...v0.3.0)

### 🚀 Enhancements

- **docs:** A GIF tour of the panel, from real screenshots ([42943e4](https://github.com/NamesMT/home-hosted/commit/42943e4))

### 🩹 Fixes

- **uis:** Make the custom bind selectable, and document the placeholders ([971f8ee](https://github.com/NamesMT/home-hosted/commit/971f8ee))

### 📖 Documentation

- **readme:** Tighten for a public first read, and add a fourth direction ([ecae1bb](https://github.com/NamesMT/home-hosted/commit/ecae1bb))
- **agents:** The scripts, the media pipeline and the release path ([08ad269](https://github.com/NamesMT/home-hosted/commit/08ad269))

### 🏡 Chore

- Refresh the package metadata and the CI action majors ([5f08310](https://github.com/NamesMT/home-hosted/commit/5f08310))

### 🤖 CI

- **release:** Replay the release commit if main moved during the run ([984ee6f](https://github.com/NamesMT/home-hosted/commit/984ee6f))
- **release:** Autostash and retry the release push ([c6ec3b2](https://github.com/NamesMT/home-hosted/commit/c6ec3b2))
- **release:** Give the runner a git identity, and assert the release happened ([55bff56](https://github.com/NamesMT/home-hosted/commit/55bff56))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

