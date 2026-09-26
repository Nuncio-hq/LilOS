/**
 * ONE generator for every protocol registry: renders each registry's Zod
 * contracts to committed JSON Schema under `packages/contracts/generated/` —
 * declared once in Zod, generated for non-TS clients (the
 * declared-once/generated pattern is borrowed from the gateway-contract
 * generator of the reference engine; see #6, #42).
 *
 *   bun packages/contracts/scripts/gen-schemas.ts          write all
 *   bun packages/contracts/scripts/gen-schemas.ts --check  exit 1 when stale
 *
 * New registries slot into GENERATED_DOCS below — flat registries reuse
 * `renderSchemaDoc`; bespoke wire docs add a renderer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { appProtocol } from "../src/app/registry.js";
import {
  ENGINE_METHODS,
  ENGINE_PROTOCOL,
  EngineEvent,
} from "../src/engine/index.js";
import { HOST_API, HOST_METHODS } from "../src/host/index.js";
import { harnessProtocol } from "../src/harness/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The one output dir for generated protocol schemas. */
export const GENERATED_DIR = join(HERE, "..", "generated");

const toSchema = (s: z.ZodType) =>
  z.toJSONSchema(s, { target: "draft-2020-12", unrepresentable: "throw" });

/** Engine wire doc: methods + notifications (shape fixed by #6's consumers). */
export function renderEngineDoc(): string {
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "LilOS engine protocol",
    description:
      "Generated from packages/contracts/src/engine by scripts/gen-schemas.ts — do not edit.",
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

/** Host wire doc: methods only (the host API has no notifications — #11). */
export function renderHostDoc(): string {
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "LilOS host API",
    description:
      "Generated from packages/contracts/src/host by scripts/gen-schemas.ts — do not edit.",
    protocol: { name: HOST_API.name, version: HOST_API.version },
    methods: Object.fromEntries(
      Object.entries(HOST_METHODS).map(([name, m]) => [
        name,
        { doc: m.doc, params: toSchema(m.params), result: toSchema(m.result) },
      ]),
    ),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Flat registry doc: one JSON Schema definition per registered schema.
 * `buildSchemaDoc` is pure so tests can regenerate in memory and compare.
 */
export interface ProtocolRegistry {
  name: string;
  version: number;
  schemas: Record<string, z.ZodType>;
}

export function buildSchemaDoc(protocol: ProtocolRegistry): unknown {
  const definitions: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(protocol.schemas)) {
    definitions[name] = z.toJSONSchema(schema, { io: "input" });
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `LilOS ${protocol.name} protocol`,
    protocolVersion: protocol.version,
    definitions,
  };
}

export function renderSchemaDoc(protocol: ProtocolRegistry): string {
  return `${JSON.stringify(buildSchemaDoc(protocol), null, 2)}\n`;
}

/** One committed JSON Schema artifact under `generated/`. */
export interface GeneratedDoc {
  /** File name inside GENERATED_DIR. */
  file: string;
  /** Renders the byte-stable doc content. */
  render: () => string;
}

export const GENERATED_DOCS: GeneratedDoc[] = [
  { file: "engine-protocol.schema.json", render: renderEngineDoc },
  {
    file: "app-protocol.schema.json",
    render: () => renderSchemaDoc(appProtocol),
  },
  { file: "host-protocol.schema.json", render: renderHostDoc },
  {
    file: "harness-protocol.schema.json",
    render: () => renderSchemaDoc(harnessProtocol),
  },
];

export function outputPathFor(doc: GeneratedDoc): string {
  return join(GENERATED_DIR, doc.file);
}

/** Outputs whose committed content differs from a fresh render. */
export function stalePaths(): string[] {
  return GENERATED_DOCS.map(outputPathFor).filter(
    (path, i) =>
      !existsSync(path) ||
      readFileSync(path, "utf8") !== GENERATED_DOCS[i].render(),
  );
}

export function writeAll(): string[] {
  mkdirSync(GENERATED_DIR, { recursive: true });
  return GENERATED_DOCS.map((doc) => {
    const path = outputPathFor(doc);
    writeFileSync(path, doc.render());
    return path;
  });
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
    console.log("schema: all generated docs are fresh");
  } else {
    for (const path of writeAll()) {
      console.log(`wrote ${path.split("/packages/")[1]}`);
    }
  }
}
