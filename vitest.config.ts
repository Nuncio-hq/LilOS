import { defineConfig } from "vitest/config";

/* Node >= 25 ships global `localStorage`/`sessionStorage` (undefined without
   --localstorage-file). Vitest's DOM envs only copy window keys the global
   lacks, so Node's shadow happy-dom's and `localStorage.clear()` throws. Turn
   Node's Web Storage off in test workers, only where Node has it (older Node
   rejects the flag). */
const nodeHasWebStorage = "localStorage" in globalThis;

/** Unit tests live next to their package or app (<pkg>/test). E2E is Playwright's job.
 *
 * D-#3 tooling: Biome lints/formats, Vitest runs unit tests, Playwright runs
 * E2E + screenshots — all behind one `bun run verify` (root package.json).
 * Not: ESLint + Prettier, or per-package ad-hoc scripts.
 * D-#3 engines: CI runs on `engine-fake` and never calls a real LLM. A local
 * verify of engine work uses a real LLM through Hermes (HPC
 * `qwen3.8-flash-next` locally, `openai-codex` in the cloud) and the hand-off
 * says which one ran; if both fail, tell Oscar. Not: a real LLM in CI, or
 * silently falling back to the fake. */
export default defineConfig({
  test: {
    include: [
      "packages/**/test/**/*.test.{ts,tsx}",
      "apps/**/test/**/*.test.{ts,tsx}",
      "scripts/**/test/**/*.test.{ts,tsx}",
    ],
    exclude: ["**/node_modules/**", "e2e/**"],
    // vitest 4 moved poolOptions.* to top-level test options
    execArgv: nodeHasWebStorage ? ["--no-experimental-webstorage"] : [],
  },
});
