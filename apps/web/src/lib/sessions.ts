/**
 * The cross-employee Sessions view's derivation: every conversation summary
 * becomes one row, grouped by the same running/needs-you rules the
 * per-employee sidebar badges use (a badge count and a group count can never
 * disagree because they are the same computation). "Recently finished" lists
 * unread first — the read watermark (readSeq/finishedSeq) says which.
 *
 * Live rows come from `sessionModels`/`sessionSignals` — running sessions
 * carry their current tool step, waiting sessions carry their open ask.
 */
import type { SessionModel, TurnStep } from "@lilos/client-runtime";
import type {
  AppChannel,
  Conversation,
  ConversationSummary,
  Employee,
} from "@lilos/contracts/app";
import type { SessionGroups, SessionRowVm } from "@lilos/ui";
import { sessionBadge } from "./badges";
import type { SessionSignal } from "./session-watch";

interface RowInput {
  row: SessionRowVm;
  last: number;
  c: Conversation;
  m?: SessionModel;
  sig?: SessionSignal;
}

/* The one argument worth showing on a running step — the same pick the
   thread's step rows make: a path, a command, a query. */
function stepLine(s: TurnStep): string {
  const arg =
    (s.input.path as string | undefined) ??
    (s.input.command as string | undefined) ??
    (s.input.query as string | undefined) ??
    (s.input.url as string | undefined);
  const head = arg ? `${s.tool} ${arg}` : s.tool;
  return head.length > 80 ? `${head.slice(0, 79)}…` : head;
}

/* "the current tool step" — the newest step still running, else the newest
   step at all (a turn between tool calls still says where it is). */
function liveStep(m: SessionModel | undefined): string | undefined {
  const steps = m?.live?.steps;
  if (!steps?.length) return undefined;
  return stepLine(
    steps.findLast((s) => s.status === "running") ?? steps.at(-1)!,
  );
}

/* What a needs-you row is waiting on — the first open request, phrased like
   the ask cards ("Approve: <command>" / the question / "Plan review"). */
function waitingOn(
  m: SessionModel | undefined,
  sig: SessionSignal | undefined,
): string | undefined {
  const req =
    m?.openRequests[0]?.request ?? sig?.openRequests.values().next().value;
  if (!req) return undefined;
  if (req.kind === "question")
    return `Question: ${req.question ?? ""}`.trimEnd();
  if (req.kind === "plan") return "Plan review";
  const cmd = req.command ? `: ${req.command}` : "";
  return `Approve${cmd}`;
}

export function sessionRows(args: {
  summaries: ConversationSummary[];
  channels: AppChannel[];
  employees: Employee[];
  models: Record<string, SessionModel>;
  signals: Record<string, SessionSignal>;
  /** Clock-format function the caller supplies (tested label, no wall time). */
  formatTime: (ts: number) => string;
}): SessionGroups {
  const { summaries, channels, employees, models, signals, formatTime } = args;
  const empByChannel = new Map(
    channels
      .filter((c) => c.kind === "dm")
      .map((c) => [c.id, c.employeeId] as const),
  );
  const empName = new Map(employees.map((e) => [e.id, e.name] as const));
  const needsYou: RowInput[] = [];
  const running: RowInput[] = [];
  const finished: RowInput[] = [];
  for (const s of summaries) {
    const c = s.conversation;
    if (c.archived) continue;
    const employeeId = empByChannel.get(c.channelId);
    if (!employeeId) continue;
    const m = c.engineRef ? models[c.engineRef] : undefined;
    const sig = c.engineRef ? signals[c.engineRef] : undefined;
    /* The same per-conversation fold the sidebar badges and the ⌘K
       switcher read — a badge count and a group count can never disagree
       because they are the same computation. */
    const { asks, running: run } = sessionBadge(c, models, signals);
    const last = s.last.createdAt;
    const base: SessionRowVm = {
      id: c.id,
      employeeId,
      employeeName: empName.get(employeeId) ?? "Employee",
      title: c.title || s.root.text.trim() || "Untitled",
      folder: c.cwd,
      when: formatTime(last),
      state: "done",
      unread: c.finishedSeq > c.readSeq,
    };
    const input: RowInput = { row: base, last, c, m, sig };
    if (asks > 0) {
      input.row = {
        ...base,
        state: "needs you",
        live: waitingOn(m, sig),
        unread: false,
      };
      needsYou.push(input);
    } else if (run) {
      input.row = {
        ...base,
        state: "running",
        live: liveStep(m),
        unread: false,
      };
      running.push(input);
    } else {
      const lastTurn = m?.turns.at(-1);
      const state: SessionRowVm["state"] =
        c.turnFailure || lastTurn?.phase === "failed"
          ? "failed"
          : c.turnStopped || lastTurn?.phase === "stopped"
            ? "stopped"
            : "done";
      input.row = { ...base, state };
      finished.push(input);
    }
  }
  /* Needs you = longest waiting first (the one asking longest is the one to
     unblock). Running + finished = newest activity first; finished puts the
     unread ("done since you last looked") ahead of the read. */
  needsYou.sort((a, b) => a.last - b.last);
  running.sort((a, b) => b.last - a.last);
  finished.sort(
    (a, b) =>
      Number(b.row.unread) - Number(a.row.unread) || b.last - a.last,
  );
  return {
    needsYou: needsYou.map((i) => i.row),
    running: running.map((i) => i.row),
    finished: finished.map((i) => i.row),
  };
}
