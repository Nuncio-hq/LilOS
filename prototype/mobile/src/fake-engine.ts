import type {
  AgentEntry,
  Approval,
  DmMessageHit,
  EmployeeRow,
  OrbState,
  ProjectGroup,
  PullRequestRef,
  SessionTurn,
  SubagentRow,
  ThreadDetail,
  ThreadEntry,
  ToolStep,
  WorkspacePick,
} from "@lilos/ui-native";
import { atom, computed } from "nanostores";
import { nextVersion, PLAN_THREADS, workFor } from "./fake-plan";
import {
  SLEEP_FIX,
  SLEEP_THREAD,
  SUBAGENT_THREADS,
  type SubagentSpec,
} from "./fake-subagents";
import {
  $folders,
  APPROVALS,
  EMPLOYEES,
  IDLE_NOW,
  PROJECTS,
  THREADS,
} from "./fake-team";

/* The prototype's fake engine: the mobile twin of the web prototype's
   runTurn (prototype/web/src/App.tsx). Canned turns play out on a clock —
   reasoning streams word by word, each tool call runs then lands its
   output, the reply streams, and approvals arrive and resolve — so the
   screens show real behaviour (spinning orbs, live steps, the dock filling
   and emptying). Real app: relay events over the socket. Mock data, not a
   contract. */

// ── Store ───────────────────────────────────────────────────────────────────

/* The context breakdown behind each thread's "44.9k in · 3.3k out · 31k
   cached" line: reasoning is a share of the output; Opus has a 200k window. */
const n = (x?: string) => (x ? Number.parseFloat(x) * 1000 : 0);
const withContext = (t: ThreadDetail): ThreadDetail => {
  const m = /([\d.]+)k in · ([\d.]+)k out · ([\d.]+)k cached/.exec(
    t.usage ?? "",
  );
  if (!m) return t;
  const output = n(m[2]);
  return {
    ...t,
    context: {
      input: n(m[1]),
      output,
      reasoning: Math.round(output * 0.4),
      cache: n(m[3]),
      // The mock's in+out IS its live occupancy — real engines report it as
      // `context` (#415).
      context: n(m[1]) + output,
      max: t.model.startsWith("Qwen") ? 262_000 : 200_000,
    },
  };
};
const SEED = [...THREADS, ...SUBAGENT_THREADS, ...PLAN_THREADS].map(
  withContext,
);
export const $threads = atom<ThreadDetail[]>(SEED);

/* #344: idle threads whose engine session was closed (> 30 min idle). */
const MOCK_LIFE: Record<string, "open" | "closed"> = {
  "s-gap": "closed",
  "s-inbox": "closed",
};

/** Order approvals were asked in (oldest first → the dock shows the oldest). */
const ASKED = ["a-flake", "a-post", "q-base"];
const asked = atom<string[]>(ASKED);

/** Every pending approval, read off the sessions so both always agree. */
export const $approvals = computed([$threads, asked], (threads, order) => {
  const all = threads.flatMap((t) =>
    t.entries.flatMap((e) =>
      e.kind === "agent" && e.approval ? [e.approval] : [],
    ),
  );
  return all.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
});

const VERB: Record<string, string> = {
  terminal: "$",
  read_file: "Reading",
  write_file: "Writing",
  patch: "Editing",
  search_files: "Searching",
  web_search: "Searching the web for",
  email: "Mail:",
  x_post: "Posting",
};

function liveLine(t: ThreadDetail) {
  const last = t.entries[t.entries.length - 1];
  if (last?.kind !== "agent" || !last.live) return undefined;
  const run = last.steps?.find((s) => s.running);
  if (run) return `${VERB[run.tool] ?? run.tool} ${run.arg ?? ""}`.trim();
  if (last.thought === undefined) return "Thinking…";
  return "Writing the reply…";
}

export const $employees = computed($threads, (threads): EmployeeRow[] =>
  EMPLOYEES.map((e) => {
    const mine = threads.filter((t) => t.employee.id === e.id);
    const asks = mine
      .flatMap((t) => t.entries)
      .filter((x): x is AgentEntry => x.kind === "agent" && !!x.approval)
      .map((x) => x.approval);
    const ask = asks[0];
    const live = mine.find((t) => t.state === "working");
    const state: OrbState = ask ? "needs-you" : live ? "working" : "idle";
    const fresh = [...mine].reverse().find((t) => t.when === "now");
    return {
      ...e,
      state,
      ticket: state === "idle" ? undefined : e.ticket,
      when: ask ? ask.age : live || fresh ? "now" : e.when,
      // Several threads waiting: the count is what sends you into the DM.
      now: ask
        ? asks.length > 1
          ? `${asks.length} need you`
          : `Waiting on you · ${ask.session}`
        : live
          ? (liveLine(live) ?? live.title)
          : fresh
            ? `Done · ${fresh.title}`
            : (IDLE_NOW[e.id] ?? ""),
    };
  }),
);

/** #engineering shows Builder's orb + dots only while Builder is at work. */
export const $projects = computed($employees, (emps): ProjectGroup[] => {
  const busy = emps.find((e) => e.id === "builder")?.state === "working";
  return PROJECTS.map((p) => ({
    ...p,
    channels: p.channels.map((c) =>
      c.id === "lilos-eng"
        ? { ...c, activeTone: busy ? ("blue" as const) : undefined }
        : c,
    ),
  }));
});

