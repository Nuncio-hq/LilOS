import { cancelTurn, nowClock, type ReplyFn, runTurn } from "./v3-chat-sim";
import { agentOf } from "./v3-model";
import type {
  V3Actions,
  V3Data,
  V3Draft,
  V3Route,
  V3Status,
  V3Thread,
} from "./v3-types";

/* A started ⌘K plan becomes real records: tickets that can start now get a
   working thread at once; the rest wait on the ticket before them, and the
   one that asks the chairman first stays planned. */
export function planRecords(
  d: V3Data,
  plan: Extract<V3Draft, { kind: "plan" }>,
  text: string,
): V3Data {
  const projectKey = plan.tickets[0].id.split("-")[0];
  const project = d.projects.find((p) => p.key === projectKey) ?? d.projects[0];
  const ids = new Set(plan.tickets.map((t) => t.id));
  const tickets = plan.tickets.map((t) => ({
    id: t.id,
    title: t.title,
    projectId: project.id,
    goalId: plan.goalId,
    owner: t.owner,
    status: (t.asksYou
      ? "planned"
      : t.after
        ? "waiting"
        : "working") as V3Status,
    waitingOn:
      t.after && ids.has(t.after)
        ? { kind: "ticket" as const, ticketId: t.after }
        : undefined,
    startsAt: t.asksYou ? `after ${t.after}` : undefined,
    since: 0,
    started: t.after ? undefined : "Today 12:05",
    progress: [
      {
        text: t.title,
        by: t.owner,
        took: t.after ? "" : "just started",
        state: (t.after ? "todo" : "current") as "todo" | "current",
      },
    ],
    updates: [
      { by: d.ceoId, ago: 0, text: `Part of your request: “${text}”.` },
    ],
  }));
  const threads: V3Thread[] = plan.tickets
    .filter((t) => !t.after && !t.asksYou)
    .map((t) => ({
      id: `t-${t.id.toLowerCase()}`,
      ticketId: t.id,
      agentId: t.owner,
      title: t.title,
      status: "working",
      startedAt: "12:05",
      minutes: 0,
      step: 1,
      context: 3,
      model: agentOf(d, t.owner).model,
      folder: project.folder,
      now: { kind: "read", text: "Reading the brief", elapsed: "0s" },
      live: {
        cmd: `Starting ${t.id}`,
        lines: [
          "Read the ticket and the goal",
          "Read the project's notes",
          "Planning the first step…",
        ],
      },
      tail: ["Read the ticket and the goal", "Planning the first step…"],
      plan: [{ text: t.title, state: "current" }],
      changes: [],
      turns: [
        {
          n: 1,
          from: "asked by CEO just now",
          took: "0m so far",
          steps: [
            { kind: "read", target: `${t.id} · the brief`, running: true },
          ],
        },
      ],
    }));
  return {
    ...d,
    tickets: [...tickets, ...d.tickets],
    threads: [...threads, ...d.threads],
    updates: [
      {
        id: `u-${plan.tickets[0].id}`,
        by: d.ceoId,
        at: "12:05",
        ticketId: plan.tickets[0].id,
        kind: "plan",
        text: `Started your request “${text}” as ${plan.tickets.length} tickets.`,
      },
      ...d.updates,
    ],
  };
}

type SetData = (fn: (d: V3Data) => V3Data) => void;

/* The prototype's company engine: each action rewrites the mock records the
   way the real relay would, so the next screen tells the truth. */
