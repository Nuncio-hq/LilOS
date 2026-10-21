import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  MANIFEST_PATH,
  manifestIsStale,
  PLUGIN_DIR,
} from "../scripts/gen-plugin-hash.js";
import { listPluginFiles, pluginContentHash } from "../src/plugin-hash.js";

/**
 * D-#817: the shipped plugin's content hash is the Connect refresh key.
 * This fails when `plugin/lilos/` changes and the committed manifest was
 * not regenerated — the same tripwire as `catalog.json` / the protocol
 * schemas (`bun run schema:check`).
 *
 * The walk below is deliberately NOT `listPluginFiles`. The only names it
 * ignores are Hermes/OS junk. A refresh key that started skipping a
 * shipped file (catalog.json, a new module) would disagree with this walk.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Every regular file under `dir`, minus the junk the key is allowed to
 *  ignore. Keep this list in the test, not imported from plugin-hash.ts. */
const filesOnDisk = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (name === "__pycache__" || name === ".DS_Store") continue;
      const abs = join(current, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile() || name.endsWith(".pyc")) continue;
      out.push(relative(dir, abs).split(sep).join("/"));
    }
  };
  walk(dir);
  out.sort();
  return out;
};

describe("D-#817 shipped plugin content hash", () => {
  test("the committed manifest matches the shipped plugin, file for file", () => {
    expect(filesOnDisk(PLUGIN_DIR)).toEqual(listPluginFiles(PLUGIN_DIR));
    expect(filesOnDisk(PLUGIN_DIR).length).toBeGreaterThan(0);
    expect(manifestIsStale()).toBe(false);
    const lines = readFileSync(MANIFEST_PATH, "utf8").trim().split("\n");
    expect(lines[1]).toBe(pluginContentHash(PLUGIN_DIR));
    expect(lines.slice(2)).toEqual(listPluginFiles(PLUGIN_DIR));
  });

  test("schema:check runs the hash manifest, and --check fails when the plugin changes", () => {
    const rootPkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );
    expect(rootPkg.scripts["schema:check"]).toContain("gen-plugin-hash.ts");
    expect(rootPkg.scripts["schema:gen"]).toContain("gen-plugin-hash.ts");

    const fresh = spawnSync(
      "bun",
      ["packages/engine-hermes/scripts/gen-plugin-hash.ts", "--check"],
      { cwd: ROOT },
    );
    expect(fresh.status).toBe(0);

    // A manifest that no longer matches the shipped tree is what CI rejects.
    // The equality test above is what fails when the plugin itself changes.
    const original = readFileSync(MANIFEST_PATH, "utf8");
    try {
      writeFileSync(MANIFEST_PATH, "stale\n");
      expect(manifestIsStale()).toBe(true);
      const stale = spawnSync(
        "bun",
        ["packages/engine-hermes/scripts/gen-plugin-hash.ts", "--check"],
        { cwd: ROOT },
      );
      expect(stale.status).toBe(1);
    } finally {
      writeFileSync(MANIFEST_PATH, original);
    }
    expect(manifestIsStale()).toBe(false);
  });

  test("the hash is sorted paths plus bytes; cache files do not change it", () => {
    const dir = join(tmpdir(), `lilos817-${process.pid}-a`);
    const other = join(tmpdir(), `lilos817-${process.pid}-b`);
    mkdirSync(join(dir, "nested"), { recursive: true });
    mkdirSync(join(other, "nested"), { recursive: true });
    writeFileSync(join(dir, "b.txt"), "beta");
    writeFileSync(join(dir, "nested", "a.txt"), "alpha");
    // Opposite write order, same bytes.
    writeFileSync(join(other, "nested", "a.txt"), "alpha");
    writeFileSync(join(other, "b.txt"), "beta");
    expect(pluginContentHash(dir)).toBe(pluginContentHash(other));
    expect(listPluginFiles(dir)).toEqual(["b.txt", "nested/a.txt"]);

    const before = pluginContentHash(dir);
    writeFileSync(join(dir, "b.txt"), "BETA");
    expect(pluginContentHash(dir)).not.toBe(before);

    writeFileSync(join(dir, "b.txt"), "beta");
    mkdirSync(join(dir, "__pycache__"), { recursive: true });
    writeFileSync(join(dir, "__pycache__", "b.cpython-313.pyc"), "junk");
    writeFileSync(join(dir, ".DS_Store"), "junk");
    writeFileSync(join(dir, "extra.pyc"), "junk");
    expect(pluginContentHash(dir)).toBe(before);
    expect(pluginContentHash(join(dir, "missing"))).toBeUndefined();
  });
});
