import { RelayError } from "@lilos/client-runtime";
import type { Ask } from "@lilos/contracts/app";
import type { DemoClient, DemoConv, DemoTurn } from "./client";
import type { TurnCtx } from "./engine";
import { playScript } from "./engine";
import { followUpScript, SLEEP_FIX_TURN, SLEEP_THREAD } from "./seeds";
import type { DemoAsk, DemoScript } from "./types";

/* The demo engine's turn driver (#168): playTurn runs a DemoScript on a
   conversation's open turn, asks hold it open until `asks.respond`, and the
   branch scripts resume it. These were the prototype fake-engine's
   runTurn/answerAsk, re-pointed at wire events — the client delegates here
   so the file stays under the ~400-line convention. */

export async function playTurn(
  client: DemoClient,
  conv: DemoConv,
  script: DemoScript,
  opts: { live: boolean; initiatedBy?: "user" | "system"; at?: number },
): Promise<void> {
  const turn: DemoTurn =
    conv.turn ??
    (() => {
      const turnId = `t-${++client.turnCounter}`;
      const ctx: TurnCtx = {
        turnId,
        emit: (type, payload) => client.emit(conv, type, payload),
        delay: opts.live ? client.liveDelay : () => Promise.resolve(),
      };
      const t: DemoTurn = { turnId, ctx, held: false, dead: false };
      conv.turn = t;
      client.emit(conv, "turn.started", {
        turnId,
        ...(conv.conv.model ? { model: conv.conv.model } : {}),
        ...(conv.conv.provider ? { provider: conv.conv.provider } : {}),
        ...(conv.conv.effort ? { effort: conv.conv.effort } : {}),
        initiatedBy: opts.initiatedBy ?? "user",
      });
      client.emit(conv, "session.state", { state: "running" });
      client.patchConversation(conv, { state: "active" });
      return t;
    })();
  await playScript(turn.ctx, script, { live: opts.live });
  if (script.jobs) {
    conv.jobs = [
      ...conv.jobs,
      ...script.jobs.map((j) => ({
        ...j,
        startedAt: j.startedAt ?? opts.at ?? Date.now(),
      })),
    ];
  }
  if (script.ask) {
    openAsk(client, conv, turn, script.ask);
    return;
  }
  if (script.hold) {
    turn.held = true;
    return;
  }
  completeTurn(client, conv, script, opts);
}

/** A held turn continues (the seeded working threads at demo open). */
export async function resumeTurn(
  client: DemoClient,
  conv: DemoConv,
  script: DemoScript,
): Promise<void> {
  if (!conv.turn || conv.turn.dead) return;
  conv.turn.held = false;
  await playTurn(client, conv, script, { live: true });
}

function openAsk(
  client: DemoClient,
  conv: DemoConv,
  turn: DemoTurn,
  spec: DemoAsk,
): void {
  const ask: Ask = {
    id: spec.id === "auto" ? `a-${++client.askCounter}` : spec.id,
    channelId: conv.conv.channelId,
    conversationId: conv.conv.id,
    turnId: turn.turnId,
    requestId: `req-${spec.id}`,
    request: spec.request,
    state: "open",
    createdAt: Date.now(),
  };
  turn.held = true;
  client.emit(conv, "request.opened", {
    turnId: turn.turnId,
    requestId: ask.requestId,
    request: ask.request,
  });
  conv.ask = { ask, spec, askSeq: conv.latestSeq };
  client.emit(conv, "session.state", { state: "waiting" });
  client.asks.set([...client.asks.get(), ask]);
  client.fire("ask.opened", { channelId: conv.conv.channelId, ask });
}

/** `asks.respond` — resolve the open ask, then play whichever branch the
      outcome picked (approve/deny/change). */
export async function respondToAsk(
  client: DemoClient,
  askId: string,
  outcome: string,
  answer?: string,
): Promise<Ask> {
  const conv = [...client.convs.values()].find((c) => c.ask?.ask.id === askId);
  const held = conv?.ask;
  if (!conv || !held || !conv.turn) {
    throw new RelayError(`unknown ask ${askId}`, "not_found");
  }
  const resolved: Ask = {
    ...held.ask,
    state: "resolved",
    outcome: outcome as Ask["outcome"],
    ...(answer !== undefined ? { answer } : {}),
    resolvedAt: Date.now(),
  };
  conv.ask = undefined;
  client.asks.set(
    client.asks.get().map((a) => (a.id === askId ? resolved : a)),
  );
  client.emit(conv, "request.resolved", {
    requestId: held.ask.requestId,
    outcome,
    ...(answer !== undefined ? { answer } : {}),
  });
  client.fire("ask.resolved", {
    channelId: conv.conv.channelId,
    ask: resolved,
  });

  /* A plan "change" re-proposes instead of completing the turn. */
  if (held.spec.request.kind === "plan" && outcome === "change" && answer) {
    const next = nextPlanVersion(conv, answer);
    emitPlan(client, conv, conv.turn, next);
    openAsk(client, conv, conv.turn, {
      id: `a-plan-v${next.version}`,
      request: { kind: "plan", planId: next.planId },
      onApprove: held.spec.onApprove,
      onDeny: held.spec.onDeny,
    });
    return resolved;
  }

  const approved =
    outcome === "once" ||
    outcome === "always" ||
    outcome === "approve" ||
    outcome === "answer";
  const branch = approved ? held.spec.onApprove : held.spec.onDeny;
  if (branch) {
    conv.turn.held = false;
    await playTurn(client, conv, branch, { live: true });
  } else {
    completeTurn(client, conv, {}, { live: true });
  }
  return resolved;
}

