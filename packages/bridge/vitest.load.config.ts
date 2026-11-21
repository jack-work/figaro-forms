import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/load/*.test.ts"], testTimeout: 600_000 },
});
