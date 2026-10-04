import { defineConfig } from "vitest/config";

/* Node >= 25 ships global `localStorage`/`sessionStorage` (undefined without
   --localstorage-file). Vitest's DOM envs only copy window keys the global
   lacks, so Node's shadow happy-dom's and `localStorage.clear()` throws. Turn
   Node's Web Storage off in test workers, only where Node has it (older Node
   rejects the flag). */
const nodeHasWebStorage = "localStorage" in globalThis;

/** Unit tests live next to their package or app (<pkg>/test). E2E is Playwright's job. */
export default defineConfig({
  test: {
    include: [
      "packages/**/test/**/*.test.{ts,tsx}",
      "apps/**/test/**/*.test.{ts,tsx}",
      "scripts/**/test/**/*.test.{ts,tsx}",
    ],
    exclude: ["**/node_modules/**", "e2e/**"],
    poolOptions: {
      forks: {
        execArgv: nodeHasWebStorage ? ["--no-experimental-webstorage"] : [],
      },
    },
  },
});
