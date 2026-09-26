import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  GENERATED_DIR,
  GENERATED_DOCS,
  outputPathFor,
  stalePaths,
} from "../scripts/gen-schemas.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(PKG, "..", "..");

describe("unified JSON Schema generator", () => {
  test("AC-1 one generator renders every protocol registry into one output dir", () => {
    expect(GENERATED_DOCS.map((d) => d.file)).toEqual([
      "engine-protocol.schema.json",
      "app-protocol.schema.json",
    ]);
    for (const doc of GENERATED_DOCS) {
      expect(outputPathFor(doc)).toBe(join(GENERATED_DIR, doc.file));
      expect(existsSync(outputPathFor(doc))).toBe(true);
    }
    // Every committed output matches a fresh render.
    expect(stalePaths()).toEqual([]);
  });

  test("AC-2 stale check flags any protocol regenerated out-of-date", () => {
    for (const doc of GENERATED_DOCS) {
      const path = outputPathFor(doc);
      const original = readFileSync(path, "utf8");
      try {
        writeFileSync(path, '{"stale":true}\n');
        expect(stalePaths()).toEqual([path]);
        // And the wired `bun run schema:check` really exits non-zero on it.
        const res = spawnSync(
          "bun",
          ["packages/contracts/scripts/gen-schemas.ts", "--check"],
          { cwd: ROOT },
        );
        expect(res.status).toBe(1);
      } finally {
        writeFileSync(path, original);
      }
      expect(stalePaths()).toEqual([]);
    }
  });

  test("AC-3 the non-TS client still reads the engine schema from generated/", () => {
    const path = join(GENERATED_DIR, "engine-protocol.schema.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.protocol).toEqual({ name: "lilos-engine", version: 1 });
    expect(Object.keys(doc.methods)).toContain("session.start");
    // test-nonts.ts hands this exact file to clients/python/drive.py.
    const runner = readFileSync(
      join(ROOT, "packages", "engine-conformance", "scripts", "test-nonts.ts"),
      "utf8",
    );
    expect(runner).toContain("engine-protocol.schema.json");
  });

  test("AC-4 no dead generator left; biome + package scripts updated", () => {
    for (const dead of ["gen-engine-schema.ts", "generate-json-schemas.ts"]) {
      expect(existsSync(join(PKG, "scripts", dead))).toBe(false);
    }
    const biome = readFileSync(join(ROOT, "biome.json"), "utf8");
    expect(biome).toContain("!packages/contracts/generated");
    expect(biome).not.toContain("!packages/contracts/schema");
    const rootPkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );
    expect(rootPkg.scripts["schema:gen"]).toContain("gen-schemas.ts");
    expect(rootPkg.scripts["schema:check"]).toContain("gen-schemas.ts");
    const contractsPkg = JSON.parse(
      readFileSync(join(PKG, "package.json"), "utf8"),
    );
    expect(contractsPkg.scripts.gen).toBeUndefined();
  });
});
