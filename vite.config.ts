import { defineConfig } from "vite";
import { nip5aManifest } from "@napplet/vite-plugin";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    modulePreload: false,
  },
  server: {
    port: 5193,
    cors: true,
  },
  plugins: [
    nip5aManifest({
      nappletType: "gbcolor",
      artifactMode: "single-file",
      requires: ["identity", "outbox", "resource", "keys", "relay"],
    }),
  ],
});
