import type * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  EngineEvent,
  EngineEventType,
  McpServer,
  PlanStep,
  PlanStepStatus,
  StopReason,
  Usage,
} from "@lilos/contracts/engine";

/**
 * D-#764 — the one shared ACP -> LilOS-engine mapping. Every ACP runtime
 * (today `hermes acp` through engine-hermes; tomorrow `devin acp` and any
 * other agent through packages/engine-acp) translates its wire here: update
 * kinds -> engine events, permission requests -> `request.opened` asks,
 * initialize capabilities -> capability descriptors (capabilities.ts).
 * Nothing in this file may read an agent's identity to pick a mapping —
 * capabilities come only from what `initialize`/`session/new` advertise.
 * Not: per-vendor SDK adapters (D-#764), agent-name branches, or faking
 * features ACP lacks (rewind, workspace move stay absent — D-#19).
 */

/* Engine ContentBlock <-> ACP ContentBlock: the engine union is already the
   ACP shape (text + image only — D-#6 reserved the rest). */
export function toAcpContent(b: ContentBlock): acp.ContentBlock {
  if (b.type === "image")
    return { type: "image", data: b.data, mimeType: b.mimeType, uri: b.uri };
  return { type: "text", text: b.text };
}

export function toAcpMcp(m: McpServer): acp.McpServer {
  if ("type" in m) {
    return {
      type: m.type,
      name: m.name,
      url: m.url,
      headers: m.headers,
    } as never;
  }
  return {
    name: m.name,
    command: m.command,
    args: m.args,
    env: m.env,
  } as never;
}

/** ACP plan-entry status -> contracts PlanStepStatus (ACP has none for cancelled). */
export function acpPlanStatus(status: string | undefined): PlanStepStatus {
  if (status === "in_progress") return "in_progress";
  if (status === "completed") return "completed";
  return "pending";
}

/**
 * The session surface `handleAcpUpdate` writes through. Both consumers
 * satisfy it with their own session object: engine-hermes's `Session`
 * (emit -> wire events + turn.phase bookkeeping) and this package's
 * `AcpSession`. `turn.plan` is the per-turn plan snapshot counter (#180).
 */
export interface AcpSessionView {
  emit(type: EngineEventType, payload: EngineEvent["payload"]): void;
  turn?: {
    turnId: string;
    phase: "reasoning" | "tools" | "text" | "waiting";
    plan?: { planId: string; version: number };
  };
  readonly lastTurnId: string;
  usage: Usage | undefined;
}

/**
 * Agent-specific extension points the shared update map leaves open —
 * engine-hermes layers subagent synthesis, terminal tracking and
 * `_meta.hermes.sessionProvenance` on top through these hooks without a
 * per-agent branch inside the map itself.
 */
export interface AcpUpdateHooks<S extends AcpSessionView = AcpSessionView> {
  /** A `tool_call` update after tool.started was emitted. */
  onToolCall?(
    s: S,
    u: Record<string, unknown>,
    ctx: { callId: string; tool: string; input: Record<string, unknown> },
  ): void;
  /** A `tool_call_update` after tool.completed was emitted. */
  onToolCallUpdate?(
    s: S,
    u: Record<string, unknown>,
    ctx: {
      callId: string;
      tool: string;
      status: "completed" | "failed";
      out: unknown;
    },
  ): void;
  /** `session_info_update` — raw `_meta` for agent-provenance handling. */
  onSessionInfo?(s: S, u: Record<string, unknown>): void;
  /** `current_mode_update` — the agent changed the session mode itself. */
  onModeUpdate?(s: S, currentModeId: string): void;
  /** `config_option_update` — the agent pushed a new config value. */
  onConfigUpdate?(s: S, option: acp.SessionConfigOption): void;
  /** `available_commands_update` — the agent's slash command surface changed. */
  onCommandsUpdate?(s: S, commands: unknown[]): void;
  /** `plan_update` / `plan_removed` — v1.26 lifecycle kinds beyond `plan`. */
  onPlanUpdate?(s: S, u: Record<string, unknown>): void;
  /** `compaction_update` / `compaction_summary_chunk`. */
  onCompaction?(s: S, u: Record<string, unknown>): void;
  /** `notice` — agent free-text surfaced to the client. */
  onNotice?(s: S, u: Record<string, unknown>): void;
}

const textOf = (c: unknown): string =>
  typeof (c as { text?: unknown })?.text === "string"
    ? (c as { text: string }).text
    : "";

const toolName = (u: Record<string, unknown>): string =>
  (typeof u.name === "string" && u.name) ||
  (typeof u.title === "string" && u.title) ||
  "tool";

const int = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;

/**
 * One `session/update` notification -> engine events on `s`. The map is
 * complete for the pinned v1 surface: known kinds emit their events (or
 * run their hook), unknown kinds are dropped so a newer agent never breaks
 * an older map (D-#764 — capability honesty lives in describe, not here).
 */
