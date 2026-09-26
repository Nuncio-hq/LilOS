/* Small pure helpers shared by the LilOS surfaces. No state, no data. */
import type { Phase, RespondTo, Status, WsPick } from "../types";

export const plural = (n: number, w: string) =>
  `${n} ${w}${n === 1 ? "" : "s"}`;
export const baseName = (path: string) => path.split("/").pop() ?? path;
// "LilOS" when the project has one folder (named like it), else "LilOS / Notes".
export const folderLabel = (
  f: { project: string; path: string },
  all: { project: string }[],
) =>
  all.filter((x) => x.project === f.project).length > 1 ||
  baseName(f.path).toLowerCase() !== f.project.toLowerCase()
    ? `${f.project} / ${baseName(f.path)}`
    : f.project;
export const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "~";
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

/* One-line preview of a markdown reply: drop markers, join blocks with " · ". */
export const preview = (md: string) =>
  md
    .split(/\n+/)
    .map((l) =>
      l
        .replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")
        .replace(/[*`#_]/g, "")
        .trim(),
    )
    .filter(Boolean)
    .join(" · ");

export const PHASE_LABEL: Record<Phase, string> = {
  submitted: "opening session",
  thinking: "thinking",
  tools: "working",
  typing: "replying",
  done: "done",
  stopped: "stopped",
};
export const STATUS_DOT: Record<Status, string> = {
  online: "bg-emerald-500",
  busy: "bg-amber-500 animate-pulse",
  offline: "bg-zinc-400",
};
export const RESPOND: Record<RespondTo, string> = {
  me: "Only me",
  selected: "Selected people",
  anyone: "Anyone in the channel",
};

export const NO_WS: WsPick = { folder: null, base: "main", mode: "new" };
