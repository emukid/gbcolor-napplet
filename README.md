<div align="center">

# GBColor

**Game Boy and Game Boy Color emulation in a single-file napplet.**

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![WasmBoy](https://img.shields.io/badge/WasmBoy-0.7.1-555555?style=for-the-badge)

</div>

GBColor runs ROMs in a sandboxed napplet runtime using WasmBoy's JavaScript
core. Browse cartridges published on Nostr or load a local ROM, capture an
exact-moment save, and resume it later. The runtime handles Nostr, filesystem
access, and preferences through the napplet SDK.

## Quick start

Use Node.js **22.12 or newer** and **pnpm**.

```sh
git clone https://github.com/emukid/gbcolor-napplet.git
cd gbcolor-napplet
pnpm install
pnpm paja
```

Open the **Runtime URL** printed by Paja, normally `http://127.0.0.1:5197/`.
The command also starts Vite on port `5193`. Use the Paja URL for the working
napplet preview; the Vite server alone does not provide runtime capabilities.

Choose **Load ROM** to open a `.gb` or `.gbc` file, or select a cartridge from
**Games**. Files can also be dragged into the napplet.

## Settings

Open **Settings** from the bottom toolbar. Sound, cartridge size, and library
scope share the same preferences as their controls elsewhere in the app.
**Load last used ROM on startup** defaults to on; turn it off to start in the
library. Startup checks the remembered game and filesystem cache before any
library search. Startup reads only the requested ROM’s cache record; full cache
discovery waits until Mine is opened. Filesystem limits are reused, larger
permitted chunks reduce calls, and filesystem/key-registration requests are
spaced at least 300 ms apart. After a successful restore, library discovery waits until you
open Games. **Cache loaded ROMs to filesystem** defaults to off. When enabled,
loaded ROMs are copied to their NAP-FS folders and appear in Mine. Loading from
any library scope checks cached copies first, verifies their contents, and
falls back to the published source if the copy is missing or invalid. All settings
are remembered per user through NAP-STORAGE when available.

## Playing

- **Cartridge library:** Mine shows your uploads and filesystem ROMs; Network includes followed
  authors; Global also queries the runtime's relay connection. Global is the
  default. Repeated uploads with the same author and ROM hash appear once;
  titles with multiple versions open a selection dialog. Check **Remember my
  selection** to skip the chooser next time; use **ⓘ → Choose version** to change
  it. The checkbox starts unchecked. Choose Small, Medium, or Large to
  resize cartridges; your selection is remembered with NAP-STORAGE.
- **Cartridge details:** choose **ⓘ** to see full filenames, sizes, upload dates,
  hashes, event IDs, and sources. Options are grouped by author, newest first
  within each group, with Load ROM, Like, and Save ROM actions always shown.
  **← Cartridges** or Escape returns to the grid.
- **Loading:** selecting a ROM switches immediately to the console, with a
  spinner and ROM name on the screen. **Cancel** or Escape
  abandons the pending load without replacing the current game.
- **Screen:** hover over the screen to reveal **⛶** at its bottom-right corner
  and maximize the display. The control also appears on keyboard focus and
  stays visible on touch devices.
  The inward-corners icon restores the console from the same corner on hover
  or focus (always visible on touch). Escape also exits. Keyboard controls keep
  working while maximized.
- **Reactions:** hover over a cartridge to reveal its heart and reaction count.
  Hearts also work with keyboard focus and touch, and remain visible in the
  console. Clicking publishes a positive reaction to the ROM event. Both views
  share the reaction state.

### Controls

| Action | Keyboard |
| --- | --- |
| Directional pad | Arrow keys |
| A | X |
| B | Z |
| Start | Enter |
| Select | Shift |
| Exit maximized view / cancel ROM loading | Escape |

The console also provides on-screen buttons, Pause, Sound, and Save File.
Local keyboard controls work without NAP-KEYS; that optional capability lets the
runtime coordinate shortcuts.

### Keep ROMs in your filesystem

Hover over a cartridge and choose **↓ Save ROM to filesystem**. The action is
also available through keyboard focus and stays visible on touch screens.
A checkmark indicates a saved copy. This action requires the optional NAP-FS capability; the ROM is copied through
the runtime, without a browser download.

Saved ROMs appear in **Mine**, including after reopening the napplet, and load
directly from the filesystem. Files are grouped by the decoded ROM's SHA-256
under a runtime-provided writable root:

```text
gbcolor/
└── roms/
    └── <ROM SHA-256>/
        ├── saves/          Named emulator snapshots
        ├── metadata.json   Title, size, hash, and original event reference
        └── rom.gbc         Cartridge bytes (rom.gb for monochrome ROMs)
```

The catalog record is written after the ROM completes. Loading a saved copy
verifies its size and hash. Existing snapshots in the previous root location
remain discoverable; new snapshots go in the ROM's `saves/` directory.

### Saves

Open **Save File** while a game is running. **Load** restores the save immediately
when there is only one; with multiple saves, choose from the list. Successful
loading closes the dialog. Errors leave it open so you can retry.

| Destination | Behavior |
| --- | --- |
| **Filesystem** | Available with NAP-FS. **New save** creates a separate `.gbcsave` snapshot. Each listed save has Load and Rename actions. Rename opens a name field with Rename and Cancel buttons. |
| **Nostr saves** | Publishes saves through your connected Nostr account. The save list supports loading and publishing deletion requests. This is the default destination when NAP-FS is unavailable. |

New saves capture emulator state, including games without cartridge save RAM.
Older cartridge-RAM saves remain loadable as in-game progress. Snapshots contain
a ROM hash and payload checksum to reject mismatched or corrupted saves.
Filesystem saves use the runtime's workspace; they do not use native file
pickers or browser downloads. A filesystem error does not silently publish to
Nostr instead.

### Preferences and startup

Optional **NAP-STORAGE** remembers Sound, the selected cartridge scope, and the
last successfully loaded game separately for each user. Sound defaults to off;
restored audio starts after a game-control gesture.

On startup, GBColor reopens the remembered game when its ROM is still available.
If the startup game has saves, it asks **“Load your latest save?”** with **Yes**,
**No**, and **Browse saves**. Saves are never silently restored. Filesystem
recency uses runtime modification timestamps; Nostr uses event timestamps.

Local ROM imports must be selected again after a reload unless saved to the
filesystem. Missing storage or an
unavailable remembered ROM does not block playing another game.

## Build and verify

```sh
pnpm build
```

The finished napplet is **`dist/index.html`**, with JavaScript and CSS inlined.
`dist/.nip5a-manifest.json` contains generated manifest metadata. Vite may print
intermediate asset sizes during the build; the final HTML is self-contained.
The normal build does not download or bundle a game ROM.

Install Chromium for browser-based verification:

```sh
pnpm exec playwright install chromium
pnpm verify
pnpm test
pnpm test:conformance
```

| Command | Checks |
| --- | --- |
| `pnpm verify` | Type checking, production build, bundle boundaries, playback, ROM parsing and deduplication, preferences, startup restore, snapshots, and a sandboxed NAP-FS save/load round trip. |
| `pnpm test` | Browser UI checks, responsive layouts, input controls, loading cancellation, reactions, maximization, and save flows. |
| `pnpm test:conformance` | Builds the artifact and runs the napplet conformance checker. Review skipped checks as well as failures. |
| `pnpm test:deploy-roms` | Tests the separate ROM publishing tool. |

## Runtime capabilities

The manifest requires **identity**, **outbox**, **resource**, and **relay**.
NAP-FS is optional: runtimes without it hide ROM download actions, filesystem save
locations, and the cache setting. ROM playback and Nostr saves remain available.
Optional capabilities enhance the UI without becoming startup requirements.

| NAP | Used for |
| --- | --- |
| IDENTITY | Current user and followed authors. |
| OUTBOX | ROM discovery and Nostr save queries, publication, and deletion requests. |
| RESOURCE | ROM bytes from ordered sources, with hash and size verification. |
| RELAY | Global cartridge discovery through the runtime's relay connection. |
| FS *(optional)* | ROM library directories, saved ROMs, and listing, reading, writing, and renaming snapshots. |
| STORAGE *(optional)* | Per-user preferences and the last game reference. |
| KEYS *(optional)* | Runtime shortcut registration. |
| THEME *(optional)* | Runtime colors. |
| COMMON *(optional)* | Publishing ROM reactions. Requires a signed-in user. |
| COUNT *(optional)* | Reaction counts; unavailable counts display a dash. |

ROM records use kind `32560`; saves use kind `30078`; save deletion requests use
kind `5`. The ROM format is documented in the local [NIP-ROM draft](nips/NIP-ROM.md).
Runtime access goes through `@napplet/sdk`, inside a `sandbox="allow-scripts"`
iframe.

## Project layout

```text
.napplet/                   Deployment configuration
build/                      Build-time snapshot adapter
docs/                      ROM build and publishing guide
nips/                       ROM event format draft
scripts/                    Build, publishing, and verification tools
src/                        Emulator UI, ROM sources, and snapshot runtime
README.md
index.html                  Napplet markup
package.json                Dependencies and commands
pnpm-lock.yaml
tsconfig.json
vite.config.ts              Single-file build and required capabilities
```

The pinned WasmBoy 0.7.1 JavaScript core needs a snapshot adapter to preserve
registers that its built-in byte-based state API truncates. The adapter captures
scalar registers and writable memory, excluding the ROM. Review snapshot
compatibility and run the save tests before upgrading the emulator core.

## ROM publishing and further reading

| Resource | Purpose |
| --- | --- |
| [ROM build and publishing guide](docs/ROM-BUILD-PUBLISH.md) | Optional Tobu ROM preparation, collection deployment, migration, and event verification. |
| [NIP-ROM draft](nips/NIP-ROM.md) | ROM metadata, sources, hashes, and event tags. |
| [ROM deployer](scripts/deploy-roms.mjs) | Separate operator tool using NIP-46 signing and Blossom uploads. Run with `--help` for current options. |
| [Snapshot adapter](build/core-snapshot.js) | Build-time integration for exact-moment saves. |

`pnpm build:rom` is the separate, optional Tobu preparation utility. ROM
publication is an operator action; the napplet itself does not publish ROMs.

## Contributing

Include reproduction steps, runtime details, and viewport dimensions for UI
issues. For emulator or save changes, include a regression test and run
`pnpm verify`; run `pnpm test` for UI changes. Avoid committing ROM files,
signing secrets, or local build caches.

## Load a ROM from another napplet

This napplet handles `napplet:gameboy/load?naddr=<naddr>`, where `naddr` points
to a kind 32560 ROM event. The manifest advertises the queryless
`napplet:gameboy/load` convention. Shells deliver `{ "naddr": "naddr1…" }`
on that NAP-INC topic, including when opening a new instance.

With the installed SDK, dispatch using:

```ts
await intent.invoke({
  archetype: 'gameboy',
  action: 'load',
  convention: 'napplet:gameboy/load',
  payload: { naddr },
});
```

The requested ROM takes precedence over startup restoration and library discovery.
Its address is resolved through NAP-OUTBOX (including relay hints), then loaded
through the normal verified cache/resource path. Invalid or unavailable ROMs
show an error. Runtimes without NAP-INC retain the normal manual loading flow.

### Other gameboy intents

| URI | Effect |
| --- | --- |
| `napplet:gameboy/open` | Show the console. |
| `napplet:gameboy/browse?scope=mine` | Show cartridges; optional scope is `mine`, `network`, or `global`. |
| `napplet:gameboy/settings` | Open Settings. |
| `napplet:gameboy/pause` | Pause the current game (repeated calls stay paused). |
| `napplet:gameboy/resume` | Resume the current game. |
| `napplet:gameboy/sound?enabled=false` | Set Sound on/off and remember it. |
| `napplet:gameboy/maximize` | Maximize the screen. Use `?enabled=false` to restore the console. |

Dispatch through `intent.invoke` with the corresponding action and queryless
convention, passing query parameters as payload fields. Boolean options accept
booleans or the strings `"true"` / `"false"`. Commands received during startup
wait until initialization and any requested ROM load finish. Playback commands
report an error if no ROM is loaded. Opening the console does not restart the game.
