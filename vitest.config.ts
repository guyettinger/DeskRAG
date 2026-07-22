import { defineConfig } from "vitest/config";

export default defineConfig({
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
