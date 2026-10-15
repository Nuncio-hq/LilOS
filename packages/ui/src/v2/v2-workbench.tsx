import { useMemo, useState } from "react";
import { cn } from "../lib/utils";
import type {
  Diff,
  Human,
  PullRequest,
  Reply,
  Step,
  Thread,
  WbTab,
  Work,
} from "../types";
import { Workbench } from "../workbench/workbench";
import type { V2Msg, V2Project, V2Step, V2Thread } from "./v2-types";

/* The v1 Workbench (Changes, Files, Terminal, Preview, PR) docked to the
   right of a v2 thread. The prototype keeps v2 view models, so this file
   maps them to the Workbench's session shape: every tool call becomes a
   step, every changed file a diff, every command a terminal run. */

const TOOL: Record<V2Step["kind"], string> = {
  read: "read_file",
  edit: "patch",
  bash: "terminal",
  search: "search_files",
  web: "web_search",
  task: "delegate_task",
};

const ext = (p: string) => p.split(".").pop() ?? "";

/** A small unified patch for one changed file: the preview lines when the
    message has them, else placeholder rows sized to the counts. */
function patchFor(msg: V2Msg, path: string, add: number, del: number): string {
  if (msg.preview?.path === path) {
    const body = msg.preview.lines.map(
      (l) =>
        `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`,
    );
    const a = msg.preview.lines.filter((l) => l.kind !== "add").length;
    const b = msg.preview.lines.filter((l) => l.kind !== "del").length;
    return [`@@ -1,${a} +1,${b} @@`, ...body].join("\n");
  }
  const comment = ["ts", "tsx", "js"].includes(ext(path)) ? "//" : "#";
  const rows = [
    ...Array.from(
      { length: Math.min(del, 3) },
      (_, i) => `-${comment} old line ${i + 1}`,
    ),
    ...Array.from(
      { length: Math.min(add, 4) },
      (_, i) => `+${comment} new line ${i + 1}`,
    ),
  ];
  return [`@@ -1,${Math.min(del, 3)} +1,${Math.min(add, 4)} @@`, ...rows].join(
    "\n",
  );
}

function stepFor(s: V2Step, msg: V2Msg): Step {
  const input: Record<string, unknown> =
    s.kind === "bash"
      ? { command: s.target }
      : s.kind === "search" || s.kind === "web"
        ? { query: s.target }
        : { path: s.target };
  const step: Step = {
    tool: TOOL[s.kind],
    input,
    output: s.meta ?? "",
    status: s.failed ? "failed" : "completed",
  };
  if (s.kind === "edit") {
    const add = s.add ?? 0;
    const del = s.del ?? 0;
    const diff: Diff = {
      path: s.target,
      status: del === 0 && add > 0 ? "added" : "modified",
      add,
      del,
      patch: patchFor(msg, s.target, add, del),
    };
    step.diff = diff;
  }
  return step;
}

/** One v2 thread as the Workbench's session. */
export function toSession(t: V2Thread, agentName: string): Thread {
  const replies: Reply[] = t.messages.map((m) => ({
    from: m.from === "you" ? "user" : "agent",
    time: m.time,
    text: m.text,
    steps: m.work?.map((s) => stepFor(s, m)),
  }));
  if (t.live) {
    replies.push({
      from: "agent",
      time: "now",
      text: "",
      live: true,
      steps: [
        {
          ...stepFor(t.live.step, { from: "agent", time: "now", text: "" }),
          output: (t.live.tail ?? []).join("\n"),
          running: true,
          status: "running",
        },
      ],
    });
  }
  const prLine = t.messages.map((m) => /PR #(\d+)/.exec(m.text)).find(Boolean);
  const pr: PullRequest | undefined = prLine
    ? {
        number: Number(prLine[1]),
        repo: "Nuncio-hq/LilOS",
        title: t.title,
        body: "",
        status: "open",
        draft: true,
        author: agentName,
        base: "main",
        head: `lilos/${t.id}`,
        opened: "today",
        checks: [
          { name: "verify", status: "passed" },
          { name: "e2e", status: "pending" },
        ],
        comments: [],
      }
    : undefined;
  return {
    session: t.id,
    title: t.title,
    model: t.model,
    replies,
    pr,
  };
}

const REPO_FILES = [
  "AGENTS.md",
  "README.md",
  "package.json",
  "docs/index.html",
  "apps/relay/src/db.ts",
  "packages/ui/src/v2/v2-shell.tsx",
  "packages/ui/src/v2/v2-sidebar.tsx",
  "packages/contracts/src/harness/tools.ts",
  "e2e/ac-544-workbench-reopen.spec.ts",
];

/* The docked panel. It mounts once opened and stays mounted while hidden so
   reopening is instant and keeps its tab. */
export function V2WorkbenchPanel({
  t,
  project,
  agentName,
  me,
  open,
  onClose,
  onSend,
  say,
}: {
  t: V2Thread;
  project?: V2Project;
  agentName: string;
  /** The signed-in person's display name (PR author lines, comments). */
  me: string;
  open: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
  say?: (text: string) => void;
}) {
  const [tab, setTab] = useState<WbTab>("changes");
  const session = useMemo(() => toSession(t, agentName), [t, agentName]);
  const work: Work | null = project?.path
    ? {
        ticket: t.id.toUpperCase(),
        branch: `lilos/${t.id}`,
        title: t.title,
        path: project.path,
      }
    : null;
  return (
    <aside
      aria-label="Workbench"
      data-v2-workbench
      className={cn(
        "lilos-v2-sheet flex min-h-0 w-[min(46%,640px)] min-w-[380px] shrink-0 flex-col overflow-hidden border-foreground/[0.07] border-l bg-[var(--v2-main)]",
        !open && "hidden",
      )}
    >
      <Workbench
        thread={session}
        work={work}
        isDM
        tab={tab}
        setTab={setTab}
        onClose={onClose}
        onSend={onSend}
        say={say}
        repoFiles={REPO_FILES}
        human={(id): Human =>
          id === "user"
            ? { name: me, color: "#0a84ff" }
            : { name: agentName, color: "#af52de" }
        }
        running={t.state === "working"}
      />
    </aside>
  );
}
