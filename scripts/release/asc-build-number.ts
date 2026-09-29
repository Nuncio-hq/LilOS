#!/usr/bin/env bun
/* App Store Connect build-number helper (#250).
 *
 *   asc-build-number.ts --next 5      -> 6        (pure: next after <latest>)
 *   asc-build-number.ts --latest      -> <latest> (queries ASC, needs secrets)
 *   asc-build-number.ts --next        -> <latest+1>
 *
 * The release script asks ASC (the upload target — the only counter that can
 * never collide) for the newest build of the app, then bumps it. Secrets come
 * from env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8. No values are printed. */
import crypto from "node:crypto";

const APP_ID = process.env.LILOS_ASC_APP_ID ?? "6816892244";

/** next build number after `latest`: integers bump ("5" -> "6"), dotted
   versions bump their last number ("1.0.9" -> "1.0.10"). */
export function nextBuildNumber(latest: string): string {
  const m = latest.match(/^(.*?)(\d+)$/);
  if (!m) throw new Error(`can't derive a build number from "${latest}"`);
  return `${m[1]}${Number(m[2]) + 1}`;
}

function ascJwt(): string {
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 } = process.env;
  for (const [name, value] of Object.entries({
    ASC_KEY_ID,
    ASC_ISSUER_ID,
    ASC_KEY_P8,
  })) {
    if (!value) throw new Error(`${name} is not set`);
  }
  const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
  const header = b64u(
    JSON.stringify({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" }),
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(
    JSON.stringify({
      iss: ASC_ISSUER_ID,
      iat: now,
      exp: now + 15 * 60,
      aud: "appstoreconnect-v1",
    }),
  );
  const key = (ASC_KEY_P8 ?? "").replace(/\\n/g, "\n");
  const sig = crypto
    // ES256 = ECDSA P-256 + raw r||s (ieee-p1363), not the default DER encoding
    .sign("sha256", Buffer.from(`${header}.${payload}`), {
      key,
      dsaEncoding: "ieee-p1363",
    })
    .toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function latestBuild(): Promise<string> {
  const url =
    `https://api.appstoreconnect.apple.com/v1/builds` +
    `?filter[app]=${APP_ID}&fields[builds]=version&sort=-version&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${ascJwt()}` },
  });
  if (!res.ok) throw new Error(`ASC /v1/builds answered HTTP ${res.status}`);
  const data = (await res.json()) as {
    data?: { attributes?: { version?: string } }[];
  };
  const version = data.data?.[0]?.attributes?.version;
  if (!version) throw new Error("ASC returned no builds for this app");
  return version;
}

async function main() {
  const [flag, arg] = process.argv.slice(2);
  if (flag === "--next" && arg !== undefined) {
    process.stdout.write(`${nextBuildNumber(arg)}\n`);
    return;
  }
  const latest = await latestBuild();
  if (flag === "--latest") {
    process.stdout.write(`${latest}\n`);
    return;
  }
  if (flag === "--next" || flag === undefined) {
    process.stdout.write(`${nextBuildNumber(latest)}\n`);
    return;
  }
  console.error("usage: asc-build-number.ts [--latest | --next [latest]]");
  process.exit(2);
}

// Import-safe: the vitest spawn runs the CLI; importing for the pure fn is fine.
if (import.meta.main) await main();
