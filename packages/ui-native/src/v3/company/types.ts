import type { RingPerson } from "../kit";
import type { Person, Status, ThreadRowVM } from "../types";

/* View models for the Company tab, the People page, an agent's page and the
   Hire sheet. The app builds them from its company; nothing here knows where
   it lives. */

/** One person as the org chart draws them. */
export type PersonRowVM = {
  person: Person;
  status: Status;
  statusWord: string;
  /** "Engineer", or "Growth bot · Outside worker". */
  roleLine: string;
};

/** A person in the org tree with the people who report to them. */
export type OrgNodeVM = {
  row: PersonRowVM;
  reports: OrgNodeVM[];
};

export type GoalVM = {
  id: string;
  title: string;
  /** Absent when the goal's project is gone. */
  projectId?: string;
  project?: string;
  /** "Fri 31 Oct" — shown after "Due". */
  due: string;
  done: number;
  total: number;
};

export type ProjectVM = {
  id: string;
  name: string;
  /** What the project wears: its most pressing item's status. Absent when
      nothing is open. */
  status?: Status;
  /** "2 working · 1 stuck", or "Nothing open". */
  summary: string;
};

export type CompanyScreenProps = {
  /** CEO first, then the roster. */
  people: RingPerson[];
  /** Empty hides the module. */
  goals: GoalVM[];
  /** Empty hides the module. */
  projects: ProjectVM[];
  onOpenAgent: (agentId: string) => void;
  onOpenPeople: () => void;
  onOpenProject: (projectId: string) => void;
};

export type PeopleScreenProps = {
  /** "8 people · 3 working · 1 needs you" */
  summary: string;
  /** The CEO's tree, then anyone with no boss beside them. */
  org: OrgNodeVM[];
  onOpenAgent: (agentId: string) => void;
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
};

export type AgentPageProps = {
  person: Person;
  status: Status;
  statusWord: string;
  /** "Engineer" (outside workers: "Growth bot · Outside worker"). */
  roleLine: string;
  description?: string;
  /** The ticket the agent holds now. */
  now?: { id: string; title: string; since: string };
  /** Idle agents: what wakes them next. */
  nextRun?: string;
  /** "14 done · typically 6m · 0 stuck". */
  week?: string;
  /** "$9.80 of $25 this week". */
  spend?: string;
  /** "Hermes · Opus 5.5 · High": one line, empty ones left out. */
  runsOn?: string;
  instructions: string[];
  notes: NoteVM[];
  skills: SkillVM[];
  /** Most urgent first. */
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
