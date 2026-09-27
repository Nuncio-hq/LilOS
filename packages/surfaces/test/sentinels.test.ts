import { describe, expect, it } from "vitest";
import {
  attachViewer,
  SessionSurfaces,
  ViewerTermFilter,
} from "../src/index.js";
import { FakeBrowser, FakePtySpawner } from "./fakes.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function setup(shellMode = true) {
  const spawner = new FakePtySpawner(shellMode);
  const scope = new SessionSurfaces({
    session: "s1",
    cwd: "/tmp",
    spawnPty: spawner.spawn,
    createBrowser: async () => new FakeBrowser(),
  });
  const sent: Record<string, unknown>[] = [];
  const peer = { send: (t: string) => sent.push(JSON.parse(t)) };
  return { scope, spawner, sent, peer };
}

const termText = (msgs: Record<string, unknown>[]) =>
  msgs
    .filter((m) => m.type === "term")
    .map((m) =>
      dec(
        new Uint8Array([...atob(m.data as string)].map((c) => c.charCodeAt(0))),
      ),
    )
    .join("");

describe("AC-1 the viewer stream never shows terminal sentinels", () => {
  it("the transcript with markers renders without them — echo line and marker output line are dropped", () => {
    const f = new ViewerTermFilter();
    // The real zsh shape: prompt + bracketed-paste sentinel echo + marker line.
    const raw =
      "devin@host ~ % echo hi\r\nhi\r\n" +
      "devin@host ~ % \u001b[?2004hprintf '__LILOS_DONE_1__%s\\n' \"$?\"\u001b[?2004l\r\r\n" +
      "__LILOS_DONE_1__0\r\n" +
      "devin@host ~ % ";
    const out = dec(f.push(enc(raw)));
    expect(out).not.toContain("__LILOS_DONE_");
    expect(out).not.toContain("printf");
    expect(out).toContain("echo hi");
    expect(out).toContain("hi\r\n");
    // The next prompt still arrives — stripping must not eat it.
    expect(out.endsWith("devin@host ~ % ")).toBe(true);
  });

  it("a marker split across chunk boundaries never reaches the viewer", () => {
    const f = new ViewerTermFilter();
    const parts = [
      "$ ls\n",
      "printf '__LIL",
      'OS_DONE_2__%s\\n\' "$?"\n',
      "__LIL",
      "OS_DONE_2__0\n",
      "$ ",
    ];
    let out = "";
    for (const p of parts) out += dec(f.push(enc(p)));
    expect(out).not.toContain("LILOS_DONE");
    expect(out).toContain("$ ls\n");
    expect(out.endsWith("$ ")).toBe(true);
  });

  it("over attachViewer: live chunks and the snapshot tail are clean while the PTY stays raw", async () => {
    const { scope, sent, peer } = setup();
    // Some scrollback BEFORE the viewer attaches must also be clean.
    const run = scope.terminalRun({ command: "echo before" });
    await new Promise((r) => setTimeout(r, 10));
    expect((await run).exitCode).toBe(0);

    const v = attachViewer(scope, peer);
    // backlog arrives stripped
    let transcript = termText(sent);
    expect(transcript).not.toContain("__LILOS_DONE_");
    expect(transcript).not.toContain("printf '__LILOS_DONE");

    // live chunks too
    const run2 = scope.terminalRun({ command: "echo live" });
    await new Promise((r) => setTimeout(r, 10));
    await run2;
    transcript = termText(sent);
    expect(transcript).not.toContain("__LILOS_DONE_");
    expect(transcript).toContain("echo live");

    // …but the agent's own read of the PTY keeps the raw bytes.
    const raw = await scope.terminalRead({});
    expect(raw.output).toContain("__LILOS_DONE_");
    v.detach();
  });

  it("partial lines flush immediately — only a live marker prefix is held", () => {
    const f = new ViewerTermFilter();
    // A prompt is an unterminated line; it must render without waiting for \n.
    expect(dec(f.push(enc("devin@host ~ % ")))).toBe("devin@host ~ % ");
    // Interactive typing echoes one char at a time — no buffering.
    expect(dec(f.push(enc("x")))).toBe("x");
    // A trailing marker prefix is held back, then released when it proves
    // to be ordinary text.
    expect(dec(f.push(enc("count: __LI")))).toBe("count: ");
    expect(dec(f.push(enc("KE")))).toBe("__LIKE");
  });
});