/** One employee's DM: each session summarised as a card. */
export function turnsOf(threads: ThreadDetail[], employeeId: string) {
  return threads
    .filter((t) => t.employee.id === employeeId)
    .map((t): SessionTurn => {
      const agents = t.entries.filter(
        (e): e is AgentEntry => e.kind === "agent",
      );
      const steps = agents.flatMap((a) => a.steps ?? []);
      const edits = steps.filter((s) => s.add !== undefined);
      return {
        id: t.id,
        prompt: t.entries[0]?.kind === "user" ? t.entries[0].text : t.title,
        title: t.title,
        state: t.state,
        when: t.when,
        folder: t.folder?.name,
        branch: t.branch?.name,
        added: edits.length
          ? edits.reduce((n, s) => n + (s.add ?? 0), 0)
          : undefined,
        removed: edits.reduce((n, s) => n + (s.del ?? 0), 0),
        replies: t.entries.length - 1,
        // #344 mock: working (incl. a running subagent) = running; else the
        // thread's mock life, open by default.
        life:
          t.state === "working" ||
          agents.some((a) => a.subagents?.some((s) => s.status === "running"))
            ? "running"
            : (MOCK_LIFE[t.id] ?? "open"),
        preview: [...agents].reverse().find((a) => a.text)?.text,
        live: liveLine(t),
        approval: agents.find((a) => a.approval)?.approval,
        prs: t.prs,
      };
    });
}

function mapThread(id: string, f: (t: ThreadDetail) => ThreadDetail) {
  $threads.set($threads.get().map((t) => (t.id === id ? f(t) : t)));
}
function mapEntry(tid: string, eid: string, f: (e: AgentEntry) => AgentEntry) {
  mapThread(tid, (t) => ({
    ...t,
    entries: t.entries.map((e) =>
      e.kind === "agent" && e.id === eid ? f(e) : e,
    ),
  }));
}

// ── The turn runner ─────────────────────────────────────────────────────────

type StepSpec = Omit<ToolStep, "id" | "running"> & { ms?: number };
type Script = {
  reasoning?: string;
  steps?: StepSpec[];
  text?: string;
  /** #555: the turn dies on this error after its steps (a failed turn
     gets the failure card with Retry, like the Mac's #419). */
  fail?: string;
  /** Ends the turn blocked on you instead of done. */
  approval?: Omit<Approval, "age">;
  /** Runs when that approval is approved / denied. */
  onApprove?: Script;
  onDeny?: Script;
  /** #420: a question ask's continuation — the answered text/id in, the
      next script out (a question can't be approved, only answered or
      cancelled → onDeny is its cancel path). */
  onAnswer?: (answer: string) => Script;
  /** A PR this turn opens (added to the session when the turn ends). */
  pr?: PullRequestRef;
  /** Helpers that run side by side after the steps (issue #170). */
  subagents?: SubagentSpec[];
  /** Step i ticks plan step i (issue #175): the entry holding the approved plan. */
  followPlan?: string;
};

/** Scripts waiting on an approval, by approval id. */
const pending = new Map<
  string,
  {
    tid: string;
    eid: string;
    yes?: Script;
    no?: Script;
    answer?: (a: string) => Script;
  }
>();
/** Bumped by a reset: every running turn from an older generation stops writing. */
let gen = 0;
const stops = new Set<string>();