export function makeActions(
  setData: SetData,
  getData: () => V3Data,
  reply: ReplyFn,
  toast: (t: string) => void,
  go: (r: V3Route) => void,
  setPalette: (seed: string) => void,
): V3Actions {
  const ticketPatch = (
    d: V3Data,
    id: string,
    patch: Partial<V3Data["tickets"][number]>,
  ) => d.tickets.map((t) => (t.id === id ? { ...t, ...patch } : t));
  const threadPatch = (
    d: V3Data,
    pick: (t: V3Thread) => boolean,
    patch: Partial<V3Thread>,
  ) => d.threads.map((t) => (pick(t) ? { ...t, ...patch } : t));
  /* Move a ticket's checklist on by one: current → done, next todo → current. */
  const advance = (steps: V3Data["tickets"][number]["progress"]) => {
    const i = steps.findIndex((s) => s.state === "current");
    return steps.map((s, j) =>
      j === i
        ? { ...s, state: "done" as const, took: s.took.replace(" so far", "") }
        : j === i + 1
          ? { ...s, state: "current" as const, took: "just started" }
          : s,
    );
  };
  const resolve = (
    askId: string,
    outcome: "yes" | "no" | string,
    word: string,
  ) =>
    setData((d) => {
      const ask = d.asks.find((a) => a.id === askId);
      if (!ask) return d;
      const ticket = d.tickets.find((t) => t.id === ask.ticketId);
      const yes = outcome === "yes";
      const closes = outcome === "no" || ask.kind === "question";
      const tickets = ticket
        ? ticketPatch(d, ticket.id, {
            status: closes ? "done" : "working",
            waitingOn: undefined,
            since: 0,
            doneAgo: closes ? 0 : undefined,
            progress: advance(ticket.progress),
            updates: [
              ...ticket.updates,
              { by: "you", ago: 0, text: word },
              ...(yes
                ? [{ by: ask.from, ago: 0, text: ask.ifYes }]
                : outcome === "no"
                  ? [{ by: d.ceoId, ago: 0, text: ask.ifNo }]
                  : []),
            ],
          })
        : d.tickets;
      const threads = threadPatch(d, (t) => t.askId === askId, {
        status: closes ? "done" : "working",
        askId: undefined,
        unseen: false,
        now: closes
          ? undefined
          : { kind: "web", text: "Launching the ads", elapsed: "0s" },
        tail: closes
          ? undefined
          : [`Approved by ${d.me}`, "Creating 3 ad sets…"],
        live: closes
          ? undefined
          : {
              cmd: "Meta Ads · create campaign",
              lines: [
                "Campaign “HB hooks test” created",
                "Ad set 1 · hook 2 · $13.33",
                "Ad set 2 · hook 5 · $13.33",
                "Ad set 3 · hook 11 · $13.34",
                "Submitted for review…",
              ],
            },
        summary: closes ? word : undefined,
      });
      return {
        ...d,
        asks: d.asks.filter((a) => a.id !== askId),
        tickets,
        threads,
        updates: [
          {
            id: `u-${askId}-${Date.now()}`,
            by: ask.from,
            at: "12:05",
            ticketId: ask.ticketId,
            kind: closes ? "done" : "handoff",
            text: `${word}. ${yes ? ask.ifYes : outcome === "no" ? ask.ifNo : ""}`.trim(),
          },
          ...d.updates,
        ],
      };
    });

  return {
    approve: (id, always) => {
      resolve(
        id,
        "yes",
        always ? "Approved, and allowed next time without asking" : "Approved",
      );
      toast(
        always
          ? "Approved · next time it won’t ask"
          : "Approved · the agent carries on",
      );
    },
    deny: (id) => {
      resolve(id, "no", "Denied");
      toast("Denied · the CEO takes the other route");
    },
    answer: (id, option) => {
      resolve(id, option, `You chose ${option}`);
      toast(`Answered: ${option}`);
    },
    stop: (threadId) => {
      cancelTurn(threadId);
      setData((d) => {
        const th = d.threads.find((t) => t.id === threadId);
        if (!th) return d;
        const ticket = d.tickets.find((t) => t.id === th.ticketId);
        return {
          ...d,
          threads: threadPatch(d, (t) => t.id === threadId, {
            status: "idle",
            now: undefined,
            live: undefined,
            stuck: undefined,
            summary: "Stopped by you",
          }),
          tickets: ticket
            ? ticketPatch(d, ticket.id, {
                status: "waiting",
                stuckWhy: undefined,
                fallback: undefined,
                since: 0,
                waitingOn: {
                  kind: "agent",
                  agentId: d.ceoId,
                  why: "to decide what next",
                },
                updates: [
                  ...ticket.updates,
                  {
                    by: "you",
                    ago: 0,
                    text: `Stopped ${agentOf(d, th.agentId).name}.`,
                  },
                ],
              })
            : d.tickets,
        };
      });
      toast("Stopped · the CEO will decide what next");
    },
    handOff: (ticketId, agentId) => {
      setData((d) => {
        const ticket = d.tickets.find((t) => t.id === ticketId);
        if (!ticket) return d;
        const to = agentOf(d, agentId);
        const project = d.projects.find((p) => p.id === ticket.projectId);
        const fresh: V3Thread = {
          id: `t-${ticketId.toLowerCase()}-${agentId}`,
          ticketId,
          agentId,
          title: ticket.title,
          status: "working",
          startedAt: "12:05",
          minutes: 0,
          step: 1,
          context: 4,
          model: to.model,
          folder: project?.folder ?? "~",
          now: {
            kind: "read",
            text: "Reading what the last hand tried",
            elapsed: "0s",
          },
          live: {
            cmd: `Taking over ${ticketId}`,
            lines: [
              "Read the ticket and its updates",
              "Read the last thread’s searches",
              "Trying a different search approach…",
            ],
          },
          tail: ["Read the last thread’s searches", "Switching approach…"],
          plan: [{ text: "Take over from the last hand", state: "current" }],
          changes: [],
          turns: [
            {
              n: 1,
              from: "handed over just now",
              took: "0m so far",
              steps: [
                {
                  kind: "read",
                  target: `${ticketId} · updates`,
                  running: true,
                },
              ],
            },
          ],
        };
        return {
          ...d,
          threads: [
            fresh,
            ...threadPatch(
              d,
              (t) => t.ticketId === ticketId && t.status !== "done",
              {
                status: "done",
                now: undefined,
                live: undefined,
                stuck: undefined,
                summary: `Handed to ${to.name}`,
              },
            ),
          ],
          tickets: ticketPatch(d, ticketId, {
            owner: agentId,
            status: "working",
            stuckWhy: undefined,
            fallback: undefined,
            waitingOn: undefined,
            since: 0,
            updates: [
              ...ticket.updates,
              { by: "you", ago: 0, text: `Handed to ${to.name}.` },
            ],
          }),
        };
      });
      toast("Handed off · a new thread started");
    },
    acceptRule: (agentId) => {
      setData((d) => ({
        ...d,
        agents: d.agents.map((a) =>
          a.id === agentId && a.suggestion
            ? {
                ...a,
                instructions: [...a.instructions, a.suggestion.text],
                suggestion: undefined,
              }
            : a,
        ),
      }));
      toast("Rule added to the instructions");
    },
    dismissRule: (agentId) => {
      setData((d) => ({
        ...d,
        agents: d.agents.map((a) =>
          a.id === agentId ? { ...a, suggestion: undefined } : a,
        ),
      }));
    },
    comment: (ticketId, text) => {
      setData((d) => {
        const t = d.tickets.find((x) => x.id === ticketId);
        return t
          ? {
              ...d,
              tickets: ticketPatch(d, ticketId, {
                updates: [...t.updates, { by: "you", ago: 0, text }],
              }),
            }
          : d;
      });
    },
    message: (threadId, text) => {
      const th = getData().threads.find((t) => t.id === threadId);
      if (!th) return;
      if (th.status !== "working") {
        runTurn(setData, getData, reply, th, text);
        return;
      }
      /* Mid-turn: queue on the running turn; the agent reads it after the
         current step (the simulator starts it when the turn ends). */
      const newest = Math.max(...th.turns.map((u) => u.n));
      setData((d) => ({
        ...d,
        threads: d.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                turns: t.turns.map((u) =>
                  u.n === newest
                    ? {
                        ...u,
                        queued: [...(u.queued ?? []), { at: nowClock(), text }],
                      }
                    : u,
                ),
              }
            : t,
        ),
      }));
      toast(
        `Queued · ${agentOf(getData(), th.agentId).name} reads it after the current step`,
      );
    },
    startChat: ({ agentId, projectId, model, text }) => {
      const project = getData().projects.find((p) => p.id === projectId);
      const chat: V3Thread = {
        id: `t-chat-${Date.now().toString(36)}`,
        projectId,
        agentId,
        title: text.length > 56 ? `${text.slice(0, 54).trimEnd()}…` : text,
        status: "working",
        startedAt: nowClock(),
        minutes: 0,
        step: 0,
        context: 2,
        model,
        folder: project?.folder ?? "~",
        changes: [],
        turns: [],
      };
      setData((d) => ({ ...d, threads: [chat, ...d.threads] }));
      // Land on Threads with the new chat open beside it, not on the form.
      go({ page: "threads" });
      go({ page: "thread", id: chat.id });
      runTurn(setData, getData, reply, chat, text);
    },
    markSeen: (threadId) => {
      setData((d) => ({
        ...d,
        threads: threadPatch(d, (t) => t.id === threadId, { unseen: false }),
      }));
    },
    hire: ({ name, role, model }) => {
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "agent";
      setData((d) => ({
        ...d,
        agents: [
          ...d.agents,
          {
            id,
            name,
            tone: (["b", "r", "m", "s", "d", "c"] as const)[
              d.agents.length % 6
            ],
            role,
            reportsTo: d.ceoId,
            hired: "today",
            runtime: `Hermes · profile ${id}`,
            model,
            schedule: "When given a ticket",
            skills: [],
            spend: { used: 0, cap: 10, period: "week" },
            instructions: [
              `You are ${name}, the company’s ${role.toLowerCase()}. The CEO gives you tickets; finish them and report back in one short update.`,
            ],
            memory: [],
            week: { done: 0, typical: "—", stuck: 0, handed: 0 },
            next: "Waiting for the CEO to give a first ticket",
          },
        ],
      }));
      toast(`${name} hired`);
      go({ page: "people" });
      go({ page: "agent", id });
    },
    makeCeo: (agentId) => {
      setData((d) => {
        if (d.ceoId === agentId) return d;
        // The position moves; the org follows it: the new CEO reports to
        // you, everyone else (the old CEO included) reports to the new one.
        return {
          ...d,
          ceoId: agentId,
          agents: d.agents.map((a) => ({
            ...a,
            reportsTo: a.id === agentId ? undefined : agentId,
          })),
        };
      });
      toast(`${agentOf(getData(), agentId).name} is now the CEO`);
    },
    toggleConnector: (connectorId, agentId) => {
      setData((d) => ({
        ...d,
        connectors: d.connectors.map((c) =>
          c.id !== connectorId
            ? c
            : {
                ...c,
                agents: c.agents.includes(agentId)
                  ? c.agents.filter((a) => a !== agentId)
                  : [...c.agents, agentId],
              },
        ),
      }));
    },
    addConnector: ({ label, kind, command }) => {
      const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "connector";
      setData((d) => ({
        ...d,
        connectors: [
          ...d.connectors,
          {
            id,
            label,
            kind,
            command,
            about:
              kind === "mcp"
                ? "An MCP server you added."
                : "A command you added.",
            // A new connector is found but not yet tried; its own login (if
            // any) happens the first time an agent uses it.
            state: "ready",
            look: { mark: label.slice(0, 1).toUpperCase(), color: "#57534e" },
            agents: [],
          },
        ],
      }));
      toast(`${label} added · turn it on for the agents that need it`);
    },
    ask: (text) => setPalette(text ?? ""),
  };
}
