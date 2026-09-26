import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

/**
 * e2e/ac-28-sessions.spec.ts spawns a second vite dev server while sibling
 * specs run theirs in parallel; vite's dep-optimizer cache lives in
 * node_modules/.vite by default — shared between both servers — and parallel
 * re-optimizes make the first page load stall past the test timeout. This
 * wrapper only relocates the cache.
 */
export default mergeConfig(
  base,
  defineConfig({ cacheDir: "node_modules/.vite-ac28" }),
);