const now = () => {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const uid = () => Math.random().toString(36).slice(2, 8);
class Stopped extends Error {}
/** #555: an engine error the turn dies on (mock of turn.completed.error). */
class Failed extends Error {}

/** Play one turn. With `eid`, continue that entry (after an approval). */
async function run(tid: string, s: Script, eid?: string) {
  const g = gen;
  const id = eid ?? `g-${uid()}`;
  let dead = false;
  const tick = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
    if (g !== gen) throw new Stopped("reset");
    if (dead || stops.has(tid)) throw new Stopped("stop");
  };
  stops.delete(tid);
  mapThread(tid, (t) => ({
    ...t,
    state: "working",
    when: "now",
    entries: eid
      ? t.entries
      : [
          ...t.entries,
          {
            kind: "agent",
            id,
            time: now(),
            live: true,
            ...(s.reasoning ? { reasoning: "" } : {}),
          },
        ],
  }));
  if (eid)
    mapEntry(tid, id, (e) => ({
      ...e,
      live: true,
      writing: false,
      approval: undefined,
    }));
  const started = Date.now();
  const set = (f: (e: AgentEntry) => AgentEntry) => mapEntry(tid, id, f);
  try {
    await tick(700);
    if (s.reasoning && !eid) {
      const t0 = Date.now();
      for (const w of s.reasoning.split(/(?<=\s)/)) {
        await tick(38);
        set((e) => ({ ...e, reasoning: (e.reasoning ?? "") + w }));
      }
      await tick(350);
      set((e) => ({
        ...e,
        thought: Math.max(1, Math.round((Date.now() - t0) / 1000)),
      }));
    } else if (!eid) set((e) => ({ ...e, thought: 1 }));
    const planStep = (i: number, status: PlanStatus) =>
      s.followPlan &&
      mapEntry(tid, s.followPlan, (e) =>
        e.plan
          ? {
              ...e,
              plan: {
                ...e.plan,
                steps: e.plan.steps.map((x, j) =>
                  j === i ? { ...x, status } : x,
                ),
              },
            }
          : e,
      );
    for (const [i, { ms, ...st }] of (s.steps ?? []).entries()) {
      planStep(i, "in_progress");
      const sid = uid();
      set((e) => ({
        ...e,
        steps: [
          ...(e.steps ?? []),
          {
            ...st,
            id: sid,
            output: undefined,
            add: undefined,
            del: undefined,
            running: true,
          },
        ],
      }));
      await tick(ms ?? 900);
      set((e) => ({
        ...e,
        steps: (e.steps ?? []).map((x) =>
          x.id === sid ? { ...st, id: sid } : x,
        ),
      }));
      planStep(i, "completed");
    }
    if (s.fail) throw new Failed(s.fail);
    if (s.subagents?.length) await helpers(s.subagents, set, tick);
    if (s.text) {
      await tick(300);
      set((e) => ({ ...e, writing: true, text: "" }));
      for (const w of s.text.split(/(?<=\s)/)) {
        await tick(26);
        set((e) => ({ ...e, text: (e.text ?? "") + w }));
      }
    }
    await tick(250);
    const t = $threads.get().find((x) => x.id === tid);
    const [model, effort] = (t?.model ?? "")
      .replace(/^Claude /, "")
      .split(" · ");
    if (s.approval) {
      const a: Approval = { ...s.approval, age: "now" };
      asked.set([...asked.get().filter((x) => x !== a.id), a.id]);
      pending.set(a.id, {
        tid,
        eid: id,
        yes: s.onApprove,
        no: s.onDeny,
        answer: s.onAnswer,
      });
      set((e) => ({ ...e, live: false, writing: false, approval: a }));
      mapThread(tid, (x) => ({ ...x, state: "needs-you", when: "now" }));
    } else {
      set((e) => ({
        ...e,
        live: false,
        writing: false,
        footer: {
          dur: Math.round((Date.now() - started) / 1000) + (e.footer?.dur ?? 0),
          model,
          effort,
          files:
            new Set(
              [
                ...(e.steps ?? []),
                ...(e.subagents ?? []).flatMap((a) => a.steps),
              ]
                .filter((x) => x.add !== undefined)
                .map((x) => x.arg),
            ).size || undefined,
        },
      }));
      const pr = s.pr;
      mapThread(tid, (x) => ({
        ...x,
        state: "done",
        when: "now",
        prs: pr ? [...(x.prs ?? []), pr] : x.prs,
      }));
    }
  } catch (err) {
    dead = true;
    if (s.followPlan)
      mapEntry(tid, s.followPlan, (e) =>
        e.plan
          ? {
              ...e,
              plan: {
                ...e.plan,
                steps: e.plan.steps.map((x) =>
                  x.status === "in_progress"
                    ? { ...x, status: "cancelled" }
                    : x,
                ),
              },
            }
          : e,
      );
    if (err instanceof Failed && g === gen) {
      /* #555: the turn died on an engine error — the card keeps what it
         did, the failure line carries the reason, the thread reads
         "failed" (and the DM row reads the reason, #592). */
      set((e) => ({
        ...e,
        live: false,
        writing: false,
        failed: err.message,
        steps: e.steps?.map((x) => ({ ...x, running: false })),
        subagents: e.subagents?.map((a) =>
          a.status === "running"
            ? {
                ...a,
                status: "failed" as const,
                steps: a.steps.map((x) => ({ ...x, running: false })),
              }
            : a,
        ),
        footer: { dur: Math.round((Date.now() - started) / 1000) },
      }));
      mapThread(tid, (x) => ({
        ...x,
        state: "failed",
        when: "now",
        failure: { kind: "generic", text: err.message },
        /* #555: a send queued behind a turn that FAILED parks under Not
           sent exactly like a stopped one — it never ran. Without this
           the bubble reads "Queued · runs next" on a dead turn forever. */
        entries: x.entries.map((e) =>
          e.kind === "user" && e.queued
            ? { ...e, queued: undefined, waiting: undefined, notSent: true }
            : e,
        ),
      }));
      return;
    }
    if (!(err instanceof Stopped) || g !== gen) return;
    set((e) => ({
      ...e,
      live: false,
      writing: false,
      stopped: true,
      steps: e.steps?.map((x) => ({ ...x, running: false })),
      subagents: e.subagents?.map((a) =>
        a.status === "running"
          ? {
              ...a,
              status: "stopped",
              steps: a.steps.map((x) => ({ ...x, running: false })),
            }
          : a,
      ),
      footer: { dur: Math.round((Date.now() - started) / 1000) },
    }));
    mapThread(tid, (x) => ({
      ...x,
      state: "stopped",
      when: "now",
      /* #555: whatever was queued behind the turn never ran — it leaves
         the transcript and parks under Not sent until Send now / Remove
         (web: NotSentTray). */
      entries: x.entries.map((e) =>
        e.kind === "user" && e.queued
          ? { ...e, queued: undefined, waiting: undefined, notSent: true }
          : e,
      ),
    }));
    stops.delete(tid);
  }
  // A message you sent mid-turn runs next, as its own turn.
  if (g !== gen) return;
  const t = $threads.get().find((x) => x.id === tid);
  const q = t?.entries.find(
    (e): e is Extract<ThreadEntry, { kind: "user" }> =>
      e.kind === "user" && !!e.queued,
  );
  if (t && q && t.state !== "needs-you") {
    mapThread(tid, (x) => ({
      ...x,
      entries: x.entries.map((e) =>
        e.id === q.id ? { ...e, queued: false } : e,
      ),
    }));
    void run(tid, followUp(q.text, t));
  }
}

