import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "research/**", ".wrangler/**"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ["verbose"],
  },
});
