import { APP_PROTOCOL_VERSION, type AppErrorCode } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { createPairingService } from "../src/pairing";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

/* `folders.detail` (#156): the phone's branch/workstream probe. The relay
   gates the path to the recents the Mac already lists, then forwards the
   call to the registered harness (the only process running git). Device
   peers get the same read — but no `folders.add` to widen their own gate. */

const TOKEN = "test-token";

function connectPeer(relay: ReturnType<typeof createRelay>) {
  const frames: unknown[] = [];
  const peer: RelayWsPeer = {
    send: (frame) => frames.push(JSON.parse(frame)),
    close: () => {},
  };
  return { frames, connection: relay.connect(peer), peer };
}

let nextId = 0;
const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });
const lastId = () => `t${nextId - 1}`;
const resultOf = (frames: unknown[], id: string) => {
  const frame = (
    frames as {
      id?: string;
      result?: unknown;
      error?: { code: number; message: string; data?: Record<string, unknown> };
    }[]
  ).find((f) => f.id === id);
  if (!frame) throw new Error(`no response frame for ${id}`);
  return frame;
};
const errorData = (frames: unknown[], id: string) =>
  resultOf(frames, id).error?.data?.code as AppErrorCode;
/* Forwarded host calls arrive as request frames with `hr-N` ids (events
   like `devices.changed` also carry a method but no id). */
const requestsTo = (frames: unknown[]) =>
  (frames as { method?: string; id?: string; params?: unknown }[]).filter(
    (f) => f.id?.startsWith("hr-") === true,
  );

const newWorld = () => {
  const store = createMemoryStore();
  const pairing = createPairingService({ store });
  const relay = createRelay({ store, token: TOKEN, pairing });
  return { store, pairing, relay };
};

async function helloedToken(relay: ReturnType<typeof createRelay>) {
  const p = connectPeer(relay);
  await p.connection.receive(
    req("session.hello", { protocolVersion: 1, token: TOKEN }),
  );
  p.frames.length = 0;
  return p;
}

async function helloedDevice(
  pairing: ReturnType<typeof createPairingService>,
  relay: ReturnType<typeof createRelay>,
) {
  const grant = await pairing.mintGrant();
  const ex = await pairing.exchangeGrant({ code: grant.code });
  if (!("device" in ex)) throw new Error("exchange failed");
  const p = connectPeer(relay);
  await p.connection.receive(
    req("session.hello", {
      protocolVersion: APP_PROTOCOL_VERSION,
      deviceId: ex.device.id,
      credential: ex.credential,
    }),
  );
  p.frames.length = 0;
  return p;
}

async function registeredHost(relay: ReturnType<typeof createRelay>) {
  const p = await helloedToken(relay);
  await p.connection.receive(
    req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
  );
  p.frames.length = 0;
  return p;
}

describe("AC-4 folders.detail — device-scope git probe (#156)", () => {
  it("forwards a recents path to the harness and relays its answer", async () => {
    const { store, relay } = newWorld();
    await store.addRecentFolder("~/repo");
    const host = await registeredHost(relay);
    const caller = await helloedToken(relay);

    await caller.connection.receive(req("folders.detail", { path: "~/repo" }));
    // The host peer sees the forwarded probe request (hr-N id).
    const forwarded = requestsTo(host.frames);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      method: "folders.detail",
      params: { path: "~/repo" },
    });
    expect(forwarded[0].id).toMatch(/^hr-/);

    // The host's answer lands on the caller verbatim.
    const detail = {
      path: "~/repo",
      missing: false,
      isRepo: true,
      root: "~/repo",
      current: "main",
      branches: ["main", "ws/fix-7"],
      workstreams: [
        { branch: "ws/fix-7", path: "~/repo/.lilos/wt/fix-7", from: "main" },
      ],
    };
    await host.connection.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: forwarded[0].id,
        result: detail,
      }),
    );
    expect(resultOf(caller.frames, lastId()).result).toEqual(detail);
  });

  it("a device peer gets the same read — recents-gated, forwarded", async () => {
    const { store, pairing, relay } = newWorld();
    await store.addRecentFolder("~/repo");
    const host = await registeredHost(relay);
    const phone = await helloedDevice(pairing, relay);

    await phone.connection.receive(req("folders.detail", { path: "~/repo" }));
    const forwarded = requestsTo(host.frames);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].method).toBe("folders.detail");
    await host.connection.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: forwarded[0].id,
        result: {
          path: "~/repo",
          missing: false,
          isRepo: false,
          branches: [],
          workstreams: [],
        },
      }),
    );
    expect(resultOf(phone.frames, lastId()).result).toMatchObject({
      isRepo: false,
    });
  });

  it("a path outside recents is not_found for token AND device peers", async () => {
    const { store, pairing, relay } = newWorld();
    await store.addRecentFolder("~/repo");
    const host = await registeredHost(relay);
    const mac = await helloedToken(relay);
    const phone = await helloedDevice(pairing, relay);

    for (const p of [mac, phone]) {
      await p.connection.receive(req("folders.detail", { path: "~/secrets" }));
      expect(errorData(p.frames, lastId())).toBe("not_found");
    }
    expect(requestsTo(host.frames)).toHaveLength(0);
  });

  it("a device can't widen the gate itself: folders.add is forbidden", async () => {
    const { store, pairing, relay } = newWorld();
    await store.addRecentFolder("~/repo");
    const phone = await helloedDevice(pairing, relay);

    await phone.connection.receive(req("folders.add", { path: "~/secrets" }));
    expect(errorData(phone.frames, lastId())).toBe("forbidden");
    expect(await store.listRecentFolders()).toHaveLength(1);
    // And the gated probe still refuses the path it couldn't plant.
    await phone.connection.receive(
      req("folders.detail", { path: "~/secrets" }),
    );
    expect(errorData(phone.frames, lastId())).toBe("not_found");
  });

  it("raw host git calls are not on the device surface", async () => {
    const { store, pairing, relay } = newWorld();
    await store.addRecentFolder("~/repo");
    await registeredHost(relay);
    const phone = await helloedDevice(pairing, relay);

    for (const method of ["git.branches", "git.worktrees", "fs.list"]) {
      await phone.connection.receive(req(method, { path: "~/repo" }));
      const frame = resultOf(phone.frames, lastId());
      expect(frame.error?.code, method).toBe(-32601);
    }
  });

  it("no registered harness → engine_unavailable", async () => {
    const { store, relay } = newWorld();
    await store.addRecentFolder("~/repo");
    const caller = await helloedToken(relay);
    await caller.connection.receive(req("folders.detail", { path: "~/repo" }));
    expect(errorData(caller.frames, lastId())).toBe("engine_unavailable");
  });
});
