# Changelog


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

