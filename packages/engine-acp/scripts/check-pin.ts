#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
/**
 * D-#764 — the ACP pin drift check, wired into `bun run schema:check`.
 * The seam speaks exactly one pinned surface (src/pin.ts): the upstream
 * stable schema release, the SDK version generated from it, and the
 * protocolVersion the handshake negotiates. This script fails when the
 * pin and the installed tree disagree:
 *
 * 1. every workspace package.json that depends on @agentclientprotocol/sdk
 *    pins exactly ACP_SDK_VERSION — two SDK versions would be two schemas;
 * 2. the installed SDK is that version (its bundled schema IS the release —
 *    schema.json carries no tag of its own, the SDK version is the key);
 * 3. the SDK's PROTOCOL_VERSION equals ACP_PROTOCOL_VERSION;
 * 4. the bundled schema/schema.json still names every method and update
 *    kind the mapping relies on (renames/removals are the drift that would
 *    silently break the seam).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import {
  ACP_PROTOCOL_VERSION,
  ACP_REQUIRED_METHODS,
  ACP_SCHEMA_RELEASE,
  ACP_SDK_VERSION,
  ACP_UPDATE_KINDS,
} from "../src/pin.js";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let failed = false;
const fail = (msg: string) => {
  failed = true;
  console.error(`check-pin: ${msg}`);
};

/* 1–2: every workspace SDK dep pins ACP_SDK_VERSION; the installed tree
   matches (resolving from this package, which depends on the SDK). */
const pkgDirs = [
  ROOT,
  ...["apps", "packages", "prototype"].flatMap((d) => {
    try {
      return readdirSync(join(ROOT, d)).map((p) => join(ROOT, d, p));
    } catch {
      return [];
    }
  }),
];
for (const dir of pkgDirs) {
  let pkg: { name?: string; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const dep = pkg.dependencies?.["@agentclientprotocol/sdk"];
  if (dep !== undefined && dep !== ACP_SDK_VERSION)
    fail(
      `${pkg.name ?? dir} pins @agentclientprotocol/sdk ${dep}, expected ${ACP_SDK_VERSION} (pin: ${ACP_SCHEMA_RELEASE})`,
    );
}

/* exports hides ./package.json — resolve the entry, walk up to the root. */
let sdkRoot = dirname(require.resolve("@agentclientprotocol/sdk"));
for (let i = 0; i < 6; i++) {
  try {
    readFileSync(join(sdkRoot, "package.json"));
    break;
  } catch {
    sdkRoot = dirname(sdkRoot);
  }
}
const sdkPkgPath = join(sdkRoot, "package.json");
const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, "utf8")) as {
  version?: string;
};
if (sdkPkg.version !== ACP_SDK_VERSION)
  fail(
    `installed @agentclientprotocol/sdk is ${sdkPkg.version}, pinned ${ACP_SDK_VERSION} (schema release ${ACP_SCHEMA_RELEASE})`,
  );

/* 3: the negotiated protocol version matches the pin. */
if (acp.PROTOCOL_VERSION !== ACP_PROTOCOL_VERSION)
  fail(
    `SDK PROTOCOL_VERSION is ${acp.PROTOCOL_VERSION}, pinned ${ACP_PROTOCOL_VERSION}`,
  );

/* 4: the bundled schema still names the surface the mapping relies on. */
const schemaJson = readFileSync(
  join(dirname(sdkPkgPath), "schema", "schema.json"),
  "utf8",
);
for (const m of ACP_REQUIRED_METHODS)
  if (!schemaJson.includes(`"${m}"`))
    fail(`bundled schema dropped method "${m}"`);
for (const k of ACP_UPDATE_KINDS)
  if (!schemaJson.includes(`"${k}"`))
    fail(`bundled schema dropped sessionUpdate kind "${k}"`);

if (failed) process.exit(1);
console.log(
  `check-pin: ACP ${ACP_SCHEMA_RELEASE} via @agentclientprotocol/sdk@${ACP_SDK_VERSION} (protocol v${ACP_PROTOCOL_VERSION}) — all in sync`,
);
