import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    // The first run downloads a MongoDB binary.
    hookTimeout: 180_000,
  },
});