/* Subagents (issue #170): all start at once, each plays its steps on its
   own clock, then reports. An employee helper just works for `wait` ms —
   its steps live in its own thread. Resolves when every helper is done. */
async function helpers(
  specs: SubagentSpec[],
  set: (f: (e: AgentEntry) => AgentEntry) => void,
  tick: (ms: number) => Promise<void>,
) {
  set((e) => ({
    ...e,
    subagents: [
      ...(e.subagents ?? []),
      ...specs.map((sp) => ({
        id: sp.id,
        name: sp.name,
        task: sp.task,
        employee: sp.employee,
        status: "running" as const,
        steps: [],
      })),
    ],
  }));
  const setA = (aid: string, f: (a: SubagentRow) => SubagentRow) =>
    set((e) => ({
      ...e,
      subagents: e.subagents?.map((a) => (a.id === aid ? f(a) : a)),
    }));
  await Promise.all(
    specs.map(async (sp) => {
      const t0 = Date.now();
      await tick(sp.delay ?? 300);
      for (const { ms, ...st } of sp.steps) {
        const sid = uid();
        setA(sp.id, (a) => ({
          ...a,
          steps: [
            ...a.steps,
            {
              ...st,
              id: sid,
              output: undefined,
              add: undefined,
              del: undefined,
              running: true,
            },
          ],
        }));
        await tick(ms ?? 1200);
        setA(sp.id, (a) => ({
          ...a,
          steps: a.steps.map((x) => (x.id === sid ? { ...st, id: sid } : x)),
        }));
      }
      if (sp.wait) await tick(sp.wait);
      setA(sp.id, (a) => ({
        ...a,
        status: sp.ends ?? "done",
        result: sp.result,
        dur: Math.max(1, Math.round((Date.now() - t0) / 1000)),
      }));
    }),
  );
}

/** Background → Stop: the process ends, its log keeps the tail. */
export function stopJob(tid: string, jid: string) {
  mapThread(tid, (t) => ({
    ...t,
    jobs: t.jobs?.map((j) =>
      j.id === jid ? { ...j, status: "stopped", log: `${j.log}\n^C` } : j,
    ),
  }));
}

// ── What you can do ─────────────────────────────────────────────────────────

export function approve(id: string) {
  settle(id, true);
}
export function deny(id: string) {
  settle(id, false);
}
function settle(id: string, yes: boolean) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  const next = (yes ? p.yes : p.no) ?? {
    text: yes ? "Done." : "OK, I won't.",
  };
  mapEntry(p.tid, p.eid, (e) => ({
    ...e,
    approval: undefined,
    decided: {
      approved: yes,
      /* #420: a denied question ask is a *cancelled* question — the receipt
         wording branches on this flag. */
      question: e.approval?.kind === "question" ? true : undefined,
      what:
        e.approval?.command ??
        e.approval?.file?.name ??
        e.approval?.reason ??
        "",
    },
  }));
  void run(p.tid, next);
}

/* #420: a question ask's answer — the option's label or the typed text is
   what the receipt keeps (`what`), and the turn continues from the ask's
   `onAnswer` script (label in, so the reply can read naturally). */
export function answerAsk(id: string, answer: { label: string }) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  mapEntry(p.tid, p.eid, (e) => ({
    ...e,
    approval: undefined,
    decided: { approved: true, question: true, what: answer.label },
  }));
  void run(
    p.tid,
    p.answer?.(answer.label) ?? { text: `Noted — ${answer.label}.` },
  );
}

/** Stop the running turn (■). What it already did stays. */
export function stop(tid: string) {
  stops.add(tid);
}

/** #555: the Not-sent tray's Send now — the parked send delivers as its
    own turn (web: the tray's Send). */
export function sendNow(tid: string, entryId: string) {
  const t = $threads.get().find((x) => x.id === tid);
  const q = t?.entries.find(
    (e) => e.kind === "user" && e.id === entryId && e.notSent,
  );
  if (!t || !q || q.kind !== "user") return;
  mapThread(tid, (x) => ({
    ...x,
    entries: x.entries.map((e) =>
      e.id === entryId && e.kind === "user" ? { ...e, notSent: undefined } : e,
    ),
  }));
  void run(tid, followUp(q.text, t));
}

/** #555: the Not-sent tray's Remove — the parked send drops for good. */
export function removeNotSent(tid: string, entryId: string) {
  mapThread(tid, (x) => ({
    ...x,
    entries: x.entries.filter((e) => e.id !== entryId),
  }));
}