export function handleAcpUpdate<S extends AcpSessionView>(
  s: S,
  n: acp.SessionNotification,
  hooks?: AcpUpdateHooks<S>,
): void {
  const u = n.update as Record<string, unknown>;
  const turnId = s.turn?.turnId ?? s.lastTurnId;
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(u.content);
      if (text) s.emit("turn.delta", { turnId, stream: "text", delta: text });
      if (s.turn) s.turn.phase = "text";
      break;
    }
    case "agent_thought_chunk": {
      const text = textOf(u.content);
      if (text)
        s.emit("turn.delta", { turnId, stream: "reasoning", delta: text });
      if (s.turn) s.turn.phase = "reasoning";
      break;
    }
    case "tool_call": {
      if (s.turn) s.turn.phase = "tools";
      const callId = String(u.toolCallId ?? "");
      const tool = toolName(u);
      const input =
        typeof u.rawInput === "object" && u.rawInput !== null
          ? (u.rawInput as Record<string, unknown>)
          : {};
      s.emit("tool.started", { turnId, toolCallId: callId, tool, input });
      hooks?.onToolCall?.(s, u, { callId, tool, input });
      break;
    }
    case "tool_call_update": {
      const status = u.status;
      if (status !== "completed" && status !== "failed") break;
      const out = u.rawOutput;
      const callId = String(u.toolCallId ?? "");
      const tool = toolName(u);
      s.emit("tool.completed", {
        turnId,
        toolCallId: callId,
        tool,
        status,
        ...(out !== undefined && out !== null
          ? {
              output:
                typeof out === "string"
                  ? out
                  : JSON.stringify(out).slice(0, 4000),
            }
          : {}),
      });
      hooks?.onToolCallUpdate?.(s, u, { callId, tool, status, out });
      break;
    }
    /* #180: ACP `plan` updates carry the agent's working list as a full
       snapshot per update — kind:"tasks" on a stable per-turn planId, and
       unfinished steps read cancelled via turn.completed on the client. */
    case "plan": {
      if (!s.turn) break;
      const entries = u.entries as
        | { content?: string; status?: string }[]
        | undefined;
      if (!entries?.length) break;
      const plan = s.turn.plan ?? { planId: `plan-${turnId}`, version: 0 };
      s.turn.plan = plan;
      plan.version += 1;
      const steps: PlanStep[] = entries.map((e) => ({
        text: e.content ?? "",
        status: acpPlanStatus(e.status),
      }));
      s.emit("plan.updated", {
        turnId,
        planId: plan.planId,
        kind: "tasks",
        version: plan.version,
        steps,
      });
      break;
    }
    case "usage_update": {
      /* ACP `used`/`size` are the CURRENT occupancy and the window —
         the meter's numerator/denominator (#415), not per-turn counts.
         A malformed value must not clobber the last good reading. */
      const used = int(u.used);
      const size = int(u.size);
      if (used !== undefined || (size !== undefined && size > 0)) {
        const prev = s.usage ?? { input: 0, output: 0, reasoning: 0, cache: 0 };
        s.usage = {
          ...prev,
          ...(used !== undefined ? { context: used } : {}),
          ...(size !== undefined && size > 0 ? { contextWindow: size } : {}),
        };
      }
      break;
    }
    case "session_info_update":
      hooks?.onSessionInfo?.(s, u);
      break;
    case "current_mode_update": {
      const modeId = typeof u.currentModeId === "string" ? u.currentModeId : "";
      if (modeId) hooks?.onModeUpdate?.(s, modeId);
      break;
    }
    case "config_option_update":
      hooks?.onConfigUpdate?.(s, u as unknown as acp.SessionConfigOption);
      break;
    case "available_commands_update": {
      const commands = Array.isArray(u.availableCommands)
        ? (u.availableCommands as unknown[])
        : [];
      hooks?.onCommandsUpdate?.(s, commands);
      break;
    }
    case "plan_update":
    case "plan_removed":
      hooks?.onPlanUpdate?.(s, u);
      break;
    case "compaction_update":
    case "compaction_summary_chunk":
      hooks?.onCompaction?.(s, u);
      break;
    case "notice":
      hooks?.onNotice?.(s, u);
      break;
    default:
      /* `user_message_chunk` (the client's own echo) and anything newer than
         the pin — ignored. */
      break;
  }
}

/**
 * ACP `session/prompt` stopReason strings are the engine's StopReason
 * values verbatim; unknown values degrade to end_turn rather than crash
 * the turn.
 */
export function acpStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return reason;
    default:
      return "end_turn";
  }
}

/**
 * Fold one prompt response's PER-TURN token counts into the session's
 * lifetime Usage sums (#415) — the occupancy/window live on usage_update
 * ticks and are carried through untouched.
 */
export function acpTurnUsage(
  prev: Usage | undefined,
  usage:
    | {
        inputTokens?: number | null;
        outputTokens?: number | null;
        thoughtTokens?: number | null;
        cachedReadTokens?: number | null;
      }
    | null
    | undefined,
): Usage | undefined {
  if (!usage) return prev;
  const i = (v: number | null | undefined) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
  return {
    input: (prev?.input ?? 0) + i(usage.inputTokens),
    output: (prev?.output ?? 0) + i(usage.outputTokens),
    reasoning: (prev?.reasoning ?? 0) + i(usage.thoughtTokens),
    cache: (prev?.cache ?? 0) + i(usage.cachedReadTokens),
    ...(prev?.context !== undefined ? { context: prev.context } : {}),
    ...(prev?.contextWindow !== undefined
      ? { contextWindow: prev.contextWindow }
      : {}),
  };
}
