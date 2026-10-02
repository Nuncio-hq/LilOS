import type { DemoPlan, DemoScript, DemoStep } from "./types";

/* The demo turn player (#168): walks a DemoScript and emits the wire
   `EngineEvent`s a real engine would — turn.deltas, tool.started/completed,
   plan.updated ticks, subagent.*, request.opened. `emit` stamps seq/session
   and is provided by the DemoClient; `delay` is a real timer live and a
   no-op when a seed bakes its history, so baked logs are byte-for-byte the
   live ones minus the waiting. */

export type TurnEmit = (type: string, payload: Record<string, unknown>) => void;

export type TurnCtx = {
  turnId: string;
  emit: TurnEmit;
  /** Awaited pacing — setTimeout live, resolved promise when baking. */
  delay: (ms: number) => Promise<void>;
  /** Cross-script ticking list for turns paused on an ask: a "tasks"
      working list (s-ci) or an approved "plan" being worked (s-plan). */
  ticker?: {
    planId: string;
    kind: "tasks" | "plan";
    version: number;
    steps: { text: string; files?: string[] }[];
    done: number;
  };
  /** Tool-call id counter — persists across scripts so held/resumed turns
      never reuse an id the completed-steps lookup would merge wrongly. */
  calls?: number;
};

const WORD_MS = { reasoning: 38, text: 26 };

async function stream(
  ctx: TurnCtx,
  streamName: "reasoning" | "text",
  body: string,
): Promise<void> {
  const words = body.split(/(\s+)/).filter((w) => w.length > 0);
  for (const w of words) {
    ctx.emit("turn.delta", {
      turnId: ctx.turnId,
      stream: streamName,
      delta: w,
    });
    await ctx.delay(WORD_MS[streamName]);
  }
}

function planUpdated(ctx: TurnCtx, plan: DemoPlan): void {
  ctx.emit("plan.updated", {
    turnId: ctx.turnId,
    planId: plan.planId,
    kind: plan.kind,
    version: plan.version,
    ...(plan.goal !== undefined ? { goal: plan.goal } : {}),
    ...(plan.risks !== undefined ? { risks: plan.risks } : {}),
    steps: plan.steps,
  });
}

/** Tick the turn's task/plan list around the next tool call: `done`
    counts steps already completed across every script this turn played,
    so a held/resumed turn keeps ticking. kind "plan" snapshots merge on
    the same version — the approved plan's own rows fill in live. */
function tick(ctx: TurnCtx, completed: boolean): void {
  const t = ctx.ticker;
  if (!t) return;
  if (completed) t.done += 1;
  ctx.emit("plan.updated", {
    turnId: ctx.turnId,
    planId: t.planId,
    kind: t.kind,
    version: t.version,
    steps: t.steps.map((s, k) => ({
      ...s,
      status:
        k < t.done ? "completed" : k === t.done ? "in_progress" : "pending",
    })),
  });
}

async function runStep(
  ctx: TurnCtx,
  step: DemoStep,
  callId: string,
  parentToolCallId?: string,
): Promise<void> {
  ctx.emit("tool.started", {
    turnId: ctx.turnId,
    toolCallId: callId,
    tool: step.tool,
    input: { command: step.arg },
    ...(parentToolCallId ? { parentToolCallId } : {}),
  });
  await ctx.delay(step.ms ?? 900);
  ctx.emit("tool.completed", {
    turnId: ctx.turnId,
    toolCallId: callId,
    tool: step.tool,
    status: "completed",
    ...(step.output !== undefined ? { output: step.output } : {}),
    ...(step.add !== undefined
      ? {
          diff: {
            path: step.arg,
            status: step.del ? "modified" : "added",
            add: step.add,
            del: step.del ?? 0,
            ...(step.patch ? { patch: step.patch } : {}),
          },
        }
      : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
  });
}

/** One helper's whole arc: started → its tool calls → completed. Live runs
    them concurrently (each on its own timer chain); a bake plays them in
    order — either way the event payloads are identical. */
async function runSubagent(
  ctx: TurnCtx,
  sa: NonNullable<DemoScript["subagents"]>[number],
): Promise<void> {
  if (sa.delay) await ctx.delay(sa.delay);
  const startedAt = Date.now();
  ctx.emit("subagent.started", {
    turnId: ctx.turnId,
    subagentId: sa.id,
    name: sa.name,
    task: sa.task,
    ...(sa.employee ? { employee: sa.employee } : {}),
    startedAt,
  });
  if (sa.employee) {
    /* An employee helper works in its own thread: no nested steps here,
       just a wait before its verdict lands. */
    await ctx.delay(sa.wait ?? 6000);
  } else {
    for (const [i, s] of sa.steps.entries()) {
      await runStep(ctx, s, `${sa.id}-c${i + 1}`, sa.id);
    }
  }
  ctx.emit("subagent.completed", {
    subagentId: sa.id,
    status: sa.ends === "failed" ? "failed" : "done",
    result: sa.result,
    durationMs: Date.now() - startedAt,
  });
}

export async function playScript(
  ctx: TurnCtx,
  script: DemoScript,
  opts: { live: boolean },
): Promise<void> {
  if (script.reasoning) await stream(ctx, "reasoning", script.reasoning);

  if (script.tasks && !ctx.ticker) {
    ctx.ticker = {
      planId: `tasks-${ctx.turnId}`,
      kind: "tasks",
      version: 1,
      steps: script.tasks.map((text) => ({ text })),
      done: 0,
    };
    ctx.emit("plan.updated", {
      turnId: ctx.turnId,
      planId: ctx.ticker.planId,
      kind: "tasks",
      version: 1,
      steps: ctx.ticker.steps.map((s) => ({ ...s, status: "pending" })),
    });
  }
  /* Approve on a plan ask: tick the plan's own rows as work lands. */
  if (script.tickPlan && !ctx.ticker) {
    ctx.ticker = { ...script.tickPlan, done: 0 };
  }
  for (const s of script.steps ?? []) {
    if (ctx.ticker) tick(ctx, false);
    ctx.calls = (ctx.calls ?? 0) + 1;
    await runStep(ctx, s, `${ctx.turnId}-c${ctx.calls}`);
    if (ctx.ticker) tick(ctx, true);
  }

  for (const j of script.jobs ?? []) {
    ctx.emit("job.started", {
      jobId: j.jobId,
      command: j.command,
      ...(j.startedAt !== undefined ? { startedAt: j.startedAt } : {}),
      ...(j.url ? { url: j.url } : {}),
      ...(j.by ? { by: j.by } : {}),
    });
    if (j.tail) ctx.emit("job.output", { jobId: j.jobId, tail: j.tail });
    if (j.status !== "running") {
      ctx.emit("job.exited", {
        jobId: j.jobId,
        status: j.status,
        ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
      });
    }
  }

  if (script.subagents) {
    if (opts.live) {
      await Promise.all(script.subagents.map((sa) => runSubagent(ctx, sa)));
    } else {
      for (const sa of script.subagents) await runSubagent(ctx, sa);
    }
  }

  if (script.text) await stream(ctx, "text", script.text);
  if (script.plan) planUpdated(ctx, script.plan);

  /* Everything ticked: a task list left mid-run closes when the turn
     ends, so an approved plan's own steps all land completed. */
  const t = ctx.ticker;
  if (t && t.done < t.steps.length) {
    t.done = t.steps.length;
    ctx.emit("plan.updated", {
      turnId: ctx.turnId,
      planId: t.planId,
      kind: t.kind,
      version: t.version,
      steps: t.steps.map((s) => ({ ...s, status: "completed" })),
    });
  }
}