/** #555: the Undo toast's restore — the removed send parks back in its
    old transcript slot (still notSent — it returns to the tray, not the
    transcript). */
export function restoreNotSent(
  tid: string,
  entry: Extract<ThreadEntry, { kind: "user" }>,
  index: number,
) {
  mapThread(tid, (x) => {
    if (x.entries.some((e) => e.id === entry.id)) return x;
    const entries = [...x.entries];
    entries.splice(Math.min(index, entries.length), 0, entry);
    return { ...x, entries };
  });
}

/** #555: the failed turn's Retry — the same card runs again and recovers
    on the retry (the mock's deterministic "transient error" script).
    Web: the last turn's Retry (#419) replays the turn. */
export function retryTurn(tid: string) {
  const t = $threads.get().find((x) => x.id === tid);
  const failed = [...(t?.entries ?? [])]
    .reverse()
    .find((e): e is AgentEntry => e.kind === "agent" && e.failed !== undefined);
  if (!t || !failed) return;
  /* The card replays from scratch — its partial text and steps were the
     attempt that died. */
  mapEntry(tid, failed.id, (e) => ({
    ...e,
    failed: undefined,
    footer: undefined,
    reasoning: undefined,
    thought: undefined,
    steps: [],
    text: undefined,
  }));
  mapThread(tid, (x) => ({ ...x, failure: undefined }));
  void run(
    tid,
    {
      reasoning:
        "Same brief again — the engine came back, so the retry picks up where the attempt left off.",
      steps: [
        {
          tool: "terminal",
          arg: "bun run verify",
          output: "✓ all green (3.1s)",
          ms: 1400,
        },
      ],
      text: "Back on track — the retry ran clean and the turn completed. Nothing was lost; the earlier error was transient.",
    },
    failed.id,
  );
}

/** #555: message search inside one employee's DM (web: messages.search,
    #138). Case-insensitive substring over user + agent text; the hit's
    snippet is a window around the first match. */
export function searchDm(employeeId: string, query: string): DmMessageHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: DmMessageHit[] = [];
  for (const t of $threads.get()) {
    if (t.employee.id !== employeeId) continue;
    for (const e of t.entries) {
      if (e.kind !== "user" && e.kind !== "agent") continue;
      const text = e.text ?? "";
      const at = text.toLowerCase().indexOf(q);
      if (at < 0) continue;
      const start = Math.max(0, at - 36);
      const end = Math.min(text.length, at + q.length + 64);
      hits.push({
        threadId: t.id,
        threadTitle: t.title,
        entryId: e.id,
        from: e.kind === "user" ? "You" : t.employee.name,
        time: e.time,
        snippet: `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`,
        /* #555: the hit's own thread bolds this term on the scrolled row. */
        query: q,
      });
      if (hits.length >= 50) return hits;
    }
  }
  return hits;
}

/** A new session from a DM: it opens as a thread and starts working. */
export function startSession(
  employeeId: string,
  text: string,
  model: string,
  ws: WorkspacePick,
) {
  const emp = EMPLOYEES.find((e) => e.id === employeeId) ?? EMPLOYEES[0];
  const f = $folders.get().find((x) => x.id === ws.folder);
  const branch = f?.branches.length
    ? ws.mode === "existing"
      ? (ws.existing ?? ws.base)
      : ws.mode === "new"
        ? `ws/${slug(text)}`
        : ws.base
    : undefined;
  const id = `s-${uid()}`;
  $threads.set([
    ...$threads.get(),
    {
      id,
      title: text.length > 34 ? `${text.slice(0, 32).trimEnd()}…` : text,
      state: "working",
      employee: { id: emp.id, name: emp.name, tone: emp.tone },
      when: "now",
      started: `Today ${now()}`,
      folder: f ? { name: f.project, path: f.path } : undefined,
      branch: branch
        ? {
            name: branch,
            detail:
              ws.mode === "new"
                ? `new worktree off ${ws.base} · .lilos/wt/${slug(text)}`
                : ws.mode === "existing"
                  ? "existing workstream"
                  : "edits land directly",
          }
        : undefined,
      model,
      session: `ses_${uid().slice(0, 4)}`,
      entries: [{ kind: "user", id: `u-${uid()}`, time: now(), text }],
    },
  ]);
  void run(id, firstTurn(text, f?.path, branch, ws));
  return id;
}

/** Reply in a session. Mid-turn it queues and runs when this turn ends. */
export function reply(tid: string, text: string) {
  const t = $threads.get().find((x) => x.id === tid);
  if (!t) return;
  if (waitingPlan(t)) return changePlan(t, text);
  const busy = t.state === "working";
  mapThread(tid, (x) => ({
    ...x,
    entries: [
      ...x.entries,
      { kind: "user", id: `u-${uid()}`, time: now(), text, queued: busy },
    ],
  }));
  if (!busy) void run(tid, followUp(text, t));
}

// ── Plans (issue #175) ──────────────────────────────────────────────────────

