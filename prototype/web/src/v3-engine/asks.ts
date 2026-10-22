import { agentNameOf, agentOf, type V3Data, type V3DataActions, type V3Thread } from "@lilos/ui"
import { decidePlan, hasPlan } from "../thread/mock-plans"
import { cancelTurn } from "./chat-sim"
import { type Engine, ticketPatch, threadPatch } from "./context"

/* What waits on you and what you do about a ticket: approvals and questions,
   stopping a hand, handing a ticket to someone else, commenting on it. */
export function askActions({ setData, getData, toast }: Engine): Pick<
  V3DataActions,
  "approve" | "deny" | "answer" | "stop" | "handOff" | "comment"
> {
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
  const isPlan = (askId: string) =>
    getData().threads.some((t) => t.askId === askId && hasPlan(t.id));
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
                ? [{ by: ask.from, ago: 0, text: ask.ifYes ?? "" }]
                : outcome === "no"
                  ? [{ by: d.ceoId ?? d.agents[0].id, ago: 0, text: ask.ifNo ?? "" }]
                  : []),
            ],
          })
        : d.tickets;
      // A plan waiting for your OK carries on or ends as the plan card says;
      // any other thread picks up its own next step.
      const resumed: Partial<V3Thread> = {
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
      };
      const threads = d.threads.map((t) =>
        t.askId !== askId
          ? t
          : hasPlan(t.id)
            ? decidePlan(t, yes ? "approve" : "reject")
            : { ...t, ...resumed },
      );
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
            kind: closes ? "finished" : "handed",
            text: `${word}. ${yes ? ask.ifYes : outcome === "no" ? ask.ifNo : ""}`.trim(),
          },
          ...d.updates,
        ],
      };
    });

  return {
    approve: (id, always) => {
      const plan = isPlan(id);
      resolve(
        id,
        "yes",
        always ? "Approved, and allowed next time without asking" : "Approved",
      );
      toast(
        plan
          ? "Plan approved · the agent carries on"
          : always
            ? "Approved · next time it won’t ask"
            : "Approved · the agent carries on",
      );
    },
    deny: (id) => {
      const plan = isPlan(id);
      resolve(id, "no", "Denied");
      toast(
        plan
          ? "Plan rejected · nothing was touched"
          : "Denied · the CEO takes the other route",
      );
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
                  agentId: d.ceoId ?? d.agents[0].id,
                  why: "to decide what next",
                },
                updates: [
                  ...ticket.updates,
                  {
                    by: "you",
                    ago: 0,
                    text: `Stopped ${agentNameOf(d, th.agentId)}.`,
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
        // A hand-off needs someone on the team to hand to.
        if (!to) return d;
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
  }
}
