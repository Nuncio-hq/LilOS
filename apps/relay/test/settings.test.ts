import { describe, expect, it } from "vitest";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

/**
 * Issue #118 AC-1: the signed-in human's profile (name, company name,
 * avatar colour) is relay-owned domain data — `settings.get` /
 * `settings.update` on the app protocol, with `settings.updated` broadcast
 * so every connected surface sees an edit (seq-less sync, same pattern as
 * employee.upserted). AC-4: an untouched store returns an empty profile —
 * the app layers OS-derived prefill on top.
 */

const TOKEN = "test-token";

let nextId = 0;
const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });

function connectPeer(relay: ReturnType<typeof createRelay>) {
  const frames: unknown[] = [];
  const peer: RelayWsPeer = {
    send: (frame) => frames.push(JSON.parse(frame)),
    close: () => {},
  };
  const connection = relay.connect(peer);
  return { frames, connection };
}

const resultOf = (frames: unknown[], id: string) => {
  const frame = (
    frames as {
      id?: string;
      result?: unknown;
      error?: { code: number; message: string };
    }[]
  ).find((f) => f.id === id);
  if (!frame) throw new Error(`no response frame for ${id}`);
  return frame;
};

async function helloed(relay: ReturnType<typeof createRelay>) {
  const { frames, connection } = connectPeer(relay);
  await connection.receive(
    req("session.hello", { protocolVersion: 1, token: TOKEN }),
  );
  frames.length = 0;
  return { frames, connection };
}

describe("AC-1 relay owns the profile settings", () => {
  it("AC-1 a fresh store reports an empty profile (AC-4: prefill happens app-side)", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const { frames, connection } = await helloed(relay);
    await connection.receive(req("settings.get"));
    expect(resultOf(frames, `t${nextId - 1}`).result).toEqual({
      settings: {},
    });
  });

  it("AC-1 settings.update persists the profile and broadcasts settings.updated", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const writer = await helloed(relay);
    const watcher = await helloed(relay);
    await writer.connection.receive(
      req("settings.update", {
        userName: "Ada",
        companyName: "Ada Labs",
        avatarColor: "bg-rose-600",
      }),
    );
    expect(resultOf(writer.frames, `t${nextId - 1}`).result).toEqual({
      settings: {
        userName: "Ada",
        companyName: "Ada Labs",
        avatarColor: "bg-rose-600",
      },
    });
    const event = (watcher.frames as { method?: string; params?: unknown }[])
      .find((f) => f.method === "settings.updated");
    expect(event?.params).toEqual({
      settings: {
        userName: "Ada",
        companyName: "Ada Labs",
        avatarColor: "bg-rose-600",
      },
    });
    await writer.connection.receive(req("settings.get"));
    expect(resultOf(writer.frames, `t${nextId - 1}`).result).toEqual({
      settings: {
        userName: "Ada",
        companyName: "Ada Labs",
        avatarColor: "bg-rose-600",
      },
    });
  });

  it("AC-1 a partial update merges into the stored profile", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const { frames, connection } = await helloed(relay);
    await connection.receive(
      req("settings.update", { userName: "Ada", companyName: "Ada Labs" }),
    );
    await connection.receive(
      req("settings.update", { avatarColor: "bg-violet-600" }),
    );
    expect(resultOf(frames, `t${nextId - 1}`).result).toEqual({
      settings: {
        userName: "Ada",
        companyName: "Ada Labs",
        avatarColor: "bg-violet-600",
      },
    });
  });

  it("AC-1 update with no fields is rejected", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const { frames, connection } = await helloed(relay);
    await connection.receive(req("settings.update", {}));
    expect(resultOf(frames, `t${nextId - 1}`).error).toBeTruthy();
  });
});
