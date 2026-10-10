import { defineConfig } from "vite";
import { nip5aManifest } from "@napplet/vite-plugin";
import { coreSnapshot } from "./build/core-snapshot.js";

export default defineConfig({
  base: "./",
  optimizeDeps: { exclude: ['wasmboy/dist/core/core.esm.js'] },
  build: {
    outDir: "dist",
    modulePreload: false,
  },
  server: {
    port: 5193,
    cors: true,
  },
  plugins: [
    coreSnapshot(),
    nip5aManifest({
      nappletType: "gbcolor",
      artifactMode: "single-file",
      archetypes: ["load", "open", "browse", "settings", "pause", "resume", "sound", "maximize"].map(action => ({ slug: "gameboy", convention: `napplet:gameboy/${action}` })),
      requires: ["identity", "outbox", "resource", "relay"],
    }),
  ],
});
