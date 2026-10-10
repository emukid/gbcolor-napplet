# GBColor Napplet

Game Boy Color napplet for Tobu Tobu Girl Deluxe. It uses `wasmboy`, builds the
ROM from `https://gitlab.com/soapbox-pub/tobu-xdc`, packages as a single-file
napplet through `@napplet/vite-plugin`, and publishes cartridge RAM saves to
Nostr using NAP-OUTBOX.

## NAP Boundaries

- ROM bytes load through NAP-RESOURCE from ordered ROM event sources. Blossom
  deployments use a hash-verified UTF-8/base64 transport so runtimes with strict
  binary MIME allowlists can deliver it; the napplet then verifies the decoded
  ROM's own SHA-256 and byte count before execution.
- Save discovery, publishing, and deletion use NAP-OUTBOX.
- Save events use kind `30078` with `d` tags like
  `gbcolor-tobu-tobu-girl-deluxe-save0`.
- Save events store cartridge RAM as `wasmboy-core-cartridge-ram-v1`. Loading a
  save reinitializes the active ROM and restores the cartridge RAM through the
  core memory map.
- Full Wasmboy state snapshots are intentionally not loaded. Wasmboy `0.7.1`
  corrupts the GBC video pipeline after direct `core.loadState()` restores in
  this single-file core path, which makes the canvas turn white on the next
  frames.
- Save deletion publishes a NIP-09 kind `5` request targeting the saved event id
  and the addressable coordinate `30078:<pubkey>:<d>`.
- Save lookup filters matching authored deletion events locally, so relays that
  retain deleted event bodies still leave the save list clean.
- ROM metadata is drafted in [nips/NIP-ROM.md](nips/NIP-ROM.md)
  with event kind `32560`.

## Build

```sh
npm install
npm run build
```

The build script clones the Tobu Webxdc source into `.rom-cache/`, checks out
commit `89b7ffa5d9b3945be5ed625ece031a1e373466f6`, and generates an inline ROM
module under `src/generated/`.

To use an existing checkout:

```sh
TOBU_XDC_DIR=/path/to/tobu-xdc npm run build
```

ROM publishing instructions are in
[docs/ROM-BUILD-PUBLISH.md](docs/ROM-BUILD-PUBLISH.md).

To recursively deploy a directory of `.gbc` files as Blossom blobs and kind
`32560` ROM events, run the NIP-46 QR-based deployer with that directory as the
current working directory:

```sh
cd /path/to/rom-collection
node /path/to/gbcolor-napplet/scripts/deploy-roms.mjs
```

To repair already-published raw-ROM Blossom events without local ROM files:

```sh
pnpm deploy:roms -- --migrate-existing
```

## Verify

```sh
npm run typecheck
npm run build
npm run check:bundle
npm run test:conformance
```
