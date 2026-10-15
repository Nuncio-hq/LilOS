import { useState } from "react";
import type { V2Agent } from "./v2-types";
import type { V2Connector, V2Ticket, V2TrailLine } from "./v2-work-types";

/* The prototype's Work state: tickets, connectors and who holds the CEO
   position, with the mock mutations the owner can try (approve/deny a risky ask,
   turn a connector on for an agent, move the CEO position). No wire calls. */
export function useV2Work({
  tickets: initialTickets,
  connectors: initialConnectors,
  agents,
  setAgents,
  onToast,
}: {
  tickets: V2Ticket[];
  connectors: V2Connector[];
  agents: V2Agent[];
  setAgents: (f: (a: V2Agent[]) => V2Agent[]) => void;
  onToast?: (text: string) => void;
}) {
  const [tickets, setTickets] = useState(initialTickets);
  const [connectors, setConnectors] = useState(initialConnectors);
  const now = () => new Date().toTimeString().slice(0, 5);
  const ceo = agents.find((a) => a.position === "ceo");

  const answer = (id: string, ok: boolean) =>
    setTickets((ts) =>
      ts.map((t) => {
        if (t.id !== id || !t.ask) return t;
        const line: V2TrailLine = {
          kind: "ask",
          who: "You",
          text: ok ? `Approved: ${t.ask.text}` : `Denied: ${t.ask.text}`,
          time: now(),
        };
        return {
          ...t,
          ask: undefined,
          state: ok ? "working" : "todo",
          ago: 0,
          line: ok ? "Approved, carrying on" : "Denied, back to the CEO",
          trail: [
            ...t.trail.map((l) => ({ ...l, live: false })),
            line,
            ...(ok
              ? [
                  {
                    kind: "note" as const,
                    who:
                      t.assignee.kind === "outside" ? t.assignee.name : "Agent",
                    text: "Carrying on.",
                    time: now(),
                    live: true,
                  },
                ]
              : []),
          ],
        };
      }),
    );

  return {
    tickets,
    connectors,
    ceo,
    openTickets: tickets.filter((t) => t.state !== "done").length,
    risky: tickets.filter((t) => t.ask?.risk),
    approve: (id: string) => {
      answer(id, true);
      onToast?.("Approved. The worker carries on.");
    },
    deny: (id: string) => {
      answer(id, false);
      onToast?.("Denied. The CEO will re-plan it.");
    },
    toggleConnector: (connectorId: string, agentId: string) =>
      setConnectors((cs) =>
        cs.map((c) =>
          c.id !== connectorId
            ? c
            : {
                ...c,
                agentIds: c.agentIds.includes(agentId)
                  ? c.agentIds.filter((x) => x !== agentId)
                  : [...c.agentIds, agentId],
              },
        ),
      ),
    makeCeo: (agentId: string) => {
      const name = agents.find((a) => a.id === agentId)?.name;
      setAgents((as) =>
        as.map((a) => {
          const { position: _, ...rest } = a;
          return a.id === agentId
            ? { ...rest, position: "ceo" as const, reportsTo: undefined }
            : { ...rest, reportsTo: a.soon ? undefined : agentId };
        }),
      );
      onToast?.(`${name} is now the CEO. Tickets and memory stay.`);
    },
  };
}
