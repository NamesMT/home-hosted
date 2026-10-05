# Changelog


## v0.7.6

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.5...v0.7.6)

### 🩹 Fixes

- **init:** The scaffold's .gitignore ignored the workspace definitions it promises to track ([acfaca5](https://github.com/NamesMT/home-hosted/commit/acfaca5))
- **cli:** A local call settles when the panel cuts the response mid-body ([4a367d3](https://github.com/NamesMT/home-hosted/commit/4a367d3))
- **layout:** An unreadable legacy config is reported, not silently abandoned ([c360126](https://github.com/NamesMT/home-hosted/commit/c360126))

### ✅ Tests

- **cli:** Pin ui-update's --check precedence and its refusal to guess ([90768cf](https://github.com/NamesMT/home-hosted/commit/90768cf))
- **config-watch:** Keep the poll on, so the macOS watch cannot flake ([81d9f2c](https://github.com/NamesMT/home-hosted/commit/81d9f2c))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.5

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.4...v0.7.5)

### 🩹 Fixes

- **supervisor:** A bootstrap that cannot spawn, a stop that reached nothing, a leaked listener ([6a8457d](https://github.com/NamesMT/home-hosted/commit/6a8457d))
- **backups:** A restore may not write through a symlink out of the declared path ([6a0620d](https://github.com/NamesMT/home-hosted/commit/6a0620d))
- **proxy:** A nanny that cannot be spawned no longer ends the panel ([17b7bfe](https://github.com/NamesMT/home-hosted/commit/17b7bfe))
- **backups:** Resolve both sides of the path check, so macOS paths are not refused ([6e5fd35](https://github.com/NamesMT/home-hosted/commit/6e5fd35))
- **proxy:** An upstream on the scheme's default port is usable ([0e416ef](https://github.com/NamesMT/home-hosted/commit/0e416ef))
- **log-tail:** A backfill no longer drops a whole line ([55fc689](https://github.com/NamesMT/home-hosted/commit/55fc689))
- **proxy:** The engine probe really escalates to SIGKILL ([f2a556b](https://github.com/NamesMT/home-hosted/commit/f2a556b))
- **proxy:** A stop kills every surviving pid, not just one ([f79d706](https://github.com/NamesMT/home-hosted/commit/f79d706))
- **proxy:** One route per host and path, and no ACME for dotted digits ([7db5287](https://github.com/NamesMT/home-hosted/commit/7db5287))
- **archive:** A directory vanishing mid-walk does not fail the backup ([7e80fa2](https://github.com/NamesMT/home-hosted/commit/7e80fa2))
- **cli:** Ui-update records the release it fetched, not the archive's stale tag ([8fc0f92](https://github.com/NamesMT/home-hosted/commit/8fc0f92))
- **cli:** Ui-switch records the release it fetched, not the archive's stale tag ([881643d](https://github.com/NamesMT/home-hosted/commit/881643d))

### 📖 Documentation

- Correct the proxy certificate route, and list the proxy endpoints ([d6fb79a](https://github.com/NamesMT/home-hosted/commit/d6fb79a))
- Fix six claims the code contradicts ([b168cd6](https://github.com/NamesMT/home-hosted/commit/b168cd6))

### ✅ Tests

- **contracts:** Scan every source file for genericity, not a hand-kept list ([bda6cea](https://github.com/NamesMT/home-hosted/commit/bda6cea))
- **coverage:** Floor each area, so a whole module cannot quietly drop out ([5facd96](https://github.com/NamesMT/home-hosted/commit/5facd96))
- **proxy:** Keep the default-port regression off real listener ports ([88ffd67](https://github.com/NamesMT/home-hosted/commit/88ffd67))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.4

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.3...v0.7.4)

### 🩹 Fixes

- **nanny:** Arm the stop traps before the child exists ([ec61e16](https://github.com/NamesMT/home-hosted/commit/ec61e16))

### 📖 Documentation

- **README:** Revise README ([0086a64](https://github.com/NamesMT/home-hosted/commit/0086a64))

### ✅ Tests

- **panel:** Cover the real PanelService, and refresh the stale README media ([a031a61](https://github.com/NamesMT/home-hosted/commit/a031a61))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))
- Trung Dang ([@NamesMT](https://github.com/NamesMT))

## v0.7.3

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.2...v0.7.3)

### 🚀 Enhancements

- **proxy:** Answer DNS-01 through the panel's own DNS accounts ([f984594](https://github.com/NamesMT/home-hosted/commit/f984594))
- **ddns:** Add a Namecheap API provider ([f7bc12a](https://github.com/NamesMT/home-hosted/commit/f7bc12a))

### 📖 Documentation

- **ui:** Page paths are part of the UI contract ([940d46a](https://github.com/NamesMT/home-hosted/commit/940d46a))

### 🏡 Chore

- **devcontainer:** Migrate pnpm store mount to XDG ~/.local/share/pnpm ([28322f0](https://github.com/NamesMT/home-hosted/commit/28322f0))
- Stamp ui.json when the commit is made ([cd5063d](https://github.com/NamesMT/home-hosted/commit/cd5063d))

### ✅ Tests

- **proxy:** Run the engine-binary probes on Linux and macOS only ([2a1312d](https://github.com/NamesMT/home-hosted/commit/2a1312d))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.2

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.1...v0.7.2)

### 🚀 Enhancements

- **proxy:** Reverse proxy with automatic HTTPS, driven by the panel ([60039ad](https://github.com/NamesMT/home-hosted/commit/60039ad))
- **proxy:** Several uploaded certificates, and never a dead handshake ([637e45c](https://github.com/NamesMT/home-hosted/commit/637e45c))
- **ui:** Uploaded certificates are a list, and a route shows its certificate state ([be823fe](https://github.com/NamesMT/home-hosted/commit/be823fe))

### 🩹 Fixes

- **proxy:** Reach the engine with the account and the ports it actually has ([b9c68b1](https://github.com/NamesMT/home-hosted/commit/b9c68b1))
- **proxy:** Keep the uploaded certificate while a route serves it ([5ca6898](https://github.com/NamesMT/home-hosted/commit/5ca6898))
- **proxy:** One ACME issuer, and say what the challenge needs ([b91a1a2](https://github.com/NamesMT/home-hosted/commit/b91a1a2))
- **ui:** Stop the proxy page from scrolling the document ([196fe58](https://github.com/NamesMT/home-hosted/commit/196fe58))
- **proxy:** Apply the current configuration to a reattached engine ([0d3dbfb](https://github.com/NamesMT/home-hosted/commit/0d3dbfb))
- **proxy:** Never serve an uploaded pair that cannot be used ([6c08bfc](https://github.com/NamesMT/home-hosted/commit/6c08bfc))
- **proxy:** Key the certificate snapshot on the config and the pair files ([1e22a33](https://github.com/NamesMT/home-hosted/commit/1e22a33))
- **proxy:** The not-ready page covers the whole host, prefix or not ([adb052c](https://github.com/NamesMT/home-hosted/commit/adb052c))
- **ui:** The setcap command reads as inline code ([45bbd30](https://github.com/NamesMT/home-hosted/commit/45bbd30))
- **ui:** The copy button sits on the same line as what it copies ([f990018](https://github.com/NamesMT/home-hosted/commit/f990018))

### 📖 Documentation

- README typo ([126139e](https://github.com/NamesMT/home-hosted/commit/126139e))
- Mark which endpoints are workspace-scoped ([f7db7de](https://github.com/NamesMT/home-hosted/commit/f7db7de))
- README update ([b9f48ee](https://github.com/NamesMT/home-hosted/commit/b9f48ee))

### ✅ Tests

- **proxy:** Write the fake engine to the path the panel would use ([a10588f](https://github.com/NamesMT/home-hosted/commit/a10588f))
- **proxy:** Test expiry by moving the clock, not by backdating the certificate ([3c010cf](https://github.com/NamesMT/home-hosted/commit/3c010cf))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))
- Trung Dang ([@NamesMT](https://github.com/NamesMT))

## v0.7.1

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.0...v0.7.1)

### 🩹 Fixes

- **cli:** Bind the port `--port` asked for ([63f1921](https://github.com/NamesMT/home-hosted/commit/63f1921))

### 🏡 Chore

- **dev:** Keep dev servers and test panels in the 6xxx range ([930f1bf](https://github.com/NamesMT/home-hosted/commit/930f1bf))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.0

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.6.8...v0.7.0)

### 🚀 Enhancements

- **workspaces:** ⚠️  State, settings and servers per workspace ([edb5962](https://github.com/NamesMT/home-hosted/commit/edb5962))
- **ui:** ⚠️  Global-first navigation and root opens Global Overview ([c62bf33](https://github.com/NamesMT/home-hosted/commit/c62bf33))
- **noc-console:** Full workspace support ([ddd6144](https://github.com/NamesMT/home-hosted/commit/ddd6144))

#### ⚠️ Breaking Changes

- **workspaces:** ⚠️  State, settings and servers per workspace ([edb5962](https://github.com/NamesMT/home-hosted/commit/edb5962))
- **ui:** ⚠️  Global-first navigation and root opens Global Overview ([c62bf33](https://github.com/NamesMT/home-hosted/commit/c62bf33))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.6.8

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.6.7...v0.6.8)

### 🚀 Enhancements

- **backups:** Pick what a backup captures, and restore from a dialog ([b8584ca](https://github.com/NamesMT/home-hosted/commit/b8584ca))

### 🩹 Fixes

- **ddns:** Store credentials for an account that is not saved yet ([596506c](https://github.com/NamesMT/home-hosted/commit/596506c))
- **ddns:** One Save for the page, and the hostname caret stays put ([0d45b03](https://github.com/NamesMT/home-hosted/commit/0d45b03))
- **ddns:** Proxying is a per-hostname choice ([b90917c](https://github.com/NamesMT/home-hosted/commit/b90917c))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.6.7

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.6.6...v0.6.7)

### 🚀 Enhancements

- **ddns:** Keep hostnames pointed at this machine's public IP ([a854102](https://github.com/NamesMT/home-hosted/commit/a854102))

### 🩹 Fixes

- **logs:** Stop losing a persistent entry's output ([48995c5](https://github.com/NamesMT/home-hosted/commit/48995c5))

### 📖 Documentation

- Say what start/stop actually touch ([49d3038](https://github.com/NamesMT/home-hosted/commit/49d3038))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.6.6

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.6.5...v0.6.6)

### 🚀 Enhancements

- **cli:** Per-server start/stop, and the version on up/down ([23d59e1](https://github.com/NamesMT/home-hosted/commit/23d59e1))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.6.5

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.6.4...v0.6.5)

### 🩹 Fixes

- **ui:** Stop the server editor aliasing live config ([34676d0](https://github.com/NamesMT/home-hosted/commit/34676d0))

### 📖 Documentation

- **meta:** Sharper npm description and keywords for search ([098595d](https://github.com/NamesMT/home-hosted/commit/098595d))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.6.4

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.6.3...v0.6.4)

### 🚀 Enhancements

- **ui:** Bring noc-console up to date with persistent ([421105b](https://github.com/NamesMT/home-hosted/commit/421105b))

### ❤️ Contributors

- NamesMT

## v0.6.3

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.6.2...v0.6.3)

### 🚀 Enhancements

- **servers:** Keep an entry running through a panel stop, with its logs ([66bda88](https://github.com/NamesMT/home-hosted/commit/66bda88))

### 🩹 Fixes

- **test:** Keep the new suites running on Windows ([7064a80](https://github.com/NamesMT/home-hosted/commit/7064a80))
- **test:** Let the nanny suite clean up on Windows ([0bad678](https://github.com/NamesMT/home-hosted/commit/0bad678))

### 📖 Documentation

- Trim the release and nanny notes in AGENTS.md ([083c2f3](https://github.com/NamesMT/home-hosted/commit/083c2f3))

### 🏡 Chore

- Drop a stray gh cache artifact from the tree ([d23377e](https://github.com/NamesMT/home-hosted/commit/d23377e))

### ✅ Tests

- Measure every source file and cover the HTTP surface ([84f2482](https://github.com/NamesMT/home-hosted/commit/84f2482))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.6.2

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.6.1...v0.6.2)

### 🩹 Fixes

- **ui:** Make an interrupted or overlapping install recoverable ([f08a4b0](https://github.com/NamesMT/home-hosted/commit/f08a4b0))
- **config-watch:** Compare the reported filename by basename ([a556f22](https://github.com/NamesMT/home-hosted/commit/a556f22))

### 📖 Documentation

- Rename the example server to omniroute, and show a compose stack ([5973bd4](https://github.com/NamesMT/home-hosted/commit/5973bd4))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

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