/** Plan "change": fold the edit in as a new last step on a new version —
      the same shape the Mac's engine returns (prototype nextVersion). */
function nextPlanVersion(conv: DemoConv, answer: string) {
  const last = conv.events
    .filter((e) => e.type === "plan.updated" && e.payload.kind === "plan")
    .at(-1);
  const payload = last?.payload as
    | {
        planId: string;
        version: number;
        goal?: string;
        risks?: string[];
        steps: { text: string; files?: string[] }[];
      }
    | undefined;
  return {
    planId: `${payload?.planId ?? "plan-1"}-v${(payload?.version ?? 1) + 1}`,
    version: (payload?.version ?? 1) + 1,
    goal: payload?.goal,
    risks: payload?.risks,
    steps: [
      ...(payload?.steps ?? []).map((s) => ({
        ...s,
        status: "pending" as const,
      })),
      { text: answer, status: "pending" as const },
    ],
  };
}

function emitPlan(
  client: DemoClient,
  conv: DemoConv,
  turn: DemoTurn,
  plan: {
    planId: string;
    version: number;
    goal?: string;
    risks?: string[];
    steps: { text: string; files?: string[]; status: string }[];
  },
): void {
  client.emit(conv, "plan.updated", {
    turnId: turn.turnId,
    planId: plan.planId,
    kind: "plan",
    version: plan.version,
    ...(plan.goal !== undefined ? { goal: plan.goal } : {}),
    ...(plan.risks !== undefined ? { risks: plan.risks } : {}),
    steps: plan.steps,
  });
}

function completeTurn(
  client: DemoClient,
  conv: DemoConv,
  script: DemoScript,
  opts: { live: boolean; at?: number },
): void {
  const turn = conv.turn;
  if (!turn) return;
  /* The open turn clears before the closing events emit — the feed's
       snapshot reads it for `state`, so a stale pointer would leave the
       session "running" forever. */
  conv.turn = undefined;
  if (script.pr) conv.prs = [script.pr, ...conv.prs];
  conv.conv = {
    ...conv.conv,
    state: "idle",
    ...(script.usage ? { usage: script.usage } : {}),
  };
  client.emit(conv, "turn.completed", {
    turnId: turn.turnId,
    stopReason: "end_turn",
    ...(script.usage ? { usage: script.usage } : {}),
  });
  client.emit(conv, "session.state", { state: "idle" });
  if (script.text) {
    client.postMessage(conv.conv.channelId, {
      text: script.text,
      authorId: employeeOf(client, conv),
      authorKind: "employee",
      conversationId: conv.conv.id,
      model: conv.conv.model,
      provider: conv.conv.provider,
      effort: conv.conv.effort,
      fast: conv.conv.fast,
      createdAt: opts.at,
    });
  }
  if (script.wb) {
    client.fire("workbench.opened", {
      channelId: conv.conv.channelId,
      conversationId: conv.conv.id,
      target: script.wb,
    });
  }
  client.patchConversation(conv, { state: "idle" });
  /* Messages queued mid-turn get claimed as the next turn's prompt. */
  claimQueued(client, conv);
}

/** The employee answering a conversation — its channel's employee. */
function employeeOf(client: DemoClient, conv: DemoConv): string {
  const ch = client.channels.get().find((c) => c.id === conv.conv.channelId);
  return ch?.employeeId ?? "builder";
}

/** Claim queued user messages (one turn per queued message, in order). */
export function claimQueued(client: DemoClient, conv: DemoConv): void {
  const next = conv.queued.shift();
  if (!next) return;
  conv.conv = { ...conv.conv, deliveredSeq: next.seq };
  void playTurn(
    client,
    conv,
    conv.conv.id === SLEEP_THREAD
      ? SLEEP_FIX_TURN
      : followUpScript(next.text, conv.conv.cwd),
    { live: true },
  );
}
