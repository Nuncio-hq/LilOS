import { describe, expect, it } from "vitest";
import {
  type connectPeer,
  errorData,
  eventsNamed,
  helloed,
  lastId,
  newRelay,
  registeredHost,
  req,
  resultOf,
  tick,
} from "./helpers";

/**
 * Scheduled-task records (#136): the relay owns CRUD + broadcasts; the host
 * owns run bookkeeping. These cover the handler surface the harness
 * scheduler + web panel call: create/list/update/runNow/delete, the
 * "schedule can never fire" boundary check, host-key gating, and event
 * broadcasts.
 */
type Peer = ReturnType<typeof connectPeer>;

const call = async (
  p: Peer,
  method: string,
  params: Record<string, unknown> = {},
) => {
  await p.connection.receive(req(method, params));
  await tick();
  return resultOf(p.frames, lastId());
};

const employeeId = async (p: Peer) => {
  await p.connection.receive(req("employees.create", { name: "Ada" }));
  const res = resultOf(p.frames, lastId()).result as {
    employee: { id: string };
  };
  return res.employee.id;
};

const DAILY = { kind: "daily", time: "09:00" };
const makeTask = async (p: Peer, emp: string) =>
  (
    await call(p, "schedules.create", {
      employeeId: emp,
      name: "Standup",
      prompt: "post standup",
      schedule: DAILY,
      access: "ask",
    })
  ).result as { task: { id: string; name: string } };

describe("schedules.* handlers", () => {
  it("create → listed → upserted broadcast", async () => {
    const relay = newRelay();
    const p = await helloed(relay);
    const emp = await employeeId(p);
    p.frames.length = 0;
    const { task } = await makeTask(p, emp);
    expect(task.name).toBe("Standup");
    expect(eventsNamed(p.frames, "schedule.upserted")).toHaveLength(1);
    const listed = await call(p, "schedules.list", { employeeId: emp });
    expect(
      (listed.result as { tasks: { id: string }[] }).tasks.map((t) => t.id),
    ).toEqual([task.id]);
  });

  it("create rejects a schedule the clock can never fire", async () => {
    const relay = newRelay();
    const p = await helloed(relay);
    const emp = await employeeId(p);
    await call(p, "schedules.create", {
      employeeId: emp,
      name: "Bad",
      prompt: "x",
      schedule: { kind: "daily", time: "25:00" },
      access: "ask",
    });
    expect(errorData(p.frames, lastId())).toBe("invalid_params");
  });

  it("create on an unknown employee → not_found", async () => {
    const relay = newRelay();
    const p = await helloed(relay);
    await call(p, "schedules.create", {
      employeeId: "ghost",
      name: "x",
      prompt: "x",
      schedule: DAILY,
      access: "ask",
    });
    expect(errorData(p.frames, lastId())).toBe("not_found");
  });

  it("update applies user fields + folder null clears", async () => {
    const relay = newRelay();
    const p = await helloed(relay);
    const emp = await employeeId(p);
    const { task } = await makeTask(p, emp);
    await call(p, "schedules.update", {
      id: task.id,
      name: "Renamed",
      folder: "/repo",
    });
    await call(p, "schedules.update", { id: task.id, folder: null });
    const res = await call(p, "schedules.list", { employeeId: emp });
    const row = (res.result as { tasks: { name: string; folder?: string }[] })
      .tasks[0];
    expect(row.name).toBe("Renamed");
    expect(row.folder).toBeUndefined();
  });

  it("client cannot write run bookkeeping; host can", async () => {
    const relay = newRelay();
    const client = await helloed(relay);
    const host = await registeredHost(relay);
    const emp = await employeeId(client);
    const { task } = await makeTask(client, emp);
    await call(client, "schedules.update", {
      id: task.id,
      lastFiredAt: 1,
    });
    expect(errorData(client.frames, lastId())).toBe("forbidden");
    const res = await call(host, "schedules.update", {
      id: task.id,
      lastFiredAt: 1,
      lastRun: { conversationId: "c1", at: 1, result: "finished" },
    });
    expect(
      (res.result as { task: { lastFiredAt: number } }).task.lastFiredAt,
    ).toBe(1);
  });

  it("runNow stamps requestedAt + broadcasts", async () => {
    const relay = newRelay();
    const p = await helloed(relay);
    const emp = await employeeId(p);
    const { task } = await makeTask(p, emp);
    p.frames.length = 0;
    const res = await call(p, "schedules.runNow", { id: task.id });
    const updated = res.result as { task: { requestedAt?: number } };
    expect(updated.task.requestedAt).toBeTypeOf("number");
    expect(eventsNamed(p.frames, "schedule.upserted")).toHaveLength(1);
  });

  it("delete → schedule.removed + row gone", async () => {
    const relay = newRelay();
    const p = await helloed(relay);
    const emp = await employeeId(p);
    const { task } = await makeTask(p, emp);
    p.frames.length = 0;
    const res = await call(p, "schedules.delete", { id: task.id });
    expect(res.result).toEqual({ ok: true });
    expect(eventsNamed(p.frames, "schedule.removed")[0].params).toEqual({
      taskId: task.id,
    });
    const listed = await call(p, "schedules.list", { employeeId: emp });
    expect((listed.result as { tasks: unknown[] }).tasks).toEqual([]);
    await call(p, "schedules.delete", { id: task.id });
    expect(errorData(p.frames, lastId())).toBe("not_found");
  });
});
