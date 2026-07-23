import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// The DeskRAG library is consumed from its built output. Two aliases so both the
// barrel (`deskrag`) and subpath native adapters (`deskrag/capture/producers/...`)
// resolve into ../dist. Native npm modules are externalized so Electron loads
// them at runtime (resolved from the hoisted root node_modules) rather than
// bundling them.
const distDir = resolve(__dirname, "../dist");

const nativeExternals = [
  "better-sqlite3",
  "@lancedb/lancedb",
  "sharp",
  "active-win",
  "uiohook-napi",
];

const sharedAlias = { find: /^@shared\//, replacement: `${resolve(__dirname, "src/shared")}/` };
const deskragAliases = [
  { find: /^deskrag$/, replacement: resolve(distDir, "index.js") },
  { find: /^deskrag\//, replacement: `${distDir}/` },
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: [sharedAlias, ...deskragAliases],
    },
    build: {
      rollupOptions: { external: nativeExternals },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: [sharedAlias],
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
  },
});
