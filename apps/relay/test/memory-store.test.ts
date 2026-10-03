import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as srcStore from "../src/store";
import { createMemoryStore } from "../src/store";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

describe("AC-1 (#440) the test memory store lives under test/, not src", () => {
  it("nothing under apps/relay/src references createMemoryStore", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (
          entry.name.endsWith(".ts") &&
          readFileSync(path, "utf8").includes("createMemoryStore")
        ) {
          offenders.push(path.slice(SRC.length + 1));
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it("createMemoryStore is no longer exported from src but stays usable", () => {
    expect(srcStore).not.toHaveProperty("createMemoryStore");
    expect(typeof createMemoryStore).toBe("function");
  });
});
