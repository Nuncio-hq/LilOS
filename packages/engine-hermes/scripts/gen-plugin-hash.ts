/**
 * Writes the shipped `lilos` plugin's content-hash manifest
 * (`plugin/lilos.content-hash`) from `pluginContentHash` (D-#817).
 * Connect recomputes that hash when it decides whether to recopy; this
 * file is the tripwire so a plugin edit cannot merge while the manifest
 * still describes the old tree. The manifest stays OUTSIDE `plugin/lilos/`
 * — that directory is what the app copies, and a hash file inside it
 * would ship and, if hashed, never settle.
 *
 *   bun packages/engine-hermes/scripts/gen-plugin-hash.ts          write
 *   bun packages/engine-hermes/scripts/gen-plugin-hash.ts --check  exit 1 when stale
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPluginHashManifest } from "../src/plugin-hash.js";

export const PLUGIN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "lilos",
);

/** Sibling of `plugin/lilos/`, not a file the reconciler copies. */
export const MANIFEST_PATH = join(dirname(PLUGIN_DIR), "lilos.content-hash");

export const manifestIsStale = (): boolean =>
  !existsSync(MANIFEST_PATH) ||
  readFileSync(MANIFEST_PATH, "utf8") !== renderPluginHashManifest(PLUGIN_DIR);

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.argv.includes("--check")) {
    if (manifestIsStale()) {
      console.error(
        "stale: engine-hermes/plugin/lilos.content-hash — run bun run schema:gen",
      );
      process.exit(1);
    }
    console.log("plugin-hash: plugin/lilos.content-hash is fresh");
  } else {
    writeFileSync(MANIFEST_PATH, renderPluginHashManifest(PLUGIN_DIR));
    console.log("wrote engine-hermes/plugin/lilos.content-hash");
  }
}
