import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHostHandler } from "../src/host";

/** Issue #113 AC-1: the harness serves the host API on its feed port,
 *  behind the install token; the surface is packages/host's, verbatim. */

const TOKEN = "feed-token";

const tmpdirs: string[] = [];
afterAll(() => {
  for (const d of tmpdirs) rmSync(d, { recursive: true, force: true });
});

const frame = (method: string, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

const post = (handler: (r: Request) => Promise<Response>, init?: RequestInit) =>
  handler(
    new Request("http://127.0.0.1:4581/host", {
      method: "POST",
      body: frame("host.describe"),
      ...(init ?? {}),
    }),
  );

describe("AC-1 harness serves the host API behind the feed's auth", () => {
  const handler = createHostHandler({ token: TOKEN });

  it("rejects without a bearer token", async () => {
    const res = await post(handler);
    expect(res.status).toBe(401);
  });

  it("rejects with a wrong token", async () => {
    const res = await post(handler, {
      headers: { authorization: "Bearer nope" },
      body: frame("host.describe"),
    });
    expect(res.status).toBe(401);
  });

  it("answers host.describe with the token", async () => {
    const res = await handler(
      new Request("http://127.0.0.1:4581/host", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: frame("host.describe"),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { methods: string[] };
    };
    expect(body.result?.methods).toContain("fs.list");
    expect(body.result?.methods).toContain("git.status");
    expect(body.result?.methods).toContain("git.discoverRepos");
  });

  it("serves fs.list on a real directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-host-"));
    tmpdirs.push(dir);
    mkdirSync(join(dir, "sub"));
    const res = await handler(
      new Request("http://127.0.0.1:4581/host", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: frame("fs.list", { path: dir }),
      }),
    );
    const body = (await res.json()) as {
      result?: { entries: { name: string; kind: string }[] };
    };
    expect(res.status).toBe(200);
    expect(body.result?.entries.map((e) => e.name)).toEqual(["sub"]);
  });

  it("rejects non-POST methods", async () => {
    const res = await handler(new Request("http://127.0.0.1:4581/host"));
    expect(res.status).toBe(405);
  });

  it("answers CORS preflight (app origin differs from the feed port)", async () => {
    const res = await handler(
      new Request("http://127.0.0.1:4581/host", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "authorization",
    );
  });
});