type PlanStatus = NonNullable<AgentEntry["plan"]>["steps"][number]["status"];
const waitingPlan = (t: ThreadDetail) =>
  t.entries.find(
    (e): e is AgentEntry => e.kind === "agent" && e.plan?.status === "proposed",
  );
const setPlan = (
  tid: string,
  planId: string,
  f: (p: NonNullable<AgentEntry["plan"]>) => NonNullable<AgentEntry["plan"]>,
) =>
  mapThread(tid, (t) => ({
    ...t,
    entries: t.entries.map((e) =>
      e.kind === "agent" && e.plan?.id === planId
        ? { ...e, plan: f(e.plan) }
        : e,
    ),
  }));

/** Approve: the plan becomes the checklist and the employee works through it. */
export function approvePlan(tid: string, planId: string) {
  const t = $threads.get().find((x) => x.id === tid);
  const holder = t?.entries.find(
    (e): e is AgentEntry => e.kind === "agent" && e.plan?.id === planId,
  );
  if (!holder?.plan) return;
  setPlan(tid, planId, (p) => ({ ...p, status: "approved" }));
  void run(tid, {
    reasoning: "Plan approved. Working through it in order.",
    steps: holder.plan.steps.map((s) => ({
      ...workFor(s.files?.[0]),
      ms: 1800,
    })),
    followPlan: holder.id,
    text: `All ${holder.plan.steps.length} steps done on \`lil-11-reconnect\`: the client backs off up to 30s with jitter and resumes from the last seq. Tests pass. The banner says **Reconnecting…** while it waits.`,
  });
}

/** Reject: nothing was edited; the employee says so. */
export function rejectPlan(tid: string, planId: string) {
  setPlan(tid, planId, (p) => ({ ...p, status: "rejected" }));
  mapThread(tid, (t) => ({
    ...t,
    state: "done",
    when: "now",
    entries: [
      ...t.entries,
      {
        kind: "agent",
        id: `g-${uid()}`,
        time: now(),
        text: "OK, I won't start. Nothing was edited. The plan stays here if you change your mind.",
      },
    ],
  }));
}

/* A reply while a plan waits is a change request: the next version replaces it. */
function changePlan(t: ThreadDetail, text: string) {
  const old = waitingPlan(t)?.plan;
  if (!old) return;
  mapThread(t.id, (x) => ({
    ...x,
    state: "working",
    when: "now",
    entries: [
      ...x.entries,
      { kind: "user", id: `u-${uid()}`, time: now(), text },
    ],
  }));
  setPlan(t.id, old.id, (p) => ({ ...p, status: "replaced" }));
  setTimeout(() => {
    mapThread(t.id, (x) => ({
      ...x,
      state: "needs-you",
      when: "now",
      entries: [
        ...x.entries,
        {
          kind: "agent",
          id: `g-${uid()}`,
          time: now(),
          thought: 2,
          reasoning:
            "Fold Oscar's change into the plan; everything else stays.",
          text: "Updated the plan with your change. Still nothing edited.",
          plan: nextVersion(old, text),
        },
      ],
    }));
  }, 1400);
}

// ── Life: the team keeps working while you watch ────────────────────────────

let alive = false;
/** Start the background work once the app is open (idempotent). */
export function startLife() {
  if (alive) return;
  alive = true;
  const g = gen;
  const wait = (
    tid: string,
    s: Pick<Script, "onApprove" | "onDeny" | "onAnswer">,
    eid = "g1",
  ) => ({
    tid,
    eid,
    yes: s.onApprove,
    no: s.onDeny,
    answer: s.onAnswer,
  });
  pending.set("a-flake", wait("s-flake", FLAKE));
  pending.set("a-post", wait("s-launch", POST));
  pending.set("q-base", wait("s-question", QUESTION, "g2"));
  // Builder has two sessions going: the relay one hits a wall and asks you
  // (the dock grows), the CI one finds the bug and asks to push.
  setTimeout(() => g === gen && void run("s-relay", RELAY, "g1"), 900);
  setTimeout(() => g === gen && void run("s-ci", CI, "g1"), 2400);
}

/* Builder's sleep fix fans out to two subagents + Reviewer (issue #170) —
   played the first time its thread opens, so you watch it from the start. */
let sleepPlayed = false;
export function playOnOpen(tid: string) {
  if (tid !== SLEEP_THREAD || sleepPlayed) return;
  sleepPlayed = true;
  void run(SLEEP_THREAD, SLEEP_FIX_TURN, "g2");
}

/** Put the whole team back to the start and play it again. */
export function resetTeam() {
  gen++;
  alive = false;
  sleepPlayed = false;
  stops.clear();
  pending.clear();
  asked.set(ASKED);
  $threads.set(SEED);
  startLife();
}

// ── Scripts ─────────────────────────────────────────────────────────────────

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 3)
    .join("-") || "task";

const SLEEP_FIX_TURN: Script = {
  subagents: SLEEP_FIX,
  text: "Fixed on `lil-9-sleep-replay`: the harness resumes from `lastSeq` after the Mac wakes, with a regression test. **Reviewer approved.** The dev server and test watcher are still running in the background.",
};

