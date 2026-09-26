import { describe, expect, it } from "vitest";
import { attachViewer, SessionSurfaces, toolBackend } from "../src/index.js";
import { FakeBrowser, FakePtySpawner, serveToolApi } from "./fakes.js";

function setup(shellMode = true) {
  const spawner = new FakePtySpawner(shellMode);
  const browser = new FakeBrowser();
  const scope = new SessionSurfaces({
    session: "s1",
    cwd: "/tmp",
    spawnPty: spawner.spawn,
    createBrowser: async () => browser,
  });
  const sent: Record<string, unknown>[] = [];
  const peer = { send: (t: string) => sent.push(JSON.parse(t)) };
  return { scope, spawner, browser, sent, peer };
}

describe("AC-1 typing into the Terminal tab takes the terminal from the agent", () => {
  it("user keystrokes mark control; terminal_run/terminal_write get user_control until an explicit release", async () => {
    const { scope, spawner } = setup();

    // Baseline: the agent drives freely while no one is typing.
    await expect(
      scope.terminalRun({ command: "echo ok" }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(scope.snapshot().control).toEqual({ terminal: "agent" });

    // Oscar types into the Workbench terminal → takeover.
    scope.terminalInput("l");
    scope.terminalInput("s");
    expect(scope.snapshot().control).toEqual({ terminal: "user" });
    // The keystrokes still land in the same shell the agent uses.
    expect(spawner.last.written.slice(-2)).toEqual(["l", "s"]);

    // The agent's next tool calls get a clear result instead of silently
    // interleaving with the human's input.
    await expect(
      scope.terminalRun({ command: "echo nope" }),
    ).rejects.toMatchObject({ code: "user_control" });
    await expect(scope.terminalWrite({ data: "x" })).rejects.toMatchObject({
      code: "user_control",
    });
    // Reads stay open — the agent can keep watching.
    await expect(scope.terminalRead({})).resolves.toHaveProperty("output");

    // Release is explicit; afterwards the agent drives again.
    scope.terminalRelease();
    expect(scope.snapshot().control).toEqual({ terminal: "agent" });
    await expect(
      scope.terminalRun({ command: "echo back" }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("a terminal_run already in flight fails with user_control on takeover", async () => {
    const { scope } = setup(false); // plain PTY: the run never self-resolves
    const run = scope.terminalRun({ command: "sleep 5", timeoutMs: 60_000 });
    const seen = run.catch((e) => e);
    scope.terminalInput("x");
    await expect(seen).resolves.toMatchObject({ code: "user_control" });
  });

  it("control travels on the wire: hello carries it, term.control announces changes, term.release resets", async () => {
    const { scope, sent, peer } = setup();
    const v = attachViewer(scope, peer);
    expect(sent[0]).toMatchObject({
      type: "hello",
      control: { terminal: "agent" },
    });

    v.receive(JSON.stringify({ type: "term.input", data: "x" }));
    expect(sent.at(-1)).toEqual({ type: "term.control", holder: "user" });

    v.receive(JSON.stringify({ type: "term.release" }));
    expect(sent.at(-1)).toEqual({ type: "term.control", holder: "agent" });

    // A freshly attached viewer inherits the current control state.
    scope.terminalInput("y");
    const sent2: Record<string, unknown>[] = [];
    const v2 = attachViewer(scope, {
      send: (t) => sent2.push(JSON.parse(t)),
    });
    expect(sent2[0]).toMatchObject({
      type: "hello",
      control: { terminal: "user" } as unknown,
    });
    v2.detach();
    v.detach();
  });

  it("when the last viewer detaches, a held terminal returns to the agent", async () => {
    const { scope, peer } = setup();
    const v = attachViewer(scope, peer);
    v.receive(JSON.stringify({ type: "term.input", data: "x" }));
    expect(scope.snapshot().control).toEqual({ terminal: "user" });
    v.detach();
    // Nobody is left to type → the agent must not stay locked out.
    expect(scope.snapshot().control).toEqual({ terminal: "agent" });
    await expect(
      scope.terminalRun({ command: "echo ok" }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("with two viewers, one typing then leaving keeps the hold until an explicit release", async () => {
    const { scope, peer } = setup();
    const sent2: Record<string, unknown>[] = [];
    const a = attachViewer(scope, peer);
    const b = attachViewer(scope, {
      send: (t) => sent2.push(JSON.parse(t)),
    });
    a.receive(JSON.stringify({ type: "term.input", data: "x" }));
    a.detach();
    // B is still attached → the hold survives A's detach.
    expect(scope.snapshot().control).toEqual({ terminal: "user" });
    await expect(
      scope.terminalRun({ command: "echo nope" }),
    ).rejects.toMatchObject({ code: "user_control" });
    b.receive(JSON.stringify({ type: "term.release" }));
    expect(scope.snapshot().control).toEqual({ terminal: "agent" });
    b.detach();
  });

  it("over the tool HTTP API a held terminal answers 409 user_control", async () => {
    const { scope } = setup();
    const { server, baseUrl } = await serveToolApi({
      session: "s1",
      token: "t",
      scope,
    });
    try {
      const client = toolBackend({ baseUrl, token: "t", session: "s1" });
      scope.terminalInput("x");
      await expect(client.terminalRun({ command: "echo hi" })).rejects.toThrow(
        /409/,
      );
      const res = await fetch(`${baseUrl}/tools/terminal_run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer t",
          "x-lilos-session": "s1",
        },
        body: JSON.stringify({ command: "echo hi" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: "user_control" },
      });
    } finally {
      server.close();
    }
  });
});

describe("AC-4 the preview viewport follows the pane", () => {
  it("browser.resize resizes the owned page and announces the new box", async () => {
    const { scope, browser, sent, peer } = setup();
    await scope.browserOpen({ url: "http://localhost:1" });
    const v = attachViewer(scope, peer);
    v.receive(
      JSON.stringify({ type: "browser.resize", width: 640, height: 480 }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(browser.viewport).toEqual({ width: 640, height: 480 });
    expect(scope.snapshot().page).toEqual({ width: 640, height: 480 });
    expect(sent.at(-1)).toEqual({
      type: "page",
      page: { width: 640, height: 480 },
    });
    v.detach();
  });

  it("a resize sent before the browser exists is applied when it spawns", async () => {
    const { scope, browser, peer } = setup();
    const v = attachViewer(scope, peer);
    v.receive(
      JSON.stringify({ type: "browser.resize", width: 500, height: 300 }),
    );
    await new Promise((r) => setTimeout(r, 10));
    await scope.browserOpen({ url: "http://localhost:1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(browser.viewport).toEqual({ width: 500, height: 300 });
    expect(scope.snapshot().page).toEqual({ width: 500, height: 300 });
    v.detach();
  });
});
