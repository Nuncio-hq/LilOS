import type { PtySpawner } from "@lilos/surfaces";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { serveSurfaces, type SurfacesServer } from "../src/surfaces/server";

/**
 * Issue #611: the `/view` viewer socket's bearer compare (`server.ts`
 * upgrade handler) runs through the shared constant-time `equalSecret` —
 * a near-miss (same length, last char different) or a wrong-length token
 * must never upgrade. `SessionSurfaces` spawns its PTY eagerly and the
 * production spawner is Bun-only, so the test injects an inert one.
 */
const inertPty: PtySpawner = () => ({
  write: () => {},
  resize: () => {},
  kill: () => {},
});

let server: SurfacesServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Resolves true when the upgrade succeeded, false when the gate destroyed
    the socket (server.ts answers a refusal by `socket.destroy()`). */
const upgraded = (url: string) =>
  new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url);
    ws.once("open", () => {
      ws.close();
      resolve(true);
    });
    ws.once("error", () => resolve(false));
  });

describe("AC /view upgrade refuses near-miss and wrong-length session tokens", () => {
  it("only the exact session token upgrades", async () => {
    server = await serveSurfaces(0, { spawnPty: inertPty });
    const session = server.create({});

    const base = `${server.wsUrl}/view`;
    const url = (s: string, t: string) =>
      `${base}?session=${s}&token=${encodeURIComponent(t)}`;
    const nearMiss = `${session.token.slice(0, -1)}${
      session.token.endsWith("0") ? "1" : "0"
    }`;

    // Same length, last char different — and both wrong lengths.
    expect(await upgraded(url(session.session, nearMiss))).toBe(false);
    expect(await upgraded(url(session.session, session.token.slice(0, -1)))).toBe(
      false,
    );
    expect(await upgraded(url(session.session, `${session.token}x`))).toBe(
      false,
    );
    // A resolve miss (unknown session id) is refused too.
    expect(await upgraded(url("no-such-session", session.token))).toBe(false);
    // The real pair upgrades.
    expect(await upgraded(url(session.session, session.token))).toBe(true);
    await server.destroy(session.session);
  });
});
