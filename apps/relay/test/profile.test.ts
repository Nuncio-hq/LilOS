import { describe, expect, it } from "vitest";
import { createRelay } from "../src/session";
import { helloed, nextId, req, resultOf, TOKEN } from "./helpers";
import { createMemoryStore } from "./memory-store";

/**
 * Issue #118 AC-1: the signed-in human's profile (name, company name,
 * avatar colour) is relay-owned domain data — `profile.get` /
 * `profile.update` on the app protocol, with `profile.updated` broadcast
 * so every connected surface sees an edit (seq-less sync, same pattern as
 * employee.upserted). AC-4: an untouched store returns an empty profile —
 * the app layers OS-derived prefill on top.
 */

describe("AC-1 relay owns the profile settings", () => {
  it("AC-1 a fresh store reports an empty profile (AC-4: prefill happens app-side)", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const { frames, connection } = await helloed(relay);
    await connection.receive(req("profile.get"));
    expect(resultOf(frames, `t${nextId - 1}`).result).toEqual({
      profile: {},
    });
  });

  it("AC-1 profile.update persists the profile and broadcasts profile.updated", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const writer = await helloed(relay);
    const watcher = await helloed(relay);
    await writer.connection.receive(
      req("profile.update", {
        userName: "Ada",
        companyName: "Ada Labs",
        avatarColor: "bg-rose-600",
      }),
    );
    expect(resultOf(writer.frames, `t${nextId - 1}`).result).toEqual({
      profile: {
        userName: "Ada",
        companyName: "Ada Labs",
        avatarColor: "bg-rose-600",
      },
    });
    const event = (
      watcher.frames as { method?: string; params?: unknown }[]
    ).find((f) => f.method === "profile.updated");
    expect(event?.params).toEqual({
      profile: {
        userName: "Ada",
        companyName: "Ada Labs",
        avatarColor: "bg-rose-600",
      },
    });
    await writer.connection.receive(req("profile.get"));
    expect(resultOf(writer.frames, `t${nextId - 1}`).result).toEqual({
      profile: {
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
      req("profile.update", { userName: "Ada", companyName: "Ada Labs" }),
    );
    await connection.receive(
      req("profile.update", { avatarColor: "bg-violet-600" }),
    );
    expect(resultOf(frames, `t${nextId - 1}`).result).toEqual({
      profile: {
        userName: "Ada",
        companyName: "Ada Labs",
        avatarColor: "bg-violet-600",
      },
    });
  });

  it("AC-1 update with no fields is rejected", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const { frames, connection } = await helloed(relay);
    await connection.receive(req("profile.update", {}));
    expect(resultOf(frames, `t${nextId - 1}`).error).toBeTruthy();
  });
});
