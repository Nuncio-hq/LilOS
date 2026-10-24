import type { Person, Status, ThreadRowVM } from "../types";

/* View models for the Company tab, an agent's page and the Hire sheet. The
   app builds them from its company; nothing here knows where it lives. */

/** One line of the People list. */
export type PersonRowVM = {
  person: Person;
  status: Status;
  statusWord: string;
  /** "Engineer", or "Growth bot · Outside worker". */
  roleLine: string;
};

/** A person in the org tree with the people who report to them. */
export type OrgNodeVM = {
  person: Person;
  reports: OrgNodeVM[];
};

export type GoalVM = {
  id: string;
  title: string;
  /** Absent when the goal's project is gone. */
  project?: string;
  /** "Fri 31 Oct" — shown after "Due". */
  due: string;
  done: number;
  total: number;
  why: string;
};

export type ProjectVM = {
  id: string;
  name: string;
  /** Ticket prefix: LIL, HB. */
  key: string;
  about: string;
  folder: string;
  /** Tickets not done. Absent when the company has no tickets. */
  open?: number;
};

export type CompanyScreenProps = {
  /** CEO first, then the roster. */
  people: PersonRowVM[];
  /** The CEO's tree, then anyone with no boss beside them. */
  org: OrgNodeVM[];
  /** Empty hides the section. */
  goals: GoalVM[];
  /** Empty hides the section. */
  projects: ProjectVM[];
  onOpenAgent: (agentId: string) => void;
  onHire: () => void;
};

export type PeopleScreenProps = {
  /** CEO first, then the roster. */
  people: PersonRowVM[];
  org: OrgNodeVM[];
  onOpenAgent: (agentId: string) => void;
  onHire: () => void;
};

export type NoteVM = {
  id: string;
  /** File name, "readers.md". */
  name: string;
  firstLine: string;
  /** "from LIL-77", "9 Oct". */
  updated: string;
  text: string;
};

export type SkillVM = {
  id: string;
  name: string;
  /** Absent when the library does not describe it. */
  about?: string;
};

export type AgentPageProps = {
  person: Person;
  status: Status;
  statusWord: string;
  /** "Engineer" (outside workers: "Growth bot · Outside worker"). */
  roleLine: string;
  description?: string;
  /** Read-only rows: Engine, Model, Reached through. Empty ones are left out. */
  engine: { label: string; value: string }[];
  /** The ticket the agent holds now. */
  ticket?: { id: string; title: string; since: string };
  /** Idle agents: what wakes them next. */
  nextRun?: string;
  instructions: string[];
  notes: NoteVM[];
  skills: SkillVM[];
  /** "6 done · typically 25m · 0 stuck". */
  week?: string;
  /** "$9.80 of $25 this week". */
  spend?: string;
  threads: ThreadRowVM[];
  onOpenTicket: (ticketId: string) => void;
  onOpenThread: (threadId: string) => void;
};

export type HireCardVM = {
  /** The role is the card's title and the name of the button. */
  role: string;
  does: string;
  /** The model the new agent will use. Absent when the app lists none. */
  model?: string;
};

export type HireSheetProps = {
  cards: HireCardVM[];
  onHire: (role: string) => void;
  onClose: () => void;
};
