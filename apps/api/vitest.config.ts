import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Run test files sequentially to avoid test pollution from process.env
    // modifications and vi.resetModules() not fully isolating modules
    fileParallelism: false,
    // Increase timeout for tests that may take longer in CI
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
