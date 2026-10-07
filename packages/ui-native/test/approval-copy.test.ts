import { describe, expect, it } from "vitest";
import {
  approvalSentence,
  describeAsk,
  whatLine,
} from "../src/employees/approval-copy";

/* #264: the card's one sentence — "<employee> wants to run" when the ask's
   reason is only the command echoed back (the engine's own "wants to run:
   <cmd>" template or the raw command); a reason that says something else is
   a real why and stays. */

describe("approvalSentence — the card says the command once", () => {
  it("a reason that is the command reads '<employee> wants to run'", () => {
    expect(
      approvalSentence({
        employee: "Ada",
        reason: "git commit -m 'ship it'",
        command: "git commit -m 'ship it'",
      }),
    ).toBe("Ada wants to run");
  });

  it("an engine description echoing the command also reads '<employee> wants to run'", () => {
    expect(
      approvalSentence({
        employee: "Ada",
        reason: "terminal wants to run: git commit -m 'ship it'",
        command: "git commit -m 'ship it'",
      }),
    ).toBe("Ada wants to run");
  });

  it("a reason that is a real why — not the command — stays", () => {
    expect(
      approvalSentence({
        employee: "Ada",
        reason: "Needs the migration in before the relay tests can pass.",
        command: "bun run db:migrate --env dev",
      }),
    ).toBe("Needs the migration in before the relay tests can pass.");
  });

  it("no command (question/file ask) → the reason as-is", () => {
    expect(
      approvalSentence({ employee: "Ada", reason: "Keep it or drop it?" }),
    ).toBe("Keep it or drop it?");
  });
});

/* #652 AC-2: one human description for every ask surface — a file tool
   reads "wants to edit/write <basename>" with the full path as detail, a
   real shell command keeps its `$` box, an unknown tool reads
   "wants to use <tool>" with the args behind a tap. The line never shows
   raw JSON (`{`, `"path"`) or a `$ ` prompt. */

describe("describeAsk — one human line per ask", () => {
  it("write_file → 'wants to write <basename>' + the full path as detail", () => {
    const d = describeAsk('write_file {"path":"docs/decisions/0002-notes.md"}');
    expect(d?.line).toBe("wants to write 0002-notes.md");
    expect(d?.detail).toBe("docs/decisions/0002-notes.md");
    expect(d?.line).not.toContain("{");
    expect(d?.line).not.toContain('"path"');
    expect(d?.line).not.toContain("$ ");
  });

  it("patch → 'wants to edit <basename>'", () => {
    const d = describeAsk('patch {"path":"README.md"}');
    expect(d?.line).toBe("wants to edit README.md");
    expect(d?.line).not.toContain("{");
    expect(d?.line).not.toContain('"path"');
    expect(d?.line).not.toContain("$ ");
  });

  it("read_file → 'wants to read <basename>'", () => {
    expect(describeAsk('read_file {"path":"src/a.ts"}')?.line).toBe(
      "wants to read a.ts",
    );
  });

  it("an unknown tool → 'wants to use <tool>', args as detail", () => {
    const d = describeAsk('frobnicate {"x":1,"path":"a"}');
    expect(d?.line).toBe("wants to use frobnicate");
    expect(d?.line).not.toContain("{");
    expect(d?.line).not.toContain('"path"');
    expect(d?.line).not.toContain("$ ");
    expect(d?.detail).toBe('{"x":1,"path":"a"}');
  });

  it("a terminal/tool-call shell command keeps the `$` box", () => {
    const d = describeAsk('terminal {"command":"bun test apps"}');
    expect(d?.boxed).toBe("bun test apps");
  });

  it("a raw shell command keeps the `$` box as-is", () => {
    const d = describeAsk('git commit -am "update the readme title"');
    expect(d?.boxed).toBe('git commit -am "update the readme title"');
  });

  it("the one-line surfaces' whatLine is human too", () => {
    const a = {
      employee: "Ada",
      reason: 'Ada wants to run: patch {"path":"README.md"}',
      command: 'patch {"path":"README.md"}',
    };
    expect(whatLine(a)).toBe("Ada wants to edit README.md");
    expect(whatLine(a)).not.toContain("{");
    expect(whatLine(a)).not.toContain('"path"');
    expect(whatLine(a)).not.toContain("$ ");
  });

  it("a one-line row keeps the full path — 'wants to write <path>'", () => {
    const a = {
      employee: "Ada",
      reason:
        'Ada wants to run: write_file {"path":"docs/decisions/0002-notes.md"}',
      command: 'write_file {"path":"docs/decisions/0002-notes.md"}',
    };
    expect(whatLine(a)).toBe("Ada wants to write docs/decisions/0002-notes.md");
    expect(whatLine(a)).not.toContain("{");
    expect(whatLine(a)).not.toContain('"path"');
  });

  it("a shell command still flows through whatLine with keepFlags", () => {
    const a = {
      employee: "Ada",
      reason: 'Ada wants to run: git commit -am "x"',
      command: 'git commit -am "x"',
    };
    expect(whatLine(a)).toContain("wants to run");
    expect(whatLine(a)).toContain("git commit");
  });
});
