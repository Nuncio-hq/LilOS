import { describe, expect, it } from "vitest";
import {
  errorData,
  helloedDevice,
  helloedToken,
  lastId,
  newWorld,
  registeredHost,
  req,
  requestsTo,
  resultOf,
} from "./helpers";

/* `folders.detail` (#156): the phone's branch/workstream probe. The relay
   gates the path to the recents the Mac already lists, then forwards the
   call to the registered harness (the only process running git). Device
   peers get the same read; #238 lets them `folders.add` — but only paths
   under the Mac's home, so the gate can't be widened past home. */

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

  it("a device can't widen the gate past home: outside adds are refused", async () => {
    const { store, pairing, relay } = newWorld();
    await store.addRecentFolder("~/repo");
    const phone = await helloedDevice(pairing, relay);

    for (const path of ["/etc", "/System", "~/../../var"]) {
      await phone.connection.receive(req("folders.add", { path }));
      expect(errorData(phone.frames, lastId()), path).toBe("forbidden");
    }
    expect(await store.listRecentFolders()).toHaveLength(1);
    // And the gated probe still refuses what the device couldn't plant.
    await phone.connection.receive(req("folders.detail", { path: "/etc" }));
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
