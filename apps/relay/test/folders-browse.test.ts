import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  errorData,
  helloedDevice,
  helloedToken,
  homes,
  lastId,
  mkhome,
  newWorld,
  registeredHost,
  req,
  requestsTo,
  resultOf,
} from "./helpers";

/* `folders.browse`/`folders.discover` (#238): device-scope reads the relay
   forwards to the registered harness — the relay itself only validates and
   gates `folders.add` to home-scoped paths for device peers. The harness's
   own listing enforcement is covered in apps/harness/test. */

describe("AC-1/AC-2 folders.browse + folders.discover — forwarded (#238)", () => {
  it("a device peer's folders.browse is forwarded to the harness", async () => {
    const { pairing, relay } = newWorld();
    const host = await registeredHost(relay);
    const phone = await helloedDevice(pairing, relay);

    await phone.connection.receive(req("folders.browse", { path: "~/repos" }));
    const forwarded = requestsTo(host.frames);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      method: "folders.browse",
      params: { path: "~/repos" },
    });
    expect(forwarded[0].id).toMatch(/^hr-/);

    const listing = {
      path: "~/repos",
      folders: [
        { name: "crew", path: "~/repos/crew", branch: "main" },
        { name: "notes", path: "~/repos/notes" },
      ],
    };
    await host.connection.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: forwarded[0].id,
        result: listing,
      }),
    );
    expect(resultOf(phone.frames, lastId()).result).toEqual(listing);
  });

  it("folders.discover forwards and relays the repos answer", async () => {
    const { relay } = newWorld();
    const host = await registeredHost(relay);
    const mac = await helloedToken(relay);

    await mac.connection.receive(req("folders.discover"));
    const forwarded = requestsTo(host.frames);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].method).toBe("folders.discover");
    const repos = {
      repos: [
        { path: "~/repos/crew", branch: "main" },
        { path: "~/Desktop/demo", branch: "feat/x" },
      ],
    };
    await host.connection.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: forwarded[0].id,
        result: repos,
      }),
    );
    expect(resultOf(mac.frames, lastId()).result).toEqual(repos);
  });

  it("a refusal reaches the caller verbatim — a clear error, not a listing", async () => {
    const { relay } = newWorld();
    const host = await registeredHost(relay);
    const mac = await helloedToken(relay);

    await mac.connection.receive(req("folders.browse", { path: "/System" }));
    const forwarded = requestsTo(host.frames);
    expect(forwarded).toHaveLength(1);
    await host.connection.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: forwarded[0].id,
        error: {
          code: -32105,
          message: "path is outside the Mac's home folder: /System",
        },
      }),
    );
    const frame = resultOf(mac.frames, lastId());
    expect(frame.result).toBeUndefined();
    expect(frame.error?.message).toContain("outside the Mac's home folder");
  });
});

describe("AC-5 folders.browse/discover with no harness — never an empty list", () => {
  it("no registered host → engine_unavailable for both calls", async () => {
    const { pairing, relay } = newWorld();
    const phone = await helloedDevice(pairing, relay);

    await phone.connection.receive(req("folders.browse", { path: "~" }));
    expect(errorData(phone.frames, lastId())).toBe("engine_unavailable");
    await phone.connection.receive(req("folders.discover"));
    expect(errorData(phone.frames, lastId())).toBe("engine_unavailable");
  });
});

describe("AC-3/AC-4 folders.add — device peers may only write home paths", () => {
  it("a device adds a home folder and it lands in the shared recents", async () => {
    const home = mkhome();
    mkdirSync(join(home, "repos", "crew"), { recursive: true });
    const { pairing, relay } = newWorld(home);
    const phone = await helloedDevice(pairing, relay);
    const mac = await helloedToken(relay);

    await phone.connection.receive(
      req("folders.add", { path: "~/repos/crew" }),
    );
    expect(resultOf(phone.frames, lastId()).result).toMatchObject({
      folder: { path: "~/repos/crew" },
    });

    // Recents are shared — the web picker lists what the phone just added.
    await mac.connection.receive(req("folders.list"));
    const res = resultOf(mac.frames, lastId()).result as {
      folders: { path: string }[];
    };
    expect(res.folders.map((f) => f.path)).toContain("~/repos/crew");

    // And the add unlocks the recents-gated probe for that exact path.
    const host = await registeredHost(relay);
    await phone.connection.receive(
      req("folders.detail", { path: "~/repos/crew" }),
    );
    expect(requestsTo(host.frames)).toHaveLength(1);
    expect(requestsTo(host.frames)[0].method).toBe("folders.detail");
  });

  it("a device still can't widen past home: every escape is forbidden", async () => {
    const home = mkhome();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "lilos-out-")));
    homes.push(outside);
    mkdirSync(join(home, ".ssh"), { recursive: true });
    symlinkSync(outside, join(home, "outlink"));
    const { store, pairing, relay } = newWorld(home);
    const phone = await helloedDevice(pairing, relay);

    for (const path of [
      "/System",
      "/etc",
      outside,
      "~/outlink",
      "~/.ssh",
      "~/x/../..",
      "../",
    ]) {
      await phone.connection.receive(req("folders.add", { path }));
      expect(errorData(phone.frames, lastId()), path).toBe("forbidden");
    }
    // Nothing got planted in the shared recents.
    expect(await store.listRecentFolders()).toHaveLength(0);
  });

  it("a token peer's folders.add is unchanged — the gate is device-only", async () => {
    const home = mkhome();
    const { relay } = newWorld(home);
    const mac = await helloedToken(relay);

    await mac.connection.receive(req("folders.add", { path: "/tmp/anywhere" }));
    expect(resultOf(mac.frames, lastId()).result).toMatchObject({
      folder: { path: "/tmp/anywhere" },
    });
  });
});
