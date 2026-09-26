import { describe, expect, it } from "vitest";
import { attachViewer, SessionSurfaces } from "../src/index.js";
import { FakeBrowser, FakePtySpawner } from "./fakes.js";

function setup() {
  const spawner = new FakePtySpawner();
  const browser = new FakeBrowser();
  const scope = new SessionSurfaces({
    session: "s1",
    cwd: "/tmp",
    spawnPty: spawner.spawn,
    createBrowser: async () => browser,
  });
  const sent: unknown[] = [];
  const peer = { send: (t: string) => sent.push(JSON.parse(t)) };
  return { scope, spawner, browser, sent, peer };
}

describe("AC-4 viewer channel: snapshot then live, input both ways", () => {
  it("hello + tail snapshot, then live term/frame/activity events", async () => {
    const { scope, spawner, browser, sent, peer } = setup();
    spawner.last.emit("old output\n");
    await scope.browserOpen({ url: "http://localhost:1" });
    browser.pushFrame([1, 2, 3]);

    const v = attachViewer(scope, peer);
    // hello first, then the backlog: last frame + term tail.
    expect(sent[0]).toMatchObject({
      type: "hello",
      session: "s1",
      url: "http://localhost:1",
    });
    const types = sent
      .slice(1)
      .map((m) => (m as { type: string }).type)
      .sort();
    expect(types).toEqual(["frame", "term"].sort());

    // live events stream after the snapshot
    spawner.last.emit("new out\n");
    expect(sent.at(-1)).toMatchObject({ type: "term" });
    browser.pushFrame([9]);
    expect(sent.at(-1)).toMatchObject({ type: "frame" });

    // takeover input lands on the same PTY/browser the agent drives
    v.receive(JSON.stringify({ type: "term.input", data: "ls\n" }));
    expect(spawner.last.written.at(-1)).toBe("ls\n");
    v.receive(
      JSON.stringify({
        type: "browser.input",
        event: { kind: "mouse", event: "down", x: 1, y: 2, button: "left" },
      }),
    );
    expect(browser.inputs.at(-1)).toMatchObject({ kind: "mouse" });
    v.receive(
      JSON.stringify({ type: "browser.navigate", url: "http://localhost:2" }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(browser.url).toBe("http://localhost:2");

    // agent activity is visible as a feed event
    const p = scope.terminalRun({ command: "true" });
    spawner.last.emit(`${spawner.last.written.join("")}__LILOS_DONE_1__0\n`);
    await p;
    const acts = sent.filter(
      (m) => (m as { type: string }).type === "activity",
    );
    expect(
      acts.some((m) => (m as { tool?: string }).tool === "terminal_run"),
    ).toBe(true);

    // garbage frames don't kill the socket
    v.receive("not json");
    v.receive(JSON.stringify({ type: "nope" }));
    v.detach();
  });
});
