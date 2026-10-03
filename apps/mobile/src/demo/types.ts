import type { Conversation, WorkbenchOpenTarget } from "@lilos/contracts/app";
import type {
  EngineRequest,
  Job,
  PlanStep,
  Usage,
} from "@lilos/contracts/engine";
import type { ForgePrListItem } from "@lilos/contracts/host";

/* The demo engine's script vocabulary (#168): a turn is a list of tool
   steps, optional reasoning + answer text, and at most one ask at the end.
   This is the mobile prototype's Script/StepSpec model
   (prototype/mobile/src/fake-engine.ts) re-pointed at wire `EngineEvent`s
   instead of UI entries — deterministic content, timers only pace it. */

/** One tool call in a scripted turn. `ms` is the step's live pacing. */
export type DemoStep = {
  tool: string;
  /** Lands on the wire as `input.command` — the arg chip the thread shows. */
  arg: string;
  output?: string;
  /** File diff rows (add/del + optional patch) for edit steps. */
  add?: number;
  del?: number;
  patch?: string;
  ms?: number;
};

/** A helper a scripted turn fans out to (#179/#319 coverage). */
export type DemoSubagent = {
  id: string;
  name: string;
  task: string;
  /** Employee helper: runs in ITS OWN conversation — the wire refs that
     make the row a link (employee profile ref + that thread's engineRef). */
  employee?: { employeeRef: string; sessionRef: string };
  steps: DemoStep[];
  result: string;
  ends?: "done" | "failed";
  /** Start delay, and (employee helpers) how long they work for. */
  delay?: number;
  wait?: number;
};

/** A plan.updated snapshot the script emits (kind "plan" proposal or the
   agent's own ticking "tasks" list). The row's decision state comes from
   the reducer: "tasks" shows approved, "plan" waits proposed until its
   request resolves. */
export type DemoPlan = {
  planId: string;
  kind: "tasks" | "plan";
  version: number;
  goal?: string;
  risks?: string[];
  steps: PlanStep[];
};

/** The ask a turn ends on — approve/deny continue into sub-scripts. */
export type DemoAsk = {
  id: string;
  request: EngineRequest;
  onApprove?: DemoScript;
  onDeny?: DemoScript;
};

export type DemoScript = {
  reasoning?: string;
  steps?: DemoStep[];
  /** The turn's task list: emitted all-pending, then one step ticks to
     in_progress while its tool call runs and completed after it. */
  tasks?: string[];
  /** Tick an approved plan's own rows as this script's tool calls land
      (the plan approved via `script.ask` continuing on the same turn). */
  tickPlan?: DemoPlan;
  /** Leave the turn open at script end — a follow-up script resumes it
      (seeded mid-flight threads: s-relay, s-ci). */
  hold?: boolean;
  /** One kind:"plan" snapshot emitted before the answer text. */
  plan?: DemoPlan;
  subagents?: DemoSubagent[];
  /** job.* rows this turn reports (seeded or live). */
  jobs?: Job[];
  text?: string;
  /** Open an ask instead of completing — the turn waits on you. */
  ask?: DemoAsk;
  /** A workbench.opened card emitted as the turn settles (#340). */
  wb?: WorkbenchOpenTarget;
  /** A PR the turn's outcome adds to the conversation (PR card). */
  pr?: ForgePrListItem;
  usage?: Usage;
};

/** A seeded conversation's baked history: user lines then the turn each
   prompts, in order. `waiting` freezes mid-ask (the turn stays open). */
export type SeedLeg = {
  /** The user's message text for this turn. */
  text: string;
  /** Engine turn that answers it; absent = user message with no reply yet. */
  script?: DemoScript;
};

export type SeedConversation = {
  id: string;
  title: string;
  channelId: string;
  /** Engine session id (engineRef). */
  session: string;
  cwd?: string;
  workspace?: Conversation["workspace"];
  model?: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
  /** Seconds before demo-open this conversation started (createdAt). */
  ageMin: number;
  legs: SeedLeg[];
};
