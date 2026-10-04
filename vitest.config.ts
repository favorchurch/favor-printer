import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts", "app/**/*.test.ts"],
    environment: "node",
  },
});
