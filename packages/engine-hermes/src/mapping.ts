import type {
  ApprovalOption,
  ApprovalOutcome,
  EngineRequest,
  JobStatus,
  QuestionRequest,
  StopReason,
  Usage,
} from "@lilos/contracts/engine";

/**
 * Pure mapping between Hermes wire shapes (tui_gateway/contracts/*) and the
 * LilOS engine protocol (contracts/src/engine/*). Everything here is
 * side-effect free so unit tests pin the conversion without a live server.
 */

/** Hermes `Usage` (common.py) -> protocol `Usage`. */
export function mapUsage(u: unknown): Usage | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  const r = u as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && v >= 0 ? v : 0);
  /* `context_max` is the window Hermes resolved for THIS session (the
     compressor's context_length — config pins and provider probing already
     folded in), reported only once the compressor is live (#294). */
  const contextWindow = n(r.context_max);
  return {
    input: n(r.input) || n(r.prompt),
    output: n(r.output) || n(r.completion),
    reasoning: n(r.reasoning),
    cache: n(r.cache_read) + n(r.cache_write),
    ...(contextWindow > 0 ? { contextWindow } : {}),
  };
}

/** Hermes `TurnStatus` -> protocol `StopReason`. */
export function mapStopReason(status: unknown): {
  stopReason: StopReason;
  error?: string;
} {
  switch (status) {
    case "interrupted":
      return { stopReason: "cancelled" };
    case "error":
      return { stopReason: "refusal" };
    default:
      return { stopReason: "end_turn" };
  }
}

/**
 * Hermes `ApprovalRequestParams` -> LilOS `approval` request. Hermes offers
 * `once|session|always|deny`; the protocol has no session-scoped grant, so
 * `session` is dropped from the offered options (a client picking "always"
 * is still honored — Hermes treats always as the wider grant).
 */
export function mapApprovalParams(
  params: Record<string, unknown>,
): EngineRequest | undefined {
  const command = typeof params.command === "string" ? params.command : "";
  const description =
    typeof params.description === "string" && params.description
      ? params.description
      : undefined;
  const raw = Array.isArray(params.choices) ? params.choices : [];
  const options: ApprovalOption[] = [];
  for (const c of raw) {
    if (c === "once" || c === "always" || c === "deny") options.push(c);
    // "session" has no protocol equivalent — not offered to the client.
  }
  if (options.length === 0) options.push("once", "deny");
  const request: EngineRequest = {
    kind: "approval",
    command: command || "command",
    ...(description ? { description } : {}),
    options,
  };
  return request;
}

export interface MappedQuestion {
  /** Hermes `qid` (batch) or "" for the single-question form. */
  qid: string;
  request: QuestionRequest;
}

/**
 * Hermes `ClarifyRequestParams` -> one LilOS `question` request per qid.
 * Single-question clarifies get a synthetic qid ("") that maps back to the
 * `{answer}` result form; batches map to `{answers:{qid:...}}`.
 */
export function mapClarifyParams(
  params: Record<string, unknown>,
): MappedQuestion[] {
  const out: MappedQuestion[] = [];
  const toRequest = (
    question: string,
    choices: unknown,
    multi: unknown,
  ): QuestionRequest => {
    const list = Array.isArray(choices)
      ? choices.filter((c): c is string => typeof c === "string")
      : [];
    const req: QuestionRequest = {
      kind: "question",
      question,
      ...(list.length
        ? {
            options: list.map((label) => ({ id: label, label })),
            ...(multi === true ? {} : {}),
          }
        : { freeText: true }),
    };
    return req;
  };
  const batch = Array.isArray(params.questions) ? params.questions : null;
  if (batch) {
    for (const q of batch) {
      if (typeof q !== "object" || q === null) continue;
      const qq = q as Record<string, unknown>;
      if (typeof qq.qid !== "string" || typeof qq.question !== "string")
        continue;
      out.push({
        qid: qq.qid,
        request: toRequest(qq.question, qq.choices, qq.multi_select),
      });
    }
  }
  if (typeof params.question === "string" && params.question) {
    out.push({
      qid: "",
      request: toRequest(params.question, params.choices, params.multi_select),
    });
  }
  return out;
}

