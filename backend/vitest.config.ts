import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share ONE database and truncate it between tests: files must not run in parallel.
    fileParallelism: false,
    pool: "forks",
  },
});
