import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const distDir = resolve(__dirname, "../dist");

export default defineConfig({
  resolve: {
    alias: [
      { find: "@shared", replacement: resolve(__dirname, "src/shared") },
      // Main-process modules import electron; stub it so their pure logic is
      // testable under plain Node.
      { find: /^electron$/, replacement: resolve(__dirname, "test/stubs/electron.ts") },
      // Same mapping electron.vite.config.ts uses: the app consumes the built
      // library from dist/, not a node_modules package. Run `npm run build` in
      // the repo root before `npm --prefix app test`.
      { find: /^deskrag$/, replacement: resolve(distDir, "index.js") },
      { find: /^deskrag\//, replacement: `${distDir}/` },
    ],
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