/** LilOS approval outcome -> Hermes `ApprovalResult`. cancel maps to deny. */
export function approvalOutcomeToResult(outcome: ApprovalOutcome): {
  choice: string;
} {
  switch (outcome) {
    case "once":
      return { choice: "once" };
    case "always":
      return { choice: "always" };
    case "deny":
    case "cancel":
      return { choice: "deny" };
    default:
      return { choice: "deny" };
  }
}

/* ── #179: subagent.* / process.* wire shapes ─────────────────────────────── */

/** Hermes `SubagentStatus` -> protocol subagent.completed status. */
export function mapSubagentStatus(
  status: unknown,
): "done" | "failed" | "stopped" {
  switch (status) {
    case "interrupted":
      return "stopped";
    case "failed":
    case "error":
    case "timeout":
      return "failed";
    default:
      return "done"; // completed + anything unrecognized
  }
}

/** First localhost URL in text — a dev server/banner URL for the job row. */
export function firstLocalUrl(text: string): string | undefined {
  const m =
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/?/i.exec(text);
  return m?.[0];
}

/** `process.list` row status+completion_reason -> protocol JobStatus. */
export function mapProcessStatus(row: Record<string, unknown>): JobStatus {
  if (row.status === "running") return "running";
  switch (row.completion_reason) {
    case "killed":
      return "stopped";
    case "failed_start":
      return "failed";
    default:
      return "exited"; // exited | lost | already_exited
  }
}

/** A tool result that may arrive as a JSON string or an object. */
export function parseToolResultJson(
  result: unknown,
): Record<string, unknown> | undefined {
  let r = result;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return undefined;
    }
  }
  return typeof r === "object" && r !== null
    ? (r as Record<string, unknown>)
    : undefined;
}

/** Any stable key a subagent.* frame can offer (SubagentEventPayload). */
export function subagentKey(p: Record<string, unknown>): string | undefined {
  const id = p.subagent_id ?? p.child_session_id;
  if (id !== undefined && id !== null && String(id)) return String(id);
  const idx = typeof p.task_index === "number" ? p.task_index : undefined;
  if (idx === undefined) return undefined;
  return `${String(p.delegation_id ?? p.parent_id ?? "d")}:${idx}`;
}

/** Tool completion status: hermes result fields -> protocol status. */
export function mapToolStatus(payload: Record<string, unknown>): {
  status: "completed" | "failed" | "denied" | "cancelled";
  output?: string;
  diff?: {
    path: string;
    status: "added" | "modified" | "deleted";
    add: number;
    del: number;
    patch?: string;
  };
} {
  const result = payload.result;
  let status: "completed" | "failed" | "denied" | "cancelled" = "completed";
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;
    if (r.error || r.success === false) status = "failed";
    if (r.denied === true || r.approved === false) status = "denied";
  }
  const output =
    typeof payload.result_text === "string"
      ? payload.result_text
      : typeof payload.summary === "string"
        ? payload.summary
        : result === undefined || result === null
          ? undefined
          : typeof result === "string"
            ? result
            : JSON.stringify(result).slice(0, 4000);
  let diff:
    | {
        path: string;
        status: "added" | "modified" | "deleted";
        add: number;
        del: number;
        patch?: string;
      }
    | undefined;
  if (typeof payload.inline_diff === "string" && payload.inline_diff) {
    diff = {
      path: typeof payload.path === "string" ? payload.path : "(inline)",
      status: "modified",
      add: 0,
      del: 0,
      patch: payload.inline_diff,
    };
  }
  return {
    status,
    ...(output !== undefined ? { output } : {}),
    ...(diff ? { diff } : {}),
  };
}
