import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { appProtocol } from "../src/app/registry";

/**
 * Renders Zod contract registries to committed JSON Schema artifacts, the
 * same "declared once, generated for consumers" loop as Hermes
 * `scripts/gen_gateway_contracts.py`. The stale check lives in
 * `packages/contracts/test/app-schema.test.ts`: change a schema → regenerate
 * (`bun run --cwd packages/contracts gen`) → the diff is the contract change.
 *
 * `buildSchemaDoc` is pure so the test can regenerate in memory and compare.
 * When #6 lands its engine registry, add it to `PROTOCOLS` below.
 */

export interface ProtocolRegistry {
  name: string;
  version: number;
  schemas: Record<string, z.ZodType>;
}

export const PROTOCOLS: ProtocolRegistry[] = [appProtocol];

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

export function outputPathFor(protocol: ProtocolRegistry): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "generated",
    `${protocol.name}-protocol.schema.json`,
  );
}

if (import.meta.main) {
  for (const protocol of PROTOCOLS) {
    const path = outputPathFor(protocol);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderSchemaDoc(protocol));
    console.log(`wrote ${path}`);
  }
}
