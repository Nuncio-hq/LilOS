/**
 * Render `contracts/src/engine` into generated JSON Schema at
 * `packages/contracts/schema/engine-protocol.json` — declared once in Zod,
 * generated for non-TS clients (the declared-once/generated pattern is borrowed
 * from the gateway-contract generator of the reference engine; see #6).
 *
 *   bun packages/contracts/scripts/gen-engine-schema.ts          write
 *   bun packages/contracts/scripts/gen-engine-schema.ts --check  exit 1 when stale
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ENGINE_METHODS,
  ENGINE_PROTOCOL,
  EngineEvent,
} from "../src/engine/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "schema", "engine-protocol.json");

export function renderEngineSchema(): string {
  const toSchema = (s: z.ZodType) =>
    z.toJSONSchema(s, { target: "draft-2020-12", unrepresentable: "throw" });

  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "LilOS engine protocol",
    description:
      "Generated from packages/contracts/src/engine by gen-engine-schema.ts — do not edit.",
    protocol: { name: ENGINE_PROTOCOL.name, version: ENGINE_PROTOCOL.version },
    methods: Object.fromEntries(
      Object.entries(ENGINE_METHODS).map(([name, m]) => [
        name,
        {
          doc: m.doc,
          ...(m.capability ? { capability: m.capability } : {}),
          params: toSchema(m.params),
          result: toSchema(m.result),
        },
      ]),
    ),
    notifications: {
      event: {
        doc: "Engine -> client notification carrying a sequenced event frame.",
        params: toSchema(EngineEvent),
      },
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function stalePaths(): string[] {
  return existsSync(OUT) && readFileSync(OUT, "utf8") === renderEngineSchema()
    ? []
    : [OUT];
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--check")) {
    const stale = stalePaths();
    if (stale.length) {
      console.error(
        `stale: ${stale.map((p) => p.split("/packages/")[1]).join(", ")} — run bun run schema:gen`,
      );
      process.exit(1);
    }
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, renderEngineSchema());
    console.log(`wrote ${OUT.split("/packages/")[1]}`);
  }
}
