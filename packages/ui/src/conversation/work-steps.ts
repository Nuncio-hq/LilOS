import type { Step } from "../types";

/* The turn's work, in the words the fold line uses ("read 2 files, 1 search").
   Real steps carry engine tool names; this maps them onto the handful of
   kinds the v3 design names, so the one line and its rows read the same
   whichever engine ran the turn. */

export type StepKind =
  | "read"
  | "search"
  | "edit"
  | "run"
  | "web"
  | "delegate"
  | "other";

const KIND_OF_TOOL: Record<string, StepKind> = {
  terminal: "run",
  execute_code: "run",
  read_file: "read",
  view_image: "read",
  search_files: "search",
  write_file: "edit",
  patch: "edit",
  web_search: "web",
  web_extract: "web",
  delegate_task: "delegate",
};

/* Other engines (ACP agents) name tools their own way; match by stem. */
const KIND_BY_STEM: [RegExp, StepKind][] = [
  [/bash|shell|exec|terminal|command/, "run"],
  [/web|fetch|browse|http|url/, "web"],
  [/grep|glob|search|find/, "search"],
  [/edit|write|patch|apply/, "edit"],
  [/read|view|cat/, "read"],
  [/task|agent/, "delegate"],
];

export function stepKind(s: Step): StepKind {
  const known = KIND_OF_TOOL[s.tool];
  if (known) return known;
  const tool = s.tool.toLowerCase();
  return KIND_BY_STEM.find(([re]) => re.test(tool))?.[1] ?? "other";
}

export const failedStep = (s: Step) =>
  s.status === "failed" || s.status === "denied";

const PAST: Record<StepKind, string> = {
  read: "Read",
  search: "Searched",
  edit: "Edited",
  run: "Ran",
  web: "Browsed",
  delegate: "Delegated",
  other: "",
};

const NOW: Record<StepKind, string> = {
  read: "Reading",
  search: "Searching",
  edit: "Editing",
  run: "Running",
  web: "Browsing",
  delegate: "Delegating",
  other: "",
};

/** What the step touched: the command, path, pattern or query, first line. */
export function stepTarget(s: Step): string {
  const i = s.input;
  const raw =
    i.command ??
    i.path ??
    i.pattern ??
    i.query ??
    i.url ??
    i.task ??
    i.goal ??
    s.diff?.path ??
    "";
  return String(raw).split("\n")[0].trim();
}

/** "Read" / "Created" / the tool's own name for kinds the design has no word for. */
export function stepVerb(s: Step, kind: StepKind, running: boolean): string {
  if (kind === "other") return s.tool;
  if (!running && s.diff?.status === "added") return "Created";
  return (running ? NOW : PAST)[kind];
}

/** "Editing README.md" — what a running turn's fold line says it is on. */
export function stepNow(s: Step): string {
  const kind = stepKind(s);
  const target = stepTarget(s);
  return kind === "other"
    ? `${s.tool}…`
    : `${NOW[kind]}${target ? ` ${target}` : "…"}`;
}

const COUNTS: { kind: StepKind; verb: string; one: string; many: string }[] = [
  { kind: "read", verb: "read ", one: "file", many: "files" },
  { kind: "search", verb: "", one: "search", many: "searches" },
  { kind: "edit", verb: "edited ", one: "file", many: "files" },
  { kind: "run", verb: "ran ", one: "command", many: "commands" },
  { kind: "web", verb: "browsed ", one: "page", many: "pages" },
  { kind: "delegate", verb: "delegated ", one: "task", many: "tasks" },
];

/** "read 3 files, ran 2 commands, 1 failed" — the facts after "Worked 2m ·". */
export function stepFacts(steps: Step[]): string[] {
  const kinds = steps.map(stepKind);
  const parts = COUNTS.flatMap(({ kind, verb, one, many }) => {
    const n = kinds.filter((k) => k === kind).length;
    return n ? [`${verb}${n} ${n === 1 ? one : many}`] : [];
  });
  const other = kinds.filter((k) => k === "other").length;
  if (other)
    parts.push(
      `${other} ${parts.length ? "other " : ""}${other === 1 ? "step" : "steps"}`,
    );
  const failed = steps.filter(failedStep).length;
  if (failed) parts.push(`${failed} failed`);
  return parts;
}

/** Seconds → "12s" · "2m" · "2m 5s" (under ten minutes) · "1h 5m". */
export function formatDur(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  const m = Math.floor(sec / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const s = Math.round(sec % 60);
  return m < 10 && s ? `${m}m ${s}s` : `${m}m`;
}
