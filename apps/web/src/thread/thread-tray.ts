import type { SessionModel } from "@lilos/client-runtime";
import type { AppMessage, Conversation } from "@lilos/contracts/app";
import type { Job } from "@lilos/contracts/engine";
import type { BackgroundJob } from "@lilos/ui/types";
import { describeActionError } from "../lib/actions";
import { clock, formatUptime, toJob } from "../lib/mapping";
import { relay } from "../lib/runtime";
import { sayError } from "../lib/toast";

/* The session's background processes (#179): `jobs.list` rows cover the
   engine-restart window the event stream can't; job.* events then win
   (fresher). The tab renders only when the capability is declared. #587
   AC-2: helpers list ONLY on the Subagents tab — no merge into the
   Background jobs rows. */
export function buildUiJobs(
  model: SessionModel | undefined,
  listed: Job[] | undefined,
  jobsCapable: boolean,
): BackgroundJob[] {
  if (!jobsCapable) return [];
  const now = Date.now();
  const byId = new Map<string, BackgroundJob>();
  for (const j of listed ?? []) {
    byId.set(j.jobId, {
      id: j.jobId,
      command: j.command,
      status: j.status,
      started: j.startedAt ? clock(j.startedAt) : "",
      uptime: j.startedAt
        ? formatUptime(((j.endedAt ?? now) - j.startedAt) / 1000)
        : "0s",
      ...(j.url ? { url: j.url } : {}),
      ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
      log: j.tail ?? "",
    });
  }
  for (const j of model?.jobs ?? []) byId.set(j.jobId, toJob(j, now));
  return [...byId.values()].sort(
    (a, b) => a.started.localeCompare(b.started) || a.id.localeCompare(b.id),
  );
}

export function stopBackgroundJob(conv: Conversation, jobId: string): void {
  if (!conv.engineRef) return;
  void relay
    .request<{ stopped: boolean }>("jobs.stop", {
      sessionId: conv.engineRef,
      jobId,
    })
    .catch((e) => sayError(describeActionError("Couldn't stop the job", e)));
}

/* #315 tray actions. The relay owns the row: Remove marks it `removed` (the
   harness's `message.changed` handler drops it from every in-memory hold, so
   the engine never gets it); Send clears `dropped` and the harness
   re-delivers it. `sayError` carries a failure instead of throwing
   mid-render. */
export function removeMessage(target: AppMessage | undefined): void {
  if (!target) return;
  void relay
    .request("messages.remove", { messageId: target.id })
    .catch((e) =>
      sayError(describeActionError("Couldn't remove the message", e)),
    );
}

export function sendQueuedMessage(target: AppMessage | undefined): void {
  if (!target) return;
  void relay
    .request("messages.send", { messageId: target.id })
    .catch((e) =>
      sayError(describeActionError("Couldn't send the message", e)),
    );
}
