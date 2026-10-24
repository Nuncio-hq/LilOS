import {
  agentOf,
  agentStatus,
  agentTicket,
  nextRunLabel,
  type V3Agent,
  type V3Data,
  type V3Status,
} from "@lilos/ui/v3-data";
import {
  type AgentPageProps,
  AgentScreen,
  EmptyState,
  type NoteVM,
  type SkillVM,
} from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { minutesText, personOf, STATUS_WORDS, threadRowVM } from "../model";
import type { RootRoutes } from "../nav";
import { openThread, openTicket } from "../nav";
import { $data } from "../store";
import { roleLine } from "./company-model";

/* An agent's page, pushed from People, Org or a thread. Instructions, notes
   and skills are read-only here. */

/** Most urgent first; within a status the newest thread leads. */
const URGENCY: V3Status[] = [
  "needs",
  "stuck",
  "failed",
  "working",
  "waiting",
  "planned",
  "done",
  "idle",
];

function money(n: number): string {
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

function notesOf(a: V3Agent): NoteVM[] {
  return (a.notes ?? []).map((n) => ({
    id: n.id,
    name: n.name,
    firstLine:
      n.text
        .split("\n")
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .find(Boolean) ?? n.name,
    updated: n.updated,
    text: n.text,
  }));
}

function skillsOf(d: V3Data, a: V3Agent): SkillVM[] {
  return (a.skills ?? []).map((id) => {
    const s = d.skills?.find((x) => x.id === id);
    return { id, name: s?.name ?? id, about: s?.about || undefined };
  });
}

function engineRows(d: V3Data, a: V3Agent): AgentPageProps["engine"] {
  const via = a.via
    ? d.connectors.find((c) => c.id === a.via)?.label
    : undefined;
  return [
    { label: "Engine", value: a.runtime ?? "" },
    { label: "Model", value: a.model },
    { label: "Reached through", value: via ?? "" },
  ].filter((r) => r.value);
}

function pageOf(
  d: V3Data,
  a: V3Agent,
): Omit<AgentPageProps, "onOpenTicket" | "onOpenThread"> {
  const status = agentStatus(d, a.id);
  const ticket = d.features.tickets ? agentTicket(d, a.id) : undefined;
  const next =
    status === "idle" ? (nextRunLabel(d, a.id) ?? a.next) : undefined;
  const rank = (s: V3Status) => URGENCY.indexOf(s);
  return {
    person: personOf(d, a.id),
    status,
    statusWord: STATUS_WORDS[status],
    roleLine: roleLine(a),
    description: a.description || undefined,
    engine: engineRows(d, a),
    ticket: ticket && {
      id: ticket.id,
      title: ticket.title,
      since: `${STATUS_WORDS[ticket.status]} for ${minutesText(ticket.since)}`,
    },
    nextRun: next || undefined,
    instructions: a.instructions,
    notes: notesOf(a),
    skills: skillsOf(d, a),
    week: a.week
      ? `${a.week.done} done · typically ${a.week.typical} · ${a.week.stuck} stuck`
      : undefined,
    spend:
      a.spend && a.spend.cap > 0
        ? `${money(a.spend.used)} of ${money(a.spend.cap)} this ${a.spend.period}`
        : undefined,
    threads: d.threads
      .filter((t) => t.agentId === a.id)
      .sort((x, y) => rank(x.status) - rank(y.status) || x.minutes - y.minutes)
      .map((t) => threadRowVM(d, t)),
  };
}

export function AgentContainer({
  route,
}: NativeStackScreenProps<RootRoutes, "Agent">) {
  const d = useStore($data);
  const agent = agentOf(d, route.params.agentId);
  const page = useMemo(
    () => (agent ? pageOf(d, agent) : undefined),
    [d, agent],
  );
  // The page draws the name as its serif title; the bar stays empty.
  if (!page) return <EmptyState title="No longer on the team" />;
  return (
    <AgentScreen
      {...page}
      onOpenTicket={openTicket}
      onOpenThread={openThread}
    />
  );
}
