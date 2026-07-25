import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      // Main-process modules import electron; stub it so their pure logic is
      // testable under plain Node.
      electron: resolve(__dirname, "test/stubs/electron.ts"),
    },
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
