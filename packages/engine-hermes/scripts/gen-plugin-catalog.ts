/**
 * Renders the `lilos` Hermes plugin's shipped tool catalog
 * (`plugin/lilos/catalog.json`) from the contract's `toolListAll` (#411).
 * `register()` reads this snapshot instead of fetching `GET /tools`, so
 * plugin load can never block on the gateway. Generating from the SAME
 * tool list the surfaces gateway answers with keeps the snapshot
 * byte-identical to the live endpoint — no hand-written list in Python.
 * The generator lives in the engine package (not contracts/scripts) so the
 * shared seam still carries no vendor names.
 *
 *   bun packages/engine-hermes/scripts/gen-plugin-catalog.ts          write
 *   bun packages/engine-hermes/scripts/gen-plugin-catalog.ts --check  exit 1 when stale
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toolListAll } from "@lilos/contracts/harness";

const CATALOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "lilos",
  "catalog.json",
);

const render = () => `${JSON.stringify({ tools: toolListAll() }, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if (
    !existsSync(CATALOG_PATH) ||
    readFileSync(CATALOG_PATH, "utf8") !== render()
  ) {
    console.error(
      "stale: engine-hermes/plugin/lilos/catalog.json — run bun run schema:gen",
    );
    process.exit(1);
  }
  console.log("catalog: plugin/lilos/catalog.json is fresh");
} else {
  writeFileSync(CATALOG_PATH, render());
  console.log("wrote engine-hermes/plugin/lilos/catalog.json");
}
