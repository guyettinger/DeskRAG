import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // `app/src/main/graph-view.ts` is a pure projection and belongs in the
      // suite, but it is written against the app's module names. Aliasing them
      // here is cheaper than duplicating the DTOs into `src/`.
      "@shared": here("./app/src/shared"),
      deskrag: here("./src/index.ts"),
    },
  },
  test: {
    // Native modules (better-sqlite3) + LanceDB and process-kill tests are not
    // safe to run concurrently across worker threads sharing temp dirs; each
    // test file gets its own tmp dir but we keep the pool single-forked to avoid
    // native-addon reload churn.
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});
