/* Issue #416 AC-1 — the turn footer's "N files changed" counts the files the
   turn's write calls actually touched: edits, new files and deletions — the
   same set Workbench → Changes shows (which reads live git.diff). Counting
   diff paths alone failed in two ways the real Hermes wire produces:

   - every inline diff was stamped path:"(inline)" (the adapter looked for a
     top-level `path` the wire never sends — the path lives in `args`), so a
     two-file turn collapsed to "(inline)" × 1;
   - engines that emit no inline diffs at all (the ACP `tool_call_update`
     path) left files out of the count entirely.

   The tool call's own input names the file it wrote, so a completed
   write_file/patch call counts its `path` (plus the `*** … File:` headers of
   a V4A multi-file patch); the step's diff still counts for tools with no
   file args or no input. A denied/failed call changed nothing — its path
   must not count. */
import { describe, expect, test } from "vitest";
import type { Reply, Step } from "../src/types";
import { turnChangedFiles } from "../src/workbench/artifacts";

const step = (over: Partial<Step>): Step => ({
  tool: "terminal",
  input: {},
  output: "",
  status: "completed",
  ...over,
});

const diff = (path: string, status: "added" | "modified" | "deleted") => ({
  path,
  status,
  add: 1,
  del: 1,
  patch: "@@ x @@",
});

const reply = (over: Partial<Reply>): Reply => ({
  from: "builder",
  time: "",
  text: "",
  ...over,
});

describe("turn footer file count — #416 AC-1", () => {
  test('AC-1 the reported wire shape: diffs stamped "(inline)" still count per call', () => {
    // What the buggy Hermes adapter emitted for the issue's math.ts +
    // math.test.ts turn: real inline diffs, all path:"(inline)". The count
    // must come from the calls' own args — the files Workbench shows.
    const r = reply({
      steps: [
        step({
          tool: "patch",
          input: { path: "math.ts", old_string: "1", new_string: "2" },
          diff: diff("(inline)", "modified"),
        }),
        step({
          tool: "write_file",
          input: { path: "math.test.ts", content: "…" },
          diff: diff("(inline)", "modified"),
        }),
      ],
    });
    expect(turnChangedFiles(r)).toEqual(new Set(["math.ts", "math.test.ts"]));
  });

  test("AC-1 a completed write counts its path even with no diff emitted (ACP)", () => {
    // ACP tool_call_update carries output but no diff — the file still changed.
    const r = reply({
      steps: [
        step({
          tool: "patch",
          input: { path: "a.ts" },
          diff: diff("a.ts", "modified"),
        }),
        step({
          tool: "write_file",
          input: { path: "b.test.ts", content: "…" },
        }),
      ],
    });
    expect(turnChangedFiles(r)).toEqual(new Set(["a.ts", "b.test.ts"]));
  });

  test("AC-1 deletions count: V4A `*** Delete File:` headers name the file", () => {
    // V4A patch mode carries {mode:"patch", patch:"*** …"} — no `path` arg —
    // and one call may add/update/delete several files.
    const r = reply({
      steps: [
        step({
          tool: "patch",
          input: {
            mode: "patch",
            patch:
              "*** Begin Patch\n*** Delete File: old.ts\n*** Update File: keep.ts\n*** End Patch",
          },
          diff: diff("(inline)", "modified"),
        }),
      ],
    });
    expect(turnChangedFiles(r)).toEqual(new Set(["old.ts", "keep.ts"]));
  });

  test("AC-1 a denied or failed write changed nothing — its path stays out", () => {
    const r = reply({
      steps: [
        step({
          tool: "write_file",
          input: { path: "denied.ts" },
          status: "denied",
        }),
        step({ tool: "patch", input: { path: "failed.ts" }, status: "failed" }),
        step({ tool: "patch", input: { path: "ok.ts" } }),
      ],
    });
    expect(turnChangedFiles(r)).toEqual(new Set(["ok.ts"]));
  });

  test("AC-1 read-only tools' path args never count; repeats count once", () => {
    const r = reply({
      steps: [
        step({ tool: "read_file", input: { path: "peek.ts" } }),
        step({ tool: "search_files", input: { path: "src", pattern: "x" } }),
        step({
          tool: "patch",
          input: { path: "same.ts" },
          diff: diff("same.ts", "modified"),
        }),
        step({
          tool: "patch",
          input: { path: "same.ts" },
          diff: diff("same.ts", "modified"),
        }),
      ],
    });
    expect(turnChangedFiles(r)).toEqual(new Set(["same.ts"]));
  });

  test("AC-1 a same-checkout subagent's writes count; another employee's don't", () => {
    const r = reply({
      steps: [step({ tool: "patch", input: { path: "mine.ts" } })],
      subagents: [
        {
          id: "s1",
          name: "helper",
          task: "",
          status: "done",
          steps: [step({ tool: "write_file", input: { path: "helper.ts" } })],
        },
        {
          id: "s2",
          name: "teammate",
          task: "",
          status: "done",
          employee: { id: "rev", session: "sess-9" },
          steps: [step({ tool: "write_file", input: { path: "theirs.ts" } })],
        },
      ],
    });
    expect(turnChangedFiles(r)).toEqual(new Set(["mine.ts", "helper.ts"]));
  });
});
