import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

/**
 * e2e/ac-28-sessions.spec.ts spawns a second vite dev server while sibling
 * specs run theirs in parallel; vite's dep-optimizer cache lives in
 * node_modules/.vite by default — shared between both servers — and parallel
 * re-optimizes make the first page load stall past the test timeout. This
 * wrapper only relocates the cache. --workers>1 gives each worker its own
 * cache dir via LILOS_VITE_CACHE_DIR so a cold-cache rmSync can't make a
 * sibling worker's vite re-optimize mid-navigation (#84).
 */
export default mergeConfig(
  base,
  defineConfig({
    cacheDir: process.env.LILOS_VITE_CACHE_DIR ?? "node_modules/.vite-ac28",
  }),
);
