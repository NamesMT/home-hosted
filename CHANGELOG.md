# Changelog


## v0.7.21

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.20...v0.7.21)

### 🩹 Fixes

- **contracts:** Let serverPatchSchema clear a label with null ([1681a62](https://github.com/NamesMT/home-hosted/commit/1681a62))
- **proxy:** Ask who a pid is before a stop signals it ([907835d](https://github.com/NamesMT/home-hosted/commit/907835d))
- **process:** One liveness predicate, not a second that reads EPERM as gone ([497302c](https://github.com/NamesMT/home-hosted/commit/497302c))
- **logs:** A delete must drop the unflushed batch too ([39b89f3](https://github.com/NamesMT/home-hosted/commit/39b89f3))
- **supervisor:** A removed server's stop must not recreate what removal reclaimed ([7e3d02a](https://github.com/NamesMT/home-hosted/commit/7e3d02a))

### ✅ Tests

- **cli:** Skip the Windows log-permission case instead of returning early ([6a11139](https://github.com/NamesMT/home-hosted/commit/6a11139))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.20

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.19...v0.7.20)

### 🩹 Fixes

- **cli:** Stop trusting a stale run.json when its pid has been recycled ([4463e20](https://github.com/NamesMT/home-hosted/commit/4463e20))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.19

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.18...v0.7.19)

### 🩹 Fixes

- **ui:** The open-server link pointed into a LAN the viewer is not on ([8380a7e](https://github.com/NamesMT/home-hosted/commit/8380a7e))

### ✅ Tests

- **release:** Stop the version guard's test asserting against live repo state ([6a9364a](https://github.com/NamesMT/home-hosted/commit/6a9364a))
- **cli:** Stop four panel boots fighting over hardcoded ports ([1b120f6](https://github.com/NamesMT/home-hosted/commit/1b120f6))
- Close the guards that let real bugs through, and drop what could not fail ([0ae67d8](https://github.com/NamesMT/home-hosted/commit/0ae67d8))
- **host:** Skip the headerless page-size case on Windows instead of passing it ([9f8a30d](https://github.com/NamesMT/home-hosted/commit/9f8a30d))

### ❤️ Contributors

- NamesMT

## v0.7.18

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.17...v0.7.18)

### 🚀 Enhancements

- **stock:** Filter the Logs page to one stream ([6558aa6](https://github.com/NamesMT/home-hosted/commit/6558aa6))
- **stock:** Search the Logs page ([42f4cdb](https://github.com/NamesMT/home-hosted/commit/42f4cdb))
- **cli:** Print the per-server log directory in `status`, and align its labels ([94b8608](https://github.com/NamesMT/home-hosted/commit/94b8608))
- **cli:** Make `logs --follow --json` emit JSON instead of ignoring the flag ([04af855](https://github.com/NamesMT/home-hosted/commit/04af855))
- **servers:** Explain an exit code an operator would have to look up ([70ce2ed](https://github.com/NamesMT/home-hosted/commit/70ce2ed))
- **cli:** Name the process holding the control port, instead of asking about it ([b84eb9c](https://github.com/NamesMT/home-hosted/commit/b84eb9c))
- **cli:** Name the per-server log convention in `status` ([5230401](https://github.com/NamesMT/home-hosted/commit/5230401))
- **cli:** Name the command a typo meant ([669d99f](https://github.com/NamesMT/home-hosted/commit/669d99f))
- **cli:** Name the option a typo meant, with a bound that rejects a shared prefix ([760dbc2](https://github.com/NamesMT/home-hosted/commit/760dbc2))
- **cli:** Tell a never-initialised home apart from a stopped one ([4d31540](https://github.com/NamesMT/home-hosted/commit/4d31540))
- **ddns:** Say at runtime that the built-in sealing key is in use ([1790b19](https://github.com/NamesMT/home-hosted/commit/1790b19))
- **stock:** Say what a destructive confirmation destroys ([bb0c95e](https://github.com/NamesMT/home-hosted/commit/bb0c95e))
- **ui:** Warn about a HEAD body check where the field is set, not only in settings ([153615b](https://github.com/NamesMT/home-hosted/commit/153615b))
- **auth:** Offer the middle trustProxy setting the warning already recommended ([3232d49](https://github.com/NamesMT/home-hosted/commit/3232d49))

### 🔥 Performance

- **proxy:** Memoise the certificate-failure log, read once per route per frame ([358a95d](https://github.com/NamesMT/home-hosted/commit/358a95d))
- **cli:** Import the daemon graph only when `up` actually runs one ([207067a](https://github.com/NamesMT/home-hosted/commit/207067a))
- **api:** Stream a backup download instead of buffering the whole archive ([8e16160](https://github.com/NamesMT/home-hosted/commit/8e16160))

### 🩹 Fixes

- **logs:** Report how many lines a search read, not the window it asked for ([61c4d92](https://github.com/NamesMT/home-hosted/commit/61c4d92))
- **logs:** Widen the window for a stream filter, not only for a search ([a7700ab](https://github.com/NamesMT/home-hosted/commit/a7700ab))
- **logs:** Grow the persistent backfill's window, so it returns the lines it asked for ([5de1365](https://github.com/NamesMT/home-hosted/commit/5de1365))
- **cli:** Name the per-server log directory in `status --json` too ([dc7b14f](https://github.com/NamesMT/home-hosted/commit/dc7b14f))
- **cli:** Stop `logs --lines` answering a count nobody asked for ([4d9cccc](https://github.com/NamesMT/home-hosted/commit/4d9cccc))
- **cli:** Refuse a partly numeric --port instead of listening on its prefix ([55b2ab2](https://github.com/NamesMT/home-hosted/commit/55b2ab2))
- **noc-console:** Clear the searched count when leaving disk mode ([c0210b0](https://github.com/NamesMT/home-hosted/commit/c0210b0))
- **stock:** Clear the searched count when leaving disk mode, like noc-console ([15ae80a](https://github.com/NamesMT/home-hosted/commit/15ae80a))
- **cli:** Say a log is unreadable instead of claiming the panel wrote nothing ([09eb6da](https://github.com/NamesMT/home-hosted/commit/09eb6da))
- **cli:** Make `logs --json` agree with the text form about an unreadable log ([979cbdb](https://github.com/NamesMT/home-hosted/commit/979cbdb))
- **cli:** Report the installed UI in `status --json`, alongside the text row ([a7e3e88](https://github.com/NamesMT/home-hosted/commit/a7e3e88))
- **test:** Compare the predicate guard's paths in POSIX form ([cc280e8](https://github.com/NamesMT/home-hosted/commit/cc280e8))
- **proxy:** Hold a plain-HTTP panel route to the exposure bar ([0cd1536](https://github.com/NamesMT/home-hosted/commit/0cd1536))
- **ddns:** Publish only genuinely public IPv6 addresses ([2f25182](https://github.com/NamesMT/home-hosted/commit/2f25182))
- **api:** Branch on a code, not on an error message ([5feaa1b](https://github.com/NamesMT/home-hosted/commit/5feaa1b))
- **api:** Give WorkspaceError a code, so the route stops matching text ([a33c604](https://github.com/NamesMT/home-hosted/commit/a33c604))
- **history:** Return the events of the window the summary is about ([b59f7dd](https://github.com/NamesMT/home-hosted/commit/b59f7dd))
- **host:** Clamp every percentage, so an estimate cannot silence an alert ([b0fb1be](https://github.com/NamesMT/home-hosted/commit/b0fb1be))
- **host:** Clamp the swap percentage on every platform, not just Linux ([369285c](https://github.com/NamesMT/home-hosted/commit/369285c))
- **identity:** A basename is not an identity, so ownership stops matching strangers ([51f8849](https://github.com/NamesMT/home-hosted/commit/51f8849))
- **release:** Refuse a version semver rejects, and test the release guard ([58ece18](https://github.com/NamesMT/home-hosted/commit/58ece18))
- **release:** Validate the version in release-notes, which a stack trace replaced ([5fc42cb](https://github.com/NamesMT/home-hosted/commit/5fc42cb))
- **log-tail:** One poll reads what the bound promises, not the whole backlog ([6f050e1](https://github.com/NamesMT/home-hosted/commit/6f050e1))
- **test:** Isolate each parser before reading it, which broke on Windows ([68f7b4f](https://github.com/NamesMT/home-hosted/commit/68f7b4f))
- **release:** Split the changelog on any line ending, not just LF ([97789d8](https://github.com/NamesMT/home-hosted/commit/97789d8))
- **ui:** Zero bytes is a size, not an unknown — and cover the branches behind the coverage gate ([15d5ede](https://github.com/NamesMT/home-hosted/commit/15d5ede))
- **api:** Bound the restore upload while it arrives, not after it is buffered ([d03e274](https://github.com/NamesMT/home-hosted/commit/d03e274))
- **api:** Bound the UI upload while it arrives, the same gap the restore route had ([91141a1](https://github.com/NamesMT/home-hosted/commit/91141a1))
- **proxy:** Compare both halves of the ACME credential, as the comment claimed ([ff55527](https://github.com/NamesMT/home-hosted/commit/ff55527))
- **noc-console:** One of five formatters missed the unknown guard, and test the module ([ee08f74](https://github.com/NamesMT/home-hosted/commit/ee08f74))
- **noc-console:** Read the `error` fallback, so both UIs report the same failure ([7323393](https://github.com/NamesMT/home-hosted/commit/7323393))
- **tls:** A certificate is valid only inside its window, not just before it expires ([b6d3a94](https://github.com/NamesMT/home-hosted/commit/b6d3a94))
- **tls:** Never hand the server a pair whose key does not match ([7f36997](https://github.com/NamesMT/home-hosted/commit/7f36997))
- **security:** Compare the local control token without leaking it to timing ([8d9ed3c](https://github.com/NamesMT/home-hosted/commit/8d9ed3c))
- **auth:** Warn that `trustProxy` on an exposed bind makes the lockout advisory ([c80eefb](https://github.com/NamesMT/home-hosted/commit/c80eefb))
- **supervisor:** A removed server takes its log files with it ([b2267e7](https://github.com/NamesMT/home-hosted/commit/b2267e7))
- **supervisor:** Reclaim a removed server's history, the other per-id artifact ([b0ef74c](https://github.com/NamesMT/home-hosted/commit/b0ef74c))
- **ddns:** Confirm a cached Cloudflare zone before using it ([78654a9](https://github.com/NamesMT/home-hosted/commit/78654a9))
- **supervisor:** Drop an environment key containing a null byte instead of letting spawn throw ([dc1ddfa](https://github.com/NamesMT/home-hosted/commit/dc1ddfa))
- **health:** A HEAD probe said nothing about the body check it skipped ([945ae26](https://github.com/NamesMT/home-hosted/commit/945ae26))
- **panel:** Refuse to remove a workspace whose process survived the stop ([607498b](https://github.com/NamesMT/home-hosted/commit/607498b))
- **port:** EPERM means the process is alive, not gone ([90504d7](https://github.com/NamesMT/home-hosted/commit/90504d7))
- **stock:** One description per field, not two that disagree ([b1ac57f](https://github.com/NamesMT/home-hosted/commit/b1ac57f))
- **ui:** The removal confirmation promised logs that removal now deletes ([e5b7ef3](https://github.com/NamesMT/home-hosted/commit/e5b7ef3))
- **stock:** The warning notice named one cause and listed another ([57c4a3a](https://github.com/NamesMT/home-hosted/commit/57c4a3a))
- **api:** The documented error envelope required a field the panel omits ([8ae3943](https://github.com/NamesMT/home-hosted/commit/8ae3943))
- **history:** Uptime kept a whole run that ended before the window opened ([f35e770](https://github.com/NamesMT/home-hosted/commit/f35e770))
- **noc-console:** Prune the per-server map that was never pruned ([e554a3c](https://github.com/NamesMT/home-hosted/commit/e554a3c))
- **proxy:** An unsupported URL scheme became a hostname instead of an error ([bf42828](https://github.com/NamesMT/home-hosted/commit/bf42828))
- **proxy:** A trailing slash made a route match something else ([834a037](https://github.com/NamesMT/home-hosted/commit/834a037))
- **ddns:** A zone the host is not inside wrote to a stranger's domain ([4a72539](https://github.com/NamesMT/home-hosted/commit/4a72539))
- **api:** The two input-rejection paths reported different codes ([264d06d](https://github.com/NamesMT/home-hosted/commit/264d06d))
- **tls:** Clearing the certificate discarded a failed listener rebuild ([dbabb64](https://github.com/NamesMT/home-hosted/commit/dbabb64))
- **supervisor:** Dependencies were started in an order that is not topological ([6c19adf](https://github.com/NamesMT/home-hosted/commit/6c19adf))
- **supervisor:** Stopping a dependency said nothing about what it stranded ([2d922a9](https://github.com/NamesMT/home-hosted/commit/2d922a9))
- **ui:** The `dependsOn` hint lost one of its two facts, in opposite ways per UI ([a963fa9](https://github.com/NamesMT/home-hosted/commit/a963fa9))
- **config:** An unstamped file would skip its migration after a schema bump ([6e2cbd1](https://github.com/NamesMT/home-hosted/commit/6e2cbd1))
- **config:** The last two unstamped-schema readers, and a guard that could not fail ([2fa7b5f](https://github.com/NamesMT/home-hosted/commit/2fa7b5f))
- **migrate:** A gap in the migration chain was stamped over ([184b7e8](https://github.com/NamesMT/home-hosted/commit/184b7e8))
- **patch:** An explicit null cleared a key inside a group but not at the top level ([1f58a5d](https://github.com/NamesMT/home-hosted/commit/1f58a5d))
- **noc-console:** An emptied label removed the entry's name ([ea86404](https://github.com/NamesMT/home-hosted/commit/ea86404))
- **config:** A hand-edited null label refused the whole servers file ([45d689e](https://github.com/NamesMT/home-hosted/commit/45d689e))

### 💅 Refactors

- **ui:** One reverse-proxy form for both UIs, not 40 duplicated declarations ([c4b2c60](https://github.com/NamesMT/home-hosted/commit/c4b2c60))
- **servers:** Describe every exit through one formatter ([6117173](https://github.com/NamesMT/home-hosted/commit/6117173))
- **shared:** One plain-object predicate, in place of nine copies ([f1e9cb0](https://github.com/NamesMT/home-hosted/commit/f1e9cb0))
- **proxy:** One isPublicHost, not two that had already diverged ([218ade2](https://github.com/NamesMT/home-hosted/commit/218ade2))
- One manifest reader, not three that had drifted ([4518dd2](https://github.com/NamesMT/home-hosted/commit/4518dd2))
- **ui:** Share the four formatters both UIs had copied, and guard the ratios ([a8509ba](https://github.com/NamesMT/home-hosted/commit/a8509ba))
- **shared:** One SSE bucket key, not three copies that agreed by luck ([9695938](https://github.com/NamesMT/home-hosted/commit/9695938))
- **shared:** Share the rebind wait, and record why the RPC client does not move ([4c60631](https://github.com/NamesMT/home-hosted/commit/4c60631))
- **ui:** One API client for the calls both UIs copied, done by editing ([fbc8276](https://github.com/NamesMT/home-hosted/commit/fbc8276))
- **state:** Drop a builder the workspaces refactor orphaned, and guard the class ([a61ee9c](https://github.com/NamesMT/home-hosted/commit/a61ee9c))
- **paths:** Remove six path helpers nothing called, and guard the file ([45948c8](https://github.com/NamesMT/home-hosted/commit/45948c8))
- **ui:** Share `formatRatio` too, and document the whole shared surface ([4d83b24](https://github.com/NamesMT/home-hosted/commit/4d83b24))
- **api:** One home for the unknown-server failure, not three ([6e095d1](https://github.com/NamesMT/home-hosted/commit/6e095d1))
- **cli:** One home for each command's description, not two ([7649d9b](https://github.com/NamesMT/home-hosted/commit/7649d9b))
- **api:** Route schemas belong in contracts, and the rule said more than it meant ([c04d1a5](https://github.com/NamesMT/home-hosted/commit/c04d1a5))

### 📖 Documentation

- Say that a successful `npm publish` is the signal, so the poll is not restored ([17f4a17](https://github.com/NamesMT/home-hosted/commit/17f4a17))
- Name the per-server log files, not just their directory ([a7c2c3d](https://github.com/NamesMT/home-hosted/commit/a7c2c3d))
- Record the skip counts and what to watch in them ([df8f0c4](https://github.com/NamesMT/home-hosted/commit/df8f0c4))
- Document the shared proxy form, and correct the alias claim ([dc06ee2](https://github.com/NamesMT/home-hosted/commit/dc06ee2))
- Document the route's `dnsAccount`, which only appeared in an example ([d1209b5](https://github.com/NamesMT/home-hosted/commit/d1209b5))
- Document `logBufferLines`, which no user doc mentioned ([300511f](https://github.com/NamesMT/home-hosted/commit/300511f))
- Record the measured tick cost, so the next round does not re-derive it ([bcbd672](https://github.com/NamesMT/home-hosted/commit/bcbd672))
- Split AGENTS.md into orientation plus .agentDocs/, and add the conciseness rules ([8f1bbec](https://github.com/NamesMT/home-hosted/commit/8f1bbec))
- Restore three facts the AGENTS.md split dropped ([b73e9d3](https://github.com/NamesMT/home-hosted/commit/b73e9d3))
- **agent:** Distill the verification lessons into GOTCHAS ([2e72cce](https://github.com/NamesMT/home-hosted/commit/2e72cce))
- **agent:** Distill the verification lessons into GOTCHAS" ([f1ca207](https://github.com/NamesMT/home-hosted/commit/f1ca207))
- Give a memory-less agent the setup and stack facts ([93ecf50](https://github.com/NamesMT/home-hosted/commit/93ecf50))
- Adopt the working-method rules from the ruleset, adapted ([3d25744](https://github.com/NamesMT/home-hosted/commit/3d25744))
- Let an agent fix the root cause, and drop the setup basics ([da85fc5](https://github.com/NamesMT/home-hosted/commit/da85fc5))
- Record that pnpm-workspace.yaml is load-bearing ([ec5d1f6](https://github.com/NamesMT/home-hosted/commit/ec5d1f6))
- Record the measured startup cost, and what it is not ([14b0833](https://github.com/NamesMT/home-hosted/commit/14b0833))
- **agent:** One canonical AGENTS.md structure, and state the method inline ([0c4839b](https://github.com/NamesMT/home-hosted/commit/0c4839b))
- Take workspace-private context out of the published skeleton ([ddb6499](https://github.com/NamesMT/home-hosted/commit/ddb6499))
- Ship the two user-visible CLI improvements, and check shipped-doc links ([415f7de](https://github.com/NamesMT/home-hosted/commit/415f7de))
- Index all eight scripts, including the two that gate something ([70d0f8f](https://github.com/NamesMT/home-hosted/commit/70d0f8f))
- Record the fraction-bound trap, and how the existing test caught it ([32b58a5](https://github.com/NamesMT/home-hosted/commit/32b58a5))
- Correct a distance I stated without measuring ([f0fb75d](https://github.com/NamesMT/home-hosted/commit/f0fb75d))
- Record the guard-strength distinction, with the measured zero ([47eb982](https://github.com/NamesMT/home-hosted/commit/47eb982))
- Record the CRLF trap that only the platform gate could catch ([eebd47a](https://github.com/NamesMT/home-hosted/commit/eebd47a))
- Record that `cookieSecure: auto` rests on srvx's forwarded-proto handling ([e5fbd2f](https://github.com/NamesMT/home-hosted/commit/e5fbd2f))
- Document the `status --json` field scripts now depend on ([46e946e](https://github.com/NamesMT/home-hosted/commit/46e946e))
- **auth:** The session lifetime is an idle timeout, and the UI said otherwise ([0052250](https://github.com/NamesMT/home-hosted/commit/0052250))
- **readme:** The trustProxy advice named the benefit and not the cost ([44c7899](https://github.com/NamesMT/home-hosted/commit/44c7899))
- The placeholder list was three names short ([a333337](https://github.com/NamesMT/home-hosted/commit/a333337))
- Name `enabled` in the server field reference ([3ea7751](https://github.com/NamesMT/home-hosted/commit/3ea7751))
- List .proxy/ in the README state layout ([454cf2c](https://github.com/NamesMT/home-hosted/commit/454cf2c))
- Three route families the UI contract never named ([31a5a2e](https://github.com/NamesMT/home-hosted/commit/31a5a2e))
- The SSE frame table hid the field that says which workspace ([9573ee9](https://github.com/NamesMT/home-hosted/commit/9573ee9))
- The README still promised an ordering the code only half-keeps ([a1eb4aa](https://github.com/NamesMT/home-hosted/commit/a1eb4aa))

### ✅ Tests

- **nanny:** Name the wait that timed out, and give the Windows gate the cause ([7be13ff](https://github.com/NamesMT/home-hosted/commit/7be13ff))
- **logs:** Pin the tail sizes the Logs page offers, and stop a nanny flake ([765fcd5](https://github.com/NamesMT/home-hosted/commit/765fcd5))
- **noc-console:** Extract and pin the live-config guard, and detach its snapshot ([cf87c70](https://github.com/NamesMT/home-hosted/commit/cf87c70))
- **logs:** Pin a stream filter and a search applied together ([d482278](https://github.com/NamesMT/home-hosted/commit/d482278))
- **nanny:** Wait for the log line instead of racing the flush ([7fee2ba](https://github.com/NamesMT/home-hosted/commit/7fee2ba))
- **noc-console:** Pin the disk-mode stream and search controls ([64de4dc](https://github.com/NamesMT/home-hosted/commit/64de4dc))
- **stock:** Mount the logs view with the tip stubbed, so the filter test runs ([d5d5ec1](https://github.com/NamesMT/home-hosted/commit/d5d5ec1))
- Fix six assertions that could never fail, and guard workspace defaults ([e3871a0](https://github.com/NamesMT/home-hosted/commit/e3871a0))
- **api:** Give the panel schema check a message, like its siblings ([8118b09](https://github.com/NamesMT/home-hosted/commit/8118b09))
- Skip the openssl-dependent tests instead of silently passing them ([8794c48](https://github.com/NamesMT/home-hosted/commit/8794c48))
- **api:** Skip the proxy TLS tests instead of silently passing them ([fa6aa4d](https://github.com/NamesMT/home-hosted/commit/fa6aa4d))
- Finish the openssl skip audit — three more files were silently passing ([379580c](https://github.com/NamesMT/home-hosted/commit/379580c))
- **api:** Pin the assumption that makes the upload guards safe ([7e2d83a](https://github.com/NamesMT/home-hosted/commit/7e2d83a))
- **port:** Cover the two pid shapes `lsof` and `fuser` really emit ([bebce76](https://github.com/NamesMT/home-hosted/commit/bebce76))
- **backups:** Pin the archive-entry allowlist, the restore path's security boundary ([7ad4896](https://github.com/NamesMT/home-hosted/commit/7ad4896))
- **api:** Make two assertions unable to pass on a missing response ([5b3590b](https://github.com/NamesMT/home-hosted/commit/5b3590b))
- **stock:** Cover the log stream's refcount, which nothing exercised ([134f69d](https://github.com/NamesMT/home-hosted/commit/134f69d))
- **archive:** Pin what decides "the password is wrong" ([f99e1ad](https://github.com/NamesMT/home-hosted/commit/f99e1ad))
- **panel:** Pin that notification cooldowns are workspace-scoped ([78dd137](https://github.com/NamesMT/home-hosted/commit/78dd137))
- **ddns:** Cover every provider's credential check, not two of fourteen ([d814038](https://github.com/NamesMT/home-hosted/commit/d814038))
- Pin that .git stays out of the generated list, and the global include route ([2e9d24f](https://github.com/NamesMT/home-hosted/commit/2e9d24f))
- **supervisor:** Pin that an expanded secret never reaches the log ([7302ee0](https://github.com/NamesMT/home-hosted/commit/7302ee0))
- **ui-release:** Pin that a redirect cannot carry the token off GitHub ([d527b6a](https://github.com/NamesMT/home-hosted/commit/d527b6a))
- **backups:** Pin the same-origin target pairing on the restore path ([47a0e3a](https://github.com/NamesMT/home-hosted/commit/47a0e3a))
- **backups:** Pin the single-flight, counted rather than assumed ([a38091f](https://github.com/NamesMT/home-hosted/commit/a38091f))
- One openssl probe, not eleven copies of it ([52e9c8f](https://github.com/NamesMT/home-hosted/commit/52e9c8f))
- Share the ArkType config parser, and leave the rest of the duplication alone ([d523c17](https://github.com/NamesMT/home-hosted/commit/d523c17))
- **config:** Pin that every parsed group is a declared key ([71ceaf7](https://github.com/NamesMT/home-hosted/commit/71ceaf7))
- Drop the padding I added while chasing a coverage number ([0630942](https://github.com/NamesMT/home-hosted/commit/0630942))
- Drop a loop that re-asserted bounds its own equalities already pin ([34e65ec](https://github.com/NamesMT/home-hosted/commit/34e65ec))
- **cli:** Pin that `status --json` never prints the run.json token ([9f53103](https://github.com/NamesMT/home-hosted/commit/9f53103))
- **auth:** Pin that the boot password stops being served once replaced ([ba77157](https://github.com/NamesMT/home-hosted/commit/ba77157))
- **exposure:** Cover the default-password refusal, which no call ever took ([bf78e54](https://github.com/NamesMT/home-hosted/commit/bf78e54))
- **providers:** Cover the two pure helpers on the spawn path ([afc8645](https://github.com/NamesMT/home-hosted/commit/afc8645))
- **cli:** Cover the `restart --workspace` refusal, which had no test ([3b04eeb](https://github.com/NamesMT/home-hosted/commit/3b04eeb))
- **cli:** Pin that `migrate --dry-run` writes nothing ([8a85544](https://github.com/NamesMT/home-hosted/commit/8a85544))
- **shared:** Cover the API client that moved, which the coverage gate caught ([f056490](https://github.com/NamesMT/home-hosted/commit/f056490))
- **shared:** Cover the last uncovered paths, so the area floor has room again ([3a55f3a](https://github.com/NamesMT/home-hosted/commit/3a55f3a))
- **events:** Cover the SSE fan-out, and drop a getter nothing has ever read ([520643a](https://github.com/NamesMT/home-hosted/commit/520643a))
- **nanny:** Pin the trap-before-spawn ordering, and record why `pending` cannot fire ([4f7e80e](https://github.com/NamesMT/home-hosted/commit/4f7e80e))
- **template:** Pin why a substituted value cannot rewrite the template ([1f8f3eb](https://github.com/NamesMT/home-hosted/commit/1f8f3eb))
- **logs:** Pin that a log search ignores case ([ca2d3ce](https://github.com/NamesMT/home-hosted/commit/ca2d3ce))
- **api:** The fixture built server views the contract rejects ([b1709b7](https://github.com/NamesMT/home-hosted/commit/b1709b7))
- **api:** Validate the /healthz body against the schema it publishes ([d71ed72](https://github.com/NamesMT/home-hosted/commit/d71ed72))
- Drop two assertions that could not fail ([2163db3](https://github.com/NamesMT/home-hosted/commit/2163db3))
- **proxy:** Pin the hostname-coverage rule that decides what a route serves ([113ca04](https://github.com/NamesMT/home-hosted/commit/113ca04))
- **auth:** Pin the trustProxy round trip the feature could regress on ([bd4b87c](https://github.com/NamesMT/home-hosted/commit/bd4b87c))
- **config:** Cover the field whose null is a value, not a removal ([5acca69](https://github.com/NamesMT/home-hosted/commit/5acca69))

### 🤖 CI

- Stop waiting five minutes for npm to show a package it accepted ([0aa6b4b](https://github.com/NamesMT/home-hosted/commit/0aa6b4b))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.17

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.16...v0.7.17)

### 🩹 Fixes

- **logs:** Honour a tail larger than one read chunk ([751caaf](https://github.com/NamesMT/home-hosted/commit/751caaf))

### ✅ Tests

- **logs:** Pin the search-window symptom of the truncation ([5b95b26](https://github.com/NamesMT/home-hosted/commit/5b95b26))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.16

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.15...v0.7.16)

### 🔥 Performance

- **cli:** Read only the tail `logs` needs, not both whole files ([7351b20](https://github.com/NamesMT/home-hosted/commit/7351b20))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.15

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.13...v0.7.15)

### 🔥 Performance

- **host:** Cache the swap reading, which cost a process spawn per sample ([1f9fdc8](https://github.com/NamesMT/home-hosted/commit/1f9fdc8))

### 🩹 Fixes

- **cli:** `logs --follow` was eating blank lines ([e2adb02](https://github.com/NamesMT/home-hosted/commit/e2adb02))

### 💅 Refactors

- **host:** Drop resetSwapCache, which nothing calls ([497ee17](https://github.com/NamesMT/home-hosted/commit/497ee17))

### 🏡 Chore

- **release:** V0.7.14 ([b9d4d19](https://github.com/NamesMT/home-hosted/commit/b9d4d19))

### ✅ Tests

- **host-monitor:** Detect a re-sample by identity, not by a wall clock ([55c5917](https://github.com/NamesMT/home-hosted/commit/55c5917))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.14

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.13...v0.7.14)

### 🔥 Performance

- **host:** Cache the swap reading, which cost a process spawn per sample ([1f9fdc8](https://github.com/NamesMT/home-hosted/commit/1f9fdc8))

### ✅ Tests

- **host-monitor:** Detect a re-sample by identity, not by a wall clock ([55c5917](https://github.com/NamesMT/home-hosted/commit/55c5917))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.13

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.12...v0.7.13)

### 🚀 Enhancements

- **cli:** Add `restart <id>`, so the shell can restart one server ([b8c3fc6](https://github.com/NamesMT/home-hosted/commit/b8c3fc6))

### 🩹 Fixes

- **host:** Read macOS available memory the way macOS defines it ([9841aaa](https://github.com/NamesMT/home-hosted/commit/9841aaa))

### ✅ Tests

- **cli:** Cover the published bin, and the cwd condition that hid a broken import ([116e90f](https://github.com/NamesMT/home-hosted/commit/116e90f))
- **cli:** Pass the tsx loader as a file URL, so the new bin test runs on Windows ([16e1e7c](https://github.com/NamesMT/home-hosted/commit/16e1e7c))
- **cli:** Cover the interactive half of io.ts, which was 42.5% ([deb713b](https://github.com/NamesMT/home-hosted/commit/deb713b))
- **host:** Reach the swap and memory alerts, which nothing crossed ([b6ba75f](https://github.com/NamesMT/home-hosted/commit/b6ba75f))
- **host:** Scope each alert assertion to its own alert kind ([76ee4cc](https://github.com/NamesMT/home-hosted/commit/76ee4cc))
- **cli:** Stop the bare-restart test from detaching a daemon ([4131a0e](https://github.com/NamesMT/home-hosted/commit/4131a0e))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.12

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.11...v0.7.12)

### 🚀 Enhancements

- **cli:** Add `home-hosted logs`, so the panel's own output is reachable ([2d1979a](https://github.com/NamesMT/home-hosted/commit/2d1979a))

### 🩹 Fixes

- **noc-console:** An emptied number box no longer refuses the whole save ([085e620](https://github.com/NamesMT/home-hosted/commit/085e620))
- **noc-console:** Repair the DDNS draft too, which the last pass missed ([218ecca](https://github.com/NamesMT/home-hosted/commit/218ecca))
- **panel:** Publish a frame when the served UI changes ([ad34ba3](https://github.com/NamesMT/home-hosted/commit/ad34ba3))
- **cli:** Resolve the two directory imports, so `up` works from any directory ([17a61a2](https://github.com/NamesMT/home-hosted/commit/17a61a2))

### 💅 Refactors

- **proxy:** One place that posts a configuration, so a refusal is always recorded ([48a1454](https://github.com/NamesMT/home-hosted/commit/48a1454))
- **ui:** Drop five helpers nothing calls ([a1c3936](https://github.com/NamesMT/home-hosted/commit/a1c3936))

### 📖 Documentation

- Say which workflow runs when, and why the platform gate is not per-push ([3f3cba5](https://github.com/NamesMT/home-hosted/commit/3f3cba5))

### ✅ Tests

- **proc:** Make the CPU-sample flake say what went wrong, and stop it flaking ([2144cfa](https://github.com/NamesMT/home-hosted/commit/2144cfa))

### 🤖 CI

- Bound every job, so a stalled runner is reported instead of parked ([4d130e4](https://github.com/NamesMT/home-hosted/commit/4d130e4))

### ❤️ Contributors

- NamesMT

## v0.7.11

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.10...v0.7.11)

### 🩹 Fixes

- **noc-console:** An emptied proxy port is not a string ([6accea6](https://github.com/NamesMT/home-hosted/commit/6accea6))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.10

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.9...v0.7.10)

### 🩹 Fixes

- **noc-console:** Carry the route-edit guard and the tail race fix into the other UI ([e34a30c](https://github.com/NamesMT/home-hosted/commit/e34a30c))

### ✅ Tests

- Resolve `@/…` from the UI that asks, so every UI's own tests can mount a component ([6738cbd](https://github.com/NamesMT/home-hosted/commit/6738cbd))
- **noc-console:** Pin the log-tail race, and record the alias rule in AGENTS.md ([7f0b189](https://github.com/NamesMT/home-hosted/commit/7f0b189))

### ❤️ Contributors

- NamesMT

## v0.7.9

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.7...v0.7.9)

### 🩹 Fixes

- **api:** Declare the stored entry POST/PATCH really return, not a view ([abce4b4](https://github.com/NamesMT/home-hosted/commit/abce4b4))
- **metrics:** Escape a label value, so a Windows disk path does not break the scrape ([26fce4f](https://github.com/NamesMT/home-hosted/commit/26fce4f))
- **identity:** Read a Windows-escaped quote as a literal, not a delimiter ([57e8047](https://github.com/NamesMT/home-hosted/commit/57e8047))
- **ui:** Name every toggle switch, and stop three ways a live view showed stale state ([ada0c58](https://github.com/NamesMT/home-hosted/commit/ada0c58))
- **ui:** Show the panel's reason when an uploaded restore fails ([9056e85](https://github.com/NamesMT/home-hosted/commit/9056e85))
- **ui:** Confirm destructive actions in a popover, and keep a route edit through a live frame ([c8ad4b6](https://github.com/NamesMT/home-hosted/commit/c8ad4b6))
- **ui:** A cleared required number no longer refuses the whole save ([06b50ae](https://github.com/NamesMT/home-hosted/commit/06b50ae))
- **ui:** Confirm forgetting DDNS credentials in a popover ([a455ed9](https://github.com/NamesMT/home-hosted/commit/a455ed9))
- **noc-console:** Confirm destructive actions in a sheet, not by arming the button ([33250e3](https://github.com/NamesMT/home-hosted/commit/33250e3))
- **ui:** Keep auto-following the log once the buffer reaches its cap ([01b5dbb](https://github.com/NamesMT/home-hosted/commit/01b5dbb))
- **ui:** Resetting one control group no longer discards an edit in another ([9d86b51](https://github.com/NamesMT/home-hosted/commit/9d86b51))

### 🏡 Chore

- **release:** V0.7.8 ([a793852](https://github.com/NamesMT/home-hosted/commit/a793852))

### ✅ Tests

- **cli:** Pin the colour seam every command prints through ([33ccad9](https://github.com/NamesMT/home-hosted/commit/33ccad9))
- Stop two intermittent full-suite failures, and make them say why ([5cbafdf](https://github.com/NamesMT/home-hosted/commit/5cbafdf))
- **config:** Cover the dependency validation that reports cycles and dangling ids ([43e2485](https://github.com/NamesMT/home-hosted/commit/43e2485))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.8

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.7...v0.7.8)

### 🩹 Fixes

- **api:** Declare the stored entry POST/PATCH really return, not a view ([abce4b4](https://github.com/NamesMT/home-hosted/commit/abce4b4))
- **metrics:** Escape a label value, so a Windows disk path does not break the scrape ([26fce4f](https://github.com/NamesMT/home-hosted/commit/26fce4f))
- **identity:** Read a Windows-escaped quote as a literal, not a delimiter ([57e8047](https://github.com/NamesMT/home-hosted/commit/57e8047))
- **ui:** Name every toggle switch, and stop three ways a live view showed stale state ([ada0c58](https://github.com/NamesMT/home-hosted/commit/ada0c58))
- **ui:** Show the panel's reason when an uploaded restore fails ([9056e85](https://github.com/NamesMT/home-hosted/commit/9056e85))
- **ui:** Confirm destructive actions in a popover, and keep a route edit through a live frame ([c8ad4b6](https://github.com/NamesMT/home-hosted/commit/c8ad4b6))
- **ui:** A cleared required number no longer refuses the whole save ([06b50ae](https://github.com/NamesMT/home-hosted/commit/06b50ae))

### ✅ Tests

- **cli:** Pin the colour seam every command prints through ([33ccad9](https://github.com/NamesMT/home-hosted/commit/33ccad9))
- Stop two intermittent full-suite failures, and make them say why ([5cbafdf](https://github.com/NamesMT/home-hosted/commit/5cbafdf))
- **config:** Cover the dependency validation that reports cycles and dangling ids ([43e2485](https://github.com/NamesMT/home-hosted/commit/43e2485))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

## v0.7.7

[compare changes](https://github.com/NamesMT/home-hosted/compare/v0.7.6...v0.7.7)

### 🩹 Fixes

- **api:** Turning authentication off could leave the panel exposed through the proxy ([81cd870](https://github.com/NamesMT/home-hosted/commit/81cd870))
- **api:** Clearing the password could leave the panel exposed through the proxy ([fd06627](https://github.com/NamesMT/home-hosted/commit/fd06627))

### ❤️ Contributors

- NamesMT ([@NamesMT](https://github.com/NamesMT))

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

