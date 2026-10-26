import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";
import {
  ACP_PROTOCOL_VERSION,
  ACP_REQUIRED_METHODS,
  ACP_SCHEMA_RELEASE,
  ACP_SDK_VERSION,
  ACP_UPDATE_KINDS,
} from "../src/pin.js";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The SDK's package root — exports hides ./package.json, so resolve the
    entry point and walk up to the directory holding package.json. */
const sdkRoot = (() => {
  let dir = dirname(require.resolve("@agentclientprotocol/sdk"));
  for (let i = 0; i < 6; i++) {
    try {
      readFileSync(join(dir, "package.json"));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error("cannot locate @agentclientprotocol/sdk package root");
})();

/** D-#764 — the pin as a unit test (scripts/check-pin.ts is the CI gate;
    these assert the same invariants inside vitest). */
describe("the pinned ACP surface (D-#764)", () => {
  test("the pin names the stable v1 schema release — never the v2 alpha", () => {
    expect(ACP_SCHEMA_RELEASE).toMatch(/^schema-v1\./);
    expect(ACP_SCHEMA_RELEASE).toBe("schema-v1.26.0");
    expect(ACP_SCHEMA_RELEASE).not.toContain("v2");
  });

  test("the installed SDK matches ACP_SDK_VERSION", () => {
    const pkg = JSON.parse(
      readFileSync(join(sdkRoot, "package.json"), "utf8"),
    ) as { version: string };
    expect(pkg.version).toBe(ACP_SDK_VERSION);
  });

  test("the negotiated protocol version matches the SDK's", () => {
    expect(acp.PROTOCOL_VERSION).toBe(ACP_PROTOCOL_VERSION);
    expect(ACP_PROTOCOL_VERSION).toBe(1);
  });

  test("every workspace SDK dep pins the same version (no second schema)", () => {
    const dirs = [
      ROOT,
      ...["apps", "packages", "prototype"].flatMap((d) => {
        try {
          return readdirSync(join(ROOT, d)).map((p) => join(ROOT, d, p));
        } catch {
          return [];
        }
      }),
    ];
    const drifted: string[] = [];
    for (const dir of dirs) {
      let pkg: { name?: string; dependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      const dep = pkg.dependencies?.["@agentclientprotocol/sdk"];
      if (dep !== undefined && dep !== ACP_SDK_VERSION)
        drifted.push(`${pkg.name ?? dir}@${dep}`);
    }
    expect(drifted).toEqual([]);
  });

  test("the bundled schema still names the surface the mapping uses", () => {
    const schema = readFileSync(join(sdkRoot, "schema", "schema.json"), "utf8");
    for (const m of ACP_REQUIRED_METHODS)
      expect(schema, `missing method ${m}`).toContain(`"${m}"`);
    for (const k of ACP_UPDATE_KINDS)
      expect(schema, `missing update kind ${k}`).toContain(`"${k}"`);
  });
});
