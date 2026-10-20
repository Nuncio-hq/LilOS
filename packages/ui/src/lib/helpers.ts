/* Small pure helpers shared by the LilOS surfaces. No state, no data. */
import type { PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Phase, SessionLife, Status, Thread } from "../types";

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
export const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/* Flatten markdown through the real parser (the one streamdown renders
   with) so emphasis markers unwrap but a code span or identifier keeps
   its underscores (#417 — the old char regex ate "_" inside
   `LILOS_ENGINE`). inline() joins the blocks with one space for
   single-line spots (#448). */
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

const parseInline = (md: string) => {
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

/* #569: a row's one-line text was re-parsed on every streamed word — the
   profile's single biggest block. Parse once per distinct text. The map is
   FIFO-bounded: a growing stream mints a fresh key per delta and the dead
   prefixes never re-hit, so an unbounded map would just leak them. */
const textCache = (cap: number) => {
  const m = new Map<string, string>();
  return (text: string, parse: (t: string) => string): string => {
    const hit = m.get(text);
    if (hit !== undefined) return hit;
    const out = parse(text);
    if (m.size >= cap) {
      const oldest = m.keys().next().value;
      if (oldest !== undefined) m.delete(oldest);
    }
    m.set(text, out);
    return out;
  };
};
const inlineCached = textCache(256);

/* One flat line — the subagent now-line (#448). Blocks and wrapped lines
   join with a single space. */
export const inline = (md: string) => inlineCached(md, parseInline);

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

/* #344: running while a turn works or any subagent still works (a session
   with live helpers is never idle-closed); a turn waiting on the user is
   open, not running (it never idle-closes either); otherwise the stored
   life. D-#346: this is THE life derivation — the wire stores only the
   host's open/closed bit (closed = idle-suspended); `running` is never
   stored. Mobile can't import it and ports it in toSessionTurn
   (apps/mobile/src/dm-model.ts) off conversation state, which carries no
   subagent bit. Not: a second derivation with its own rule. */
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
