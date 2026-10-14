import {
  SchedulesCreateParams,
  SchedulesDeleteParams,
  SchedulesListParams,
  SchedulesRunNowParams,
  SchedulesUpdateParams,
  validSchedule,
} from "@lilos/contracts/app";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Scheduled tasks (#136): the relay owns the records (D-#25); the host owns
 * the clock. User fields (name/prompt/folder/schedule/access/paused) are any
 * client's; `lastRun`/`skippedAt`/`lastFiredAt`/`requestedAt` are host-only —
 * the scheduler stamps them as runs fire, finish and skip.
 */
const HOST_KEYS = [
  "lastRun",
  "skippedAt",
  "lastFiredAt",
  "requestedAt",
] as const;

export async function handleSchedules(c: RelayCtx): Promise<false | undefined> {
  const { method, peer, id, params, store, broadcast, isHost, now, respond } =
    c;
  switch (method) {
    case "schedules.list": {
      const parsed = SchedulesListParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      respond(peer, id, {
        tasks: await store.listScheduledTasks(parsed.data.employeeId),
      });
      return;
    }
    case "schedules.create": {
      const parsed = SchedulesCreateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      /* A schedule the clock can never fire is a data bug the dialog was
         built to prevent — reject it at the boundary, not at run time. */
      if (!validSchedule(parsed.data.schedule)) {
        throw new RpcError(
          JsonRpcCode.invalidParams,
          "invalid_params",
          "schedule has no next run",
        );
      }
      const employee = await store.getEmployee(parsed.data.employeeId);
      if (!employee) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "employee not found",
        );
      }
      const task = await store.createScheduledTask(parsed.data);
      broadcast("schedule.upserted", { task });
      respond(peer, id, { task });
      return;
    }
    case "schedules.update": {
      const parsed = SchedulesUpdateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      if (HOST_KEYS.some((k) => k in parsed.data) && !isHost(peer)) {
        throw new RpcError(
          JsonRpcCode.forbidden,
          "forbidden",
          "only the registered engine host may write run bookkeeping",
        );
      }
      if (parsed.data.schedule && !validSchedule(parsed.data.schedule)) {
        throw new RpcError(
          JsonRpcCode.invalidParams,
          "invalid_params",
          "schedule has no next run",
        );
      }
      const { id: taskId, ...patch } = parsed.data;
      const task = await store.updateScheduledTask(taskId, patch);
      if (!task) {
        throw new RpcError(JsonRpcCode.notFound, "not_found", "task not found");
      }
      broadcast("schedule.upserted", { task });
      respond(peer, id, { task });
      return;
    }
    case "schedules.delete": {
      const parsed = SchedulesDeleteParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const task = await store.deleteScheduledTask(parsed.data.id);
      if (!task) {
        throw new RpcError(JsonRpcCode.notFound, "not_found", "task not found");
      }
      broadcast("schedule.removed", { taskId: task.id });
      respond(peer, id, { ok: true });
      return;
    }
    case "schedules.runNow": {
      const parsed = SchedulesRunNowParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      /* Run now is a stamp, not a host call: `requestedAt` outlives both
         sides — a click while the host was down still fires on its next
         tick, and a live host hears the upsert broadcast the same way. */
      const task = await store.updateScheduledTask(parsed.data.id, {
        requestedAt: now(),
      });
      if (!task) {
        throw new RpcError(JsonRpcCode.notFound, "not_found", "task not found");
      }
      broadcast("schedule.upserted", { task });
      respond(peer, id, { task });
      return;
    }
    default:
      return false;
  }
}
