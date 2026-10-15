/* Work view models for the AI company inside v2 (#746): goals, tickets with
   one assignee, connectors, and the live trail of whoever works a ticket.
   Prototype shapes only, not wire types. No provider names live here: an
   outside bot is just a worker reached through a connector. */

/** The owner's five ticket states (#746, 2026-10-15). */
export type V2TicketState = "todo" | "working" | "needs" | "checking" | "done";

export const V2_TICKET_STATES: V2TicketState[] = [
  "todo",
  "working",
  "needs",
  "checking",
  "done",
];

/** Who holds a ticket: a LilOS agent, or an outside worker behind a connector. */
export type V2Assignee =
  | { kind: "agent"; agentId: string }
  | {
      kind: "outside";
      /** The worker's own name at its provider ("HB Marketing"). */
      name: string;
      /** The connector id it is reached through. */
      connectorId: string;
    };

/** One line in a ticket's live trail, in plain words. */
export type V2TrailKind =
  /** The CEO handed the ticket over, or a worker passed it on. */
  | "handoff"
  /** The worker said something (a progress note or its answer). */
  | "note"
  /** It ran a command, here or on a cloud or Mac computer. */
  | "command"
  /** It handed part of the job to a helper (a cloud coding agent, a subagent). */
  | "helper"
  /** It made something: a file, a PR, an image, a draft. */
  | "output"
  /** It asked; who answered is on the line. */
  | "ask"
  /** The CEO checked the result. */
  | "check";

export type V2TrailLine = {
  kind: V2TrailKind;
  /** Who did it: "CEO", the worker's name, or a helper's name. */
  who: string;
  text: string;
  /** Where it ran, when that matters: "Cloud · Linux", "Your Mac". */
  where?: string;
  /** Short trailing fact: "exit 0", "4m", "PR #66". */
  meta?: string;
  /** An outside link the worker gave (opens at the provider). */
  link?: string;
  /** The line is still happening. */
  live?: boolean;
  time: string;
};

/** An ask a worker raised on a ticket. Routine ones the CEO answers; risky ones come to the owner. */
export type V2TicketAsk = {
  text: string;
  /** Why it came to the owner instead of the CEO. Absent = the CEO handles it. */
  risk?: "spends-money" | "sends-outside" | "dangerous-command";
  /** The CEO's answer, once it answered a routine ask. */
  ceoAnswer?: string;
};

export type V2Ticket = {
  id: string;
  title: string;
  goalId: string;
  projectId: string;
  assignee: V2Assignee;
  state: V2TicketState;
  /** Minutes since the last trail line. */
  ago: number;
  /** One line under the title: the latest step. */
  line: string;
  ask?: V2TicketAsk;
  trail: V2TrailLine[];
  /** The CEO thread that created it. */
  threadId?: string;
};

export type V2Goal = {
  id: string;
  title: string;
  projectId: string;
};

/** An outside service an agent can use, reached through its own CLI or MCP. */
export type V2Connector = {
  id: string;
  /** Display name ("grokbot"). Comes from the connector, not from LilOS code. */
  name: string;
  kind: "cli" | "mcp";
  /** The command LilOS runs or attaches ("grokbot", "npx -y grokbot-mcp"). */
  command: string;
  /** One line on what it gives an agent. */
  about: string;
  state: "ready" | "signed-out" | "missing";
  /** Agents it is turned on for. */
  agentIds: string[];
  /** Outside workers this connector reaches (shown on the Work board). */
  workers?: string[];
};