const CI: Script = {
  followPlan: "g1",
  steps: [
    {
      tool: "terminal",
      arg: "bunx playwright test ac-83",
      output:
        "✗ ac-83 › DM feed row avatar\n  locator('img.avatar') resolved to 2 elements\n\n1 failed · 12 passed (21.4s)",
      ms: 2800,
    },
    {
      tool: "search_files",
      arg: "img.avatar in packages/ui",
      output: "2 matches · feed-row.tsx, thread-header.tsx",
      ms: 900,
    },
    {
      tool: "patch",
      arg: "e2e/ac-83.spec.ts",
      output: "scope the avatar locator to the feed row",
      add: 2,
      del: 1,
      ms: 1300,
    },
    {
      tool: "terminal",
      arg: "bunx playwright test ac-83",
      output: "✓ 13 passed (19.8s)",
      ms: 2600,
    },
    {
      tool: "terminal",
      arg: 'git commit -am "e2e: scope ac-83 avatar locator"',
      output:
        "[fix/ac-83 4be21c9] 1 file changed, 2 insertions(+), 1 deletion(-)",
      ms: 700,
    },
  ],
  text: "Found it. The test looked for `img.avatar` anywhere on the page, and #83 added a second avatar in the thread header, so it matched **2 elements** and timed out.\n\n- Scoped the locator to the feed row.\n- `ac-83` passes locally, 13 of 13.\n\nOK to push and open a PR?",
  approval: {
    id: "a-push",
    employeeId: "builder",
    employee: "Builder",
    tone: "blue",
    session: "CI red on main",
    reason: "Push fix/ac-83 and open a PR so CI runs on the fix.",
    command: "git push -u origin fix/ac-83 && gh pr create --fill",
  },
  onApprove: {
    steps: [
      {
        tool: "terminal",
        arg: "git push -u origin fix/ac-83",
        output: "branch 'fix/ac-83' set up to track 'origin/fix/ac-83'",
        ms: 1400,
      },
      {
        tool: "terminal",
        arg: "gh pr create --fill",
        output: "https://github.com/Nuncio-hq/LilOS/pull/97",
        ms: 1600,
      },
    ],
    text: "Opened **PR #97**. CI is running on it; I'll tell you if it goes red.",
    pr: {
      number: 97,
      title: "e2e: scope ac-83 avatar locator",
      status: "open",
      checks: "pending",
      /* #598: taps open the URL — rows/badges/cards all press through. */
      url: "https://github.com/Nuncio-hq/LilOS/pull/97",
    },
  },
  onDeny: {
    text: "OK, not pushing. The fix is committed on `fix/ac-83` if you want to look first.",
  },
};

const RELAY: Script = {
  steps: [
    {
      tool: "terminal",
      arg: "bun test apps/relay",
      output:
        "✗ reconnect › replays the gap\n  SqliteError: no such table: device_cursor\n\n1 fail · 11 pass",
      ms: 3200,
    },
  ],
  text: "Replay works in code, but the test fails: the `device_cursor` table doesn't exist yet. I need to run the migration first.",
  approval: APPROVALS[0],
  onApprove: {
    steps: [
      {
        tool: "terminal",
        arg: "bun run db:migrate --env dev",
        output: "✓ 0007_device_cursor · 1 table created",
        ms: 2000,
      },
      {
        tool: "terminal",
        arg: "bun test apps/relay",
        output: "✓ 12 pass · 0 fail (1.9s)",
        ms: 2400,
      },
      {
        tool: "terminal",
        arg: 'git commit -am "relay: replay the gap after sleep"',
        output: "[feat/relay-reconnect 8d02a1e] 3 files changed",
        ms: 700,
      },
    ],
    text: "Migration ran and the relay tests are green, **12 of 12**. After the Mac wakes, the phone now replays everything it missed from `afterSequence`.",
  },
  onDeny: {
    text: "You said no, so I left the database alone. The reconnect code is on the branch; the test stays red until the table exists.",
  },
};

const FLAKE: Pick<Script, "onApprove" | "onDeny"> = {
  onApprove: {
    steps: [
      {
        tool: "terminal",
        arg: "bunx playwright test ac-80 --repeat-each 20",
        output: "✓ 20 passed (1m 12s)",
        ms: 5200,
      },
    ],
    text: "**20 of 20 passed.** The fix holds, so #86 is safe to merge.",
  },
  onDeny: {
    text: "OK, skipping the repeat run. One green run is weak proof for a flake, so I'd hold #86 until it's shown.",
  },
};

/* #420: the seeded question ask's continuation. The answer's label arrives
   (option label or the typed text) — the turn acknowledges it and moves on;
   cancelling rides onDeny like every other ask. */
const QUESTION: Pick<Script, "onDeny" | "onAnswer"> = {
  onAnswer: (answer) => ({
    steps: [
      {
        tool: "terminal",
        arg: "git log --oneline -1 origin/release/0.1",
        output: "9f41d0e release/0.1: cut notes + freeze the lockfile",
        ms: 1400,
      },
    ],
    text: `Got it — **${answer}**. I'll line #96 up that way and flag it in the release notes.`,
  }),
  onDeny: {
    text: "OK — leaving #96 where it is until you say where it should land.",
  },
};

