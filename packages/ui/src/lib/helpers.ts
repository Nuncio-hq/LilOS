/* Small pure helpers shared by the LilOS surfaces. No state, no data. */
import type { PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import type {
  Phase,
  RespondTo,
  SessionLife,
  Status,
  Thread,
  WsPick,
} from "../types";

export const plural = (n: number, w: string) =>
  `${n} ${w}${n === 1 ? "" : "s"}`;
export const baseName = (path: string) => path.split("/").pop() ?? path;
// "LilOS" when the project has one folder (named like it), else "LilOS / Notes".
// A folder with no project (the real app's recents, #113) is just its name.
export const folderLabel = (
  f: { project: string; path: string },
  all: { project: string }[],
) =>
  !f.project
    ? baseName(f.path)
    : all.filter((x) => x.project === f.project).length > 1 ||
        baseName(f.path).toLowerCase() !== f.project.toLowerCase()
      ? `${f.project} / ${baseName(f.path)}`
      : f.project;
export const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : "~";
/* #590 AC-3: a path as the user reads it — macOS resolves /tmp, /var & friends
   through /private (realpath), and showing the synthetic prefix reads like
   an internal. `/private/tmp/x` → `/tmp/x`; everything else passes through. */
export const prettyPath = (path: string) =>
  path.startsWith("/private/") ? path.slice("/private".length) : path;
export const slugOf = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (w) =>
        w &&
        !["a", "an", "the", "with", "on", "for", "of", "to", "and"].includes(w),
    )
    .slice(0, 2)
    .join("-");
export const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/* Flatten markdown through the real parser (the one streamdown renders
   with) so emphasis markers unwrap but a code span or identifier keeps
   its underscores (#417 — the old char regex ate "_" inside
   `LILOS_ENGINE`). Two surfaces share the machinery: preview() joins
   blocks with " · " for the DM card, inline() joins them with one space
   for single-line spots (#448). */
const inlineText = (node: PhrasingContent): string => {
  if (node.type === "break") return " ";
  if (node.type === "image" || node.type === "imageReference")
    return node.alt ?? "";
  if ("children" in node) return node.children.map(inlineText).join("");
  return "value" in node ? node.value : "";
};

const blockLines = (node: RootContent): string[] => {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return [node.children.map(inlineText).join("")];
    case "list":
    case "listItem":
    case "blockquote":
      return node.children.flatMap(blockLines);
    case "code":
      return [node.value];
    default:
      return [];
  }
};

export const preview = (md: string) => {
  try {
    return fromMarkdown(md)
      .children.flatMap(blockLines)
      .map((l) => l.trim())
      .filter(Boolean)
      .reduce(
        (acc, l) => acc + (acc.endsWith(":") ? " " : acc ? " · " : "") + l,
        "",
      );
  } catch {
    return md.replace(/\s+/g, " ").trim();
  }
};

/* One flat line, no " · " separators — the subagent now-line and the
   Start-work title seed (#448). Same parse as preview(); blocks and
   wrapped lines join with a single space. */
export const inline = (md: string) => {
  try {
    return fromMarkdown(md)
      .children.flatMap(blockLines)
      .flatMap((l) => l.split("\n"))
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ");
  } catch {
    return md.replace(/\s+/g, " ").trim();
  }
};

/* The Start-work dialog's title seed: `**@name**` mentions out, the rest
   flattened to one line, capped at 60 chars (#448). */
export const titleSeed = (text: string) =>
  inline(text.replace(/\*\*@\w+\*\*/g, "")).slice(0, 60);

export const PHASE_LABEL: Record<Phase, string> = {
  submitted: "opening thread",
  thinking: "thinking",
  tools: "working",
  waiting: "needs you",
  typing: "replying",
  done: "done",
  stopped: "stopped",
  failed: "failed",
};
export const STATUS_DOT: Record<Status, string> = {
  online: "bg-[#34c759]",
  busy: "bg-[#007aff] animate-pulse",
  offline: "bg-zinc-400",
};
export const RESPOND: Record<RespondTo, string> = {
  me: "Only me",
  selected: "Selected people",
  anyone: "Anyone in the channel",
};

export const NO_WS: WsPick = { folder: null, base: "main", mode: "new" };

/* #344: running while a turn works or any subagent still works (a session
   with live helpers is never idle-closed); a turn waiting on the user is
   open, not running (it never idle-closes either); otherwise the stored
   life. */
export const sessionLife = (t: Thread): SessionLife =>
  t.replies.some(
    (r) =>
      (r.live && r.phase !== "waiting") ||
      r.subagents?.some((s) => s.status === "running"),
  )
    ? "running"
    : t.replies.some((r) => r.live)
      ? "open"
      : (t.life ?? "open");

/* Screen-reader text for the wordless ring. */
export const LIFE_LABEL: Record<SessionLife, string> = {
  running: "Thread running",
  open: "Thread open",
  closed: "Thread closed",
};

/* #583 AC-2: the one state word a DM row says in text — running / needs
   you / failed / stopped. "needs you" wins while any turn waits on the user
   (a parked ask outlives the live flag); a failure card (conv turnFailure
   → thread.alert) or a last turn that ended failed/stopped says so after
   live work stops. Nothing renders when nothing is wrong or in flight. */
export const threadState = (
  t: Thread,
): { word: "needs you" | "running" | "failed" | "stopped" } | undefined => {
  if (t.replies.some((r) => r.phase === "waiting"))
    return { word: "needs you" };
  if (
    t.replies.some(
      (r) => r.live || r.subagents?.some((s) => s.status === "running"),
    )
  )
    return { word: "running" };
  const lastTurn = [...t.replies].reverse().find((r) => r.turnId);
  if (t.alert || lastTurn?.phase === "failed") return { word: "failed" };
  /* `t.stopped` is the row's own stamp (#583): a released session's replies
     carry no turnId, so the live-turn check alone would lose the word. */
  if (t.stopped || lastTurn?.phase === "stopped") return { word: "stopped" };
  return undefined;
};
