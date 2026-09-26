import { defineConfig } from "vitest/config";

/** Unit tests live next to their package or app (<pkg>/test). E2E is Playwright's job. */
export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