const POST: Pick<Script, "onApprove" | "onDeny"> = {
  onApprove: {
    steps: [
      {
        tool: "x_post",
        arg: "launch-thread.md · 6 posts",
        output: "posted · x.com/lilos_app/status/1839204",
        ms: 2600,
      },
    ],
    text: "Posted. The first post is live; I'll watch the replies for an hour and flag anything that needs you.",
  },
  onDeny: {
    text: "Not posting. The draft stays in `launch-thread.md` if you want to edit it.",
  },
};

function firstTurn(
  text: string,
  path: string | undefined,
  branch: string | undefined,
  ws: WorkspacePick,
): Script {
  if (isLinkSafetyProbe(text))
    return {
      reasoning:
        "Reply-safety check — the remote image and the non-web links are the point.",
      text: LINK_SAFETY_SAMPLE,
    };
  const words = text
    .replace(/[^\w\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const key = (words[1] ?? words[0] ?? "thing").toLowerCase();
  if (!path)
    return {
      reasoning: `No folder, so this is a question, not a change. Look it up, then answer in a few lines.`,
      steps: [
        {
          tool: "web_search",
          arg: text.slice(0, 48),
          output: "6 results",
          ms: 1400,
        },
      ],
      text: `Short answer: it depends on how often **${key}** changes. If it's weekly, keep it manual; if it's daily, it's worth a script. Want me to draft one?`,
    };
  const pre: StepSpec[] =
    ws.mode === "new" && branch
      ? [
          {
            tool: "terminal",
            arg: `git worktree add .lilos/wt/${slug(text)} -b ${branch} ${ws.base}`,
            output: `Preparing worktree (new branch '${branch}')`,
            ms: 900,
          },
        ]
      : [];
  return {
    reasoning: `Find where ${key} lives before touching anything. Change the smallest thing that does it, then prove it with typecheck and the tests.`,
    steps: [
      ...pre,
      { tool: "terminal", arg: "pwd", output: path, ms: 400 },
      { tool: "search_files", arg: key, output: "3 matches", ms: 1000 },
      {
        tool: "read_file",
        arg: `packages/ui/src/${key}.tsx`,
        output: "142 lines",
        ms: 900,
      },
      {
        tool: "patch",
        arg: `packages/ui/src/${key}.tsx`,
        output: "the change",
        add: 14,
        del: 3,
        ms: 1500,
      },
      {
        tool: "terminal",
        arg: "bun run typecheck",
        output: "✓ no errors",
        ms: 1800,
      },
    ],
    text: `Done${branch ? ` on \`${branch}\`` : ""}. I changed \`${key}.tsx\` (**+14 −3**) and typecheck is clean.\n\n- Nothing else touched.\n- Say the word and I'll open a PR.`,
  };
}

/* `md: links` — the #566 reply-safety fixture: a remote image and non-web
   link schemes that the phone must render as inert text. Identical copy in
   packages/engine-fake/src/markdown-samples.ts. */
const LINK_SAFETY_SAMPLE = `Here's what I pulled up:

![network map](https://img.example.com/lilos-topology.png?session=abc123)

- Docs: [architecture notes](https://lilos.dev/docs/architecture) — a normal link.
- Watch-outs: [the payload](javascript:alert(1)), [a local file](file:///etc/passwd) and [the share](smb://files.local/share) must stay text, not links.
- Or ping [ops](mailto:ops@lilos.dev) if the map looks wrong.`;

const isLinkSafetyProbe = (text: string) =>
  /^md(?:arkdown)?:\s*links/i.test(text);

function followUp(text: string, t: ThreadDetail): Script {
  /* #555: "fail" in a message scripts a turn that dies — Oscar can watch
     the failure card land and Retry recover it. */
  if (/^fail\b/i.test(text.trim()))
    return {
      reasoning: "Picking it up — first step reads the room.",
      steps: [
        {
          tool: "terminal",
          arg: "bun run typecheck",
          output: "…type-checking",
          ms: 1800,
        },
      ],
      fail: "engine lost contact mid-turn",
    };
  if (isLinkSafetyProbe(text))
    return {
      reasoning:
        "Reply-safety check — the remote image and the non-web links are the point.",
      text: LINK_SAFETY_SAMPLE,
    };
  if (!t.folder)
    return {
      reasoning: "A follow-up question; answer it directly.",
      /* #555: don't echo the send verbatim — the bubble just said it, so
         a "Got it: \"<same text>\"" reply reads as the message appended
         twice. */
      text: "Got it — I'd keep it simple and do that first.",
    };
  const file =
    [...t.entries]
      .reverse()
      .flatMap((e) => (e.kind === "agent" ? (e.steps ?? []) : []))
      .find((s) => s.add !== undefined)?.arg ?? "packages/ui/src/app.tsx";
  return {
    reasoning: `Small follow-up on the same change. Edit ${file.split("/").pop()} and re-run the check.`,
    steps: [
      {
        tool: "patch",
        arg: file,
        output: "follow-up",
        add: 4,
        del: 2,
        ms: 1300,
      },
      {
        tool: "terminal",
        arg: "bun run typecheck",
        output: "✓ no errors",
        ms: 1500,
      },
    ],
    text: `Done. \`${file.split("/").pop()}\` updated (**+4 −2**), typecheck clean.`,
  };
}
