/**
 * Issue #273, AC-1 — a spec's stack boot must refuse a port already held by
 * a foreign relay: readiness is identity-checked (`/healthz.instanceId` vs
 * the `[relay] instanceId` line the spawned process logs), never just
 * "something answers". Today the probe is blind: `waitForHttp(...:port/)`
 * passes against the other stack and the spec rides it until teardown.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { bootStack, freePort } from "../../../e2e/helpers/stack";

const FOREIGN_ID = "11111111-2222-4333-8444-555555555555";

/** A stand-in relay: answers `/` and `/healthz` with ITS OWN instanceId —
    exactly what the old blind probe accepted as "ready". */
function standInRelay(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          relayVersion: "0.0.0",
          instanceId: FOREIGN_ID,
          protocolVersion: 1,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("lilos relay\n");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

describe("AC-1 (#273) stack boot refuses a foreign relay on its port", () => {
  let standin: { server: Server; port: number } | undefined;
  afterAll(() => {
    standin?.server.close();
  });

  it("fails within seconds naming the port and both instance ids", async () => {
    standin = await standInRelay();
    const [feed, web] = [await freePort(), await freePort()];
    const started = Date.now();
    const res = await bootStack("ac1-273", {
      relay: standin.port,
      feed,
      web,
    }).then(
      (stack) => ({ ok: true as const, stack }),
      (e: Error) => ({ ok: false as const, e }),
    );
    const elapsed = Date.now() - started;
    if (res.ok) {
      await res.stack.stop();
      throw new Error(
        "bootStack resolved against a foreign relay — the probe is identity-blind",
      );
    }
    console.log(`boot failed in ${elapsed}ms: ${res.e.message}`);
    expect(String(res.e.message)).toContain(`port ${standin.port}`);
    expect(String(res.e.message)).toContain(FOREIGN_ID);
    expect(String(res.e.message)).toMatch(/ours [0-9a-f-]{36}/);
    // "Within seconds" — not after the relay's whole bind-retry budget.
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);
});

describe("AC-2 (#273) every stack-booting spec uses the shared helper", () => {
  const e2eDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../e2e",
  );
  const specs = readdirSync(e2eDir).filter((f) => f.endsWith(".spec.ts"));

  /* A private copy of the readiness probe is how the identity-blind bug
     spread in the first place — forbid re-declaring the shared helpers'
     names, and any probe of a relay/feed port that isn't identity-checked. */
  const PRIVATE_HELPER =
    /\b(?:async function|function|const)\s+(bootStack|waitForHttp|waitForToken|killProc|freePort|pickPorts|waitForInstance|waitForRelay|waitForFeed)\b/;
  const BLIND_RELAY_FEED = /waitForHttp\(`http:\/\/127\.0\.0\.1:\$\{[^}]*(relay|feed)/i;

  it("no spec re-declares a private boot/readiness helper", () => {
    const offenders = specs.filter((f) =>
      PRIVATE_HELPER.test(readFileSync(path.join(e2eDir, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("no spec probes a relay/feed port with plain waitForHttp", () => {
    const offenders = specs.filter((f) =>
      BLIND_RELAY_FEED.test(readFileSync(path.join(e2eDir, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
