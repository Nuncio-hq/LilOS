import type { CompanyUpdate } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import {
  errorData,
  eventsNamed,
  helloed,
  lastId,
  newRelay,
  registeredHost,
  req,
  resultOf,
  setupChannel,
} from "./helpers";

/**
 * D-#777: company updates are relay records. The host posts them; every
 * client hears `update.upserted` and can list them. A user client cannot
 * post, and a named ticket must exist.
 */

async function call<T>(
  peer: {
    frames: unknown[];
    connection: { receive(data: string): Promise<void> };
  },
  method: string,
  params = {},
): Promise<T> {
  await peer.connection.receive(req(method, params));
  return resultOf(peer.frames, lastId()).result as T;
}

describe("company updates", () => {
  it("the host posts a note and every client sees it", async () => {
    const relay = newRelay();
    const host = await registeredHost(relay);
    const user = await helloed(relay);
    const { employee } = await setupChannel(user.frames, user.connection);
    user.frames.length = 0;
    const { update } = await call<{ update: CompanyUpdate }>(
      host,
      "updates.post",
      {
        kind: "plan",
        text: "Split the goal into one ticket.",
        authorKind: "employee",
        authorId: employee.id,
      },
    );
    expect(update.kind).toBe("plan");
    expect(update.authorKind).toBe("employee");
    expect(update.authorId).toBe(employee.id);
    const seen = eventsNamed(user.frames, "update.upserted");
    expect(seen).toHaveLength(1);
    const first = seen[0];
    if (!first) throw new Error("missing update.upserted");
    expect((first.params as { update: CompanyUpdate }).update.id).toBe(
      update.id,
    );
    const listed = await call<{ updates: CompanyUpdate[] }>(
      user,
      "updates.list",
    );
    expect(listed.updates.map((u) => u.id)).toEqual([update.id]);
  });

  it("refuses a user post and an unknown ticket", async () => {
    const relay = newRelay();
    const host = await registeredHost(relay);
    const user = await helloed(relay);
    const { employee } = await setupChannel(user.frames, user.connection);
    await user.connection.receive(
      req("updates.post", {
        kind: "note",
        text: "From the owner",
        authorKind: "employee",
        authorId: employee.id,
      }),
    );
    expect(errorData(user.frames, lastId())).toBe("forbidden");
    await host.connection.receive(
      req("updates.post", {
        kind: "note",
        text: "Missing ticket",
        authorKind: "employee",
        authorId: employee.id,
        ticketId: "NO-1",
      }),
    );
    expect(errorData(host.frames, lastId())).toBe("not_found");
  });
});
