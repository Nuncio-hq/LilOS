/* UI types for the AI company (#746): a CEO employee hands tickets to
   always-on bots from several providers. Prototype shapes only — the wire
   types land in packages/contracts with the bot-contract slice. */

/** Who runs a bot. Each provider has its own strength and its own adapter. */
export type BotProvider = "grokbot" | "muse";

export type BotState = "working" | "idle" | "waiting" | "offline";

/** An always-on bot the CEO can hand work to. Lives at its provider. */
export type Bot = {
  id: string;
  name: string;
  role: string;
  provider: BotProvider;
  /** The project team it belongs to; absent = shared across projects. */
  projectId?: string;
  state: BotState;
  /** What it is doing right now, in plain words. */
  now: string;
  /** Its provider's strength, shown under the name. */
  strength: string;
};

export type TicketState =
  | "todo"
  | "working"
  | "needs-ceo"
  | "needs-you"
  | "review"
  | "done";

export type CompanyTicket = {
  id: string;
  title: string;
  goal: string;
  projectId: string;
  /** A bot id. One assignee per ticket. */
  assignee: string;
  state: TicketState;
  /** Last update, plain words ("Drafted 15 hooks"). */
  update: string;
  updatedAgo: string;
};

/** A question or approval a bot raised. Routine ones go to the CEO; risky ones to the owner. */
export type BotAsk = {
  id: string;
  ticketId: string;
  bot: string;
  text: string;
  /** Why it came to the owner instead of the CEO. Present only on the owner's asks. */
  risk?: "spends-money" | "sends-outside" | "dangerous-command";
  /** The CEO's answer, once it answered a routine ask. */
  ceoAnswer?: string;
};

export type CeoTurn = {
  id: string;
  from: "oscar" | "ceo";
  text: string;
  time: string;
  /** Tickets the CEO created or moved in this turn. */
  tickets?: string[];
};

export type CompanyGoal = {
  id: string;
  title: string;
  projectId: string;
  progress: { done: number; total: number };
};

export type CompanyProject = { id: string; name: string };

export type CeoInfo = {
  name: string;
  runtime: string;
  model: string;
  state: "working" | "idle";
  now: string;
};
