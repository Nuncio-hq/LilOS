import type { Diff, Step, V3Attachment, V3Step, V3StepKind, V3Workbench } from "@lilos/ui"

/* The prototype's mock steps (V3Step: a verb, a target, a count) in the shape
   the real thread view reads (Step: a tool call with input and output).
   Nothing is invented: the target becomes the call's argument, the meta its
   output, and a diff is attached only where the mock workbench has one. */

/** A unified patch from the mock's diff lines, with its hunk header. */
export function patchOf(lines: { kind: "add" | "del" | "ctx"; text: string }[]): string {
  const old = lines.filter((l) => l.kind !== "add").length
  const next = lines.filter((l) => l.kind !== "del").length
  const mark = { add: "+", del: "-", ctx: " " } as const
  return [`@@ -1,${old} +1,${next} @@`, ...lines.map((l) => mark[l.kind] + l.text)].join("\n")
}

/** The workbench's changed files as the real Diff rows. */
export function diffsOf(wb: V3Workbench | undefined): Diff[] {
  return (wb?.diffs ?? []).map((d) => ({
    path: d.path,
    status: d.del === 0 && d.lines.every((l) => l.kind === "add") ? "added" : "modified",
    add: d.add,
    del: d.del,
    patch: patchOf(d.lines),
  }))
}

const TOOL = {
  read: "read_file",
  search: "search_files",
  edit: "patch",
  run: "terminal",
  web: "web_search",
  delegate: "delegate_task",
} as const

const INPUT_KEY = {
  read: "path",
  search: "pattern",
  edit: "path",
  run: "command",
  web: "query",
  delegate: "goal",
} as const

/** A thinking step is the turn's reasoning, not a tool call. */
export type ToolStep = V3Step & { kind: Exclude<V3StepKind, "think"> }
export const isTool = (s: V3Step): s is ToolStep => s.kind !== "think"

/** One mock step as a tool call. `live` is what the running command has printed so far. */
export function stepOf(s: ToolStep, diffs: Diff[], live?: string[]): Step {
  const { kind } = s
  const tool = TOOL[kind]
  const known = s.kind === "edit" ? diffs.find((d) => d.path === s.target) : undefined
  const meta = [
    s.meta ?? (s.add !== undefined || s.del !== undefined ? `+${s.add ?? 0} −${s.del ?? 0}` : ""),
    s.where,
  ]
    .filter(Boolean)
    .join(" · ")
  return {
    tool,
    input: { [INPUT_KEY[kind]]: s.target },
    output: s.running && live ? live.join("\n") : meta,
    ...(s.running ? { running: true, status: "running" as const } : {}),
    ...(s.failed ? { status: "failed" as const } : {}),
    ...(known ? { diff: known } : {}),
  }
}

/** Steps a turn's attachments imply: a diff card is the file's edit, a PR card
    is the `gh pr create` that opened it. Skipped when the turn already shows
    the same step. */
export function attachmentSteps(
  attachments: V3Attachment[] | undefined,
  steps: Step[],
): Step[] {
  const extra: Step[] = []
  for (const a of attachments ?? []) {
    if (a.kind === "diff" && !steps.some((s) => s.diff?.path === a.path)) {
      const diff: Diff = {
        path: a.path,
        status: "modified",
        add: a.add,
        del: a.del,
        patch: patchOf(a.lines),
      }
      extra.push({
        tool: "patch",
        input: { path: a.path },
        output: `+${a.add} −${a.del}`,
        diff,
      })
    }
    if (
      a.kind === "pr" &&
      !steps.some((s) => String(s.input.command ?? "").startsWith("gh pr create"))
    )
      extra.push({
        tool: "terminal",
        input: { command: "gh pr create --fill" },
        output: `#${a.num} ${a.title}`,
      })
  }
  return extra
}

/** What the real reply has no card for (a screenshot, a sheet): a line under the answer. */
export function attachedLine(attachments: V3Attachment[] | undefined): string {
  const names = (attachments ?? []).flatMap((a) =>
    a.kind === "image" ? [a.label] : a.kind === "sheet" ? [`${a.name} (${a.rows} rows)`] : [],
  )
  return names.length ? `\n\nAttached: ${names.join(", ")}` : ""
}
