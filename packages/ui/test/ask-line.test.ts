/* Issue #884: one shared summariser turns a tool + its args into the plain
   question every approval surface shows — "Edit README.md?", never raw JSON. */
import { describe, expect, test } from "vitest";
import { askNote, summariseAsk } from "../src/conversation/ask-line";

describe("issue #884 — summariseAsk()", () => {
  test("patch / edit tools → Edit <file>?", () => {
    expect(summariseAsk('patch {"path":"README.md"}')).toBe("Edit README.md?");
    expect(summariseAsk('edit_file {"path":"src/a.ts"}')).toBe(
      "Edit src/a.ts?",
    );
    expect(summariseAsk('apply_patch {"file":"b.css"}')).toBe("Edit b.css?");
  });

  test("write tools → Write <file>?", () => {
    expect(summariseAsk('write_file {"path":"docs/notes.md"}')).toBe(
      "Write docs/notes.md?",
    );
  });

  test("terminal / run → Run `cmd`, naming the folder", () => {
    expect(
      summariseAsk('terminal {"command":"bun run verify"}', "/home/o/lilos"),
    ).toBe("Run `bun run verify` in lilos?");
    expect(summariseAsk('terminal {"command":"bun run verify"}')).toBe(
      "Run `bun run verify`?",
    );
  });

  test("a raw shell command gets the same Run treatment", () => {
    expect(summariseAsk("git commit -am fix", "/home/o/lilos")).toBe(
      "Run `git commit -am fix` in lilos?",
    );
  });

  test("delete counts its files", () => {
    expect(summariseAsk('delete_files {"paths":["a.ts","b.ts","c.ts"]}')).toBe(
      "Delete 3 files?",
    );
    expect(summariseAsk('delete_file {"path":"a.ts"}')).toBe("Delete a.ts?");
  });

  test("fetch shows the url without the scheme", () => {
    expect(summariseAsk('web_fetch {"url":"https://example.com/docs/x"}')).toBe(
      "Fetch example.com/docs/x?",
    );
  });

  test("MCP tools name server + tool", () => {
    expect(summariseAsk('mcp__linear__list_issues {"team":"eng"}')).toBe(
      "Use linear's list issues?",
    );
  });

  test("unknown tools and bare JSON fall back to readable sentences", () => {
    expect(summariseAsk('run_code {"lang":"py"}')).toBe("Use run code?");
    expect(summariseAsk('{"command":"ls -la"}')).toBe("Run `ls -la`?");
    expect(summariseAsk("")).toBe("Approve this step?");
  });

  test("prose asks (ACP titles, gateway asks) keep their own words", () => {
    expect(summariseAsk("Edit README.md")).toBe("Edit README.md?");
    expect(summariseAsk("Cursor wants to run the suite.")).toBe(
      "Cursor wants to run the suite?",
    );
    expect(
      summariseAsk("Spend $40 on a 3-day Meta Ads test of the hooks."),
    ).toBe("Spend $40 on a 3-day Meta Ads test of the hooks?");
  });

  test("long commands truncate inside the backticks", () => {
    const long = `bun ${"x".repeat(90)}`;
    const out = summariseAsk(long);
    expect(out.length).toBeLessThan(84);
    expect(out).toContain("…");
  });
});

describe("issue #884 — askNote()", () => {
  test("the 'wants to run' echo hides", () => {
    expect(
      askNote(
        'patch {"path":"README.md"}',
        'patch wants to run: patch {"path":"README.md"}',
      ),
    ).toBeUndefined();
  });

  test("a note that repeats the command hides", () => {
    expect(askNote("git status", "git status")).toBeUndefined();
  });

  test("real extra context stays", () => {
    expect(askNote("rm -rf x", "Destructive — cannot be undone.")).toBe(
      "Destructive — cannot be undone.",
    );
  });
});
