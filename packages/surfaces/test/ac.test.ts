import { toolsForSession } from "@lilos/contracts/harness";
import { describe, expect, it, vi } from "vitest";
import {
  callTool,
  SESSION_HEADER,
  SessionSurfaces,
  toolBackend,
} from "../src/index.js";
import {
  FakeBrowser,
  FakePtySpawner,
  fakeAppOps,
  serveGateway,
} from "./fakes.js";

function makeScope(overrides: {
  browser?: FakeBrowser;
  appOps?: ReturnType<typeof fakeAppOps>;
  spawner?: FakePtySpawner;
  createBrowser?: () => Promise<FakeBrowser>;
  browserOpTimeoutMs?: number;
  /** This session held the CEO position at start (D-#778). */
  ceoAtStart?: boolean;
}) {
  const spawner = overrides.spawner ?? new FakePtySpawner();
  const browser = overrides.browser ?? new FakeBrowser();
  const scope = new SessionSurfaces({
    session: "s1",
    cwd: "/tmp",
    spawnPty: spawner.spawn,
    createBrowser: overrides.createBrowser ?? (async () => browser),
    ...(overrides.appOps ? { appOps: overrides.appOps } : {}),
    // Production pairs appOps with its session binding — the fake mirrors it.
    binding: {
      employeeId: "emp-fake",
      channelId: "c1",
      conversationId: "conv1",
    },
    ...(overrides.ceoAtStart ? { ceoAtStart: true } : {}),
    ...(overrides.browserOpTimeoutMs !== undefined
      ? { browserOpTimeoutMs: overrides.browserOpTimeoutMs }
      : {}),
  });
  return { scope, spawner, browser };
}

describe("AC-1 harness owns browser and PTY, alive with no viewers", () => {
  it("terminal_run works with zero viewers", async () => {
    const { scope, spawner } = makeScope({});
    expect(scope.viewerCount).toBe(0);
    const p = scope.terminalRun({ command: "echo hi" });
    spawner.last.emit(
      `${spawner.last.written.join("")}hi\n__LILOS_DONE_1__0\n`,
    );
    await expect(p).resolves.toMatchObject({ output: "hi", exitCode: 0 });
  });

  it("browser ops work with zero viewers, screencast only while watched", async () => {
    const { scope, spawner, browser } = makeScope({});
    await scope.browserOpen({ url: "http://localhost:3000" });
    expect(browser.url).toBe("http://localhost:3000");
    expect(browser.casting).toBe(false);

    const un = scope.subscribe(() => {});
    expect(browser.casting).toBe(true);
    un();
    expect(browser.casting).toBe(false);

    // The PTY respawns itself after the shell exits — `exit` can't wedge it.
    const first = spawner.last;
    first.exit(0);
    expect(spawner.instances.length).toBe(2);
    const p = scope.terminalRun({ command: "true" });
    spawner.last.emit(`${spawner.last.written.join("")}__LILOS_DONE_1__0\n`);
    await expect(p).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe("AC-4 (#84) a wedged driver call must not pin the resize serializer", () => {
  it("times out the stalled resize, rebuilds the browser, and converges on the latest size", async () => {
    // The losing ordering from the e2e flake: playwright's setViewportSize
    // stalls under load → every later browserResize returns early on the
    // pinned serializer → the pane-fit poll sees stale dims forever.
    const browsers: FakeBrowser[] = [];
    const scope = new SessionSurfaces({
      session: "s1",
      cwd: "/tmp",
      spawnPty: new FakePtySpawner().spawn,
      browserOpTimeoutMs: 50,
      createBrowser: async () => {
        const b = new FakeBrowser();
        if (browsers.length === 0) {
          // First browser wedges inside resize and never resolves.
          b.resize = () => new Promise<void>(() => {});
        }
        browsers.push(b);
        return b;
      },
    });

    await scope.browserOpen({ url: "http://localhost:1" });
    scope.browserResize(800, 600); // wedges on browser 1
    scope.browserResize(1000, 640); // must still land

    await vi.waitFor(
      () => {
        expect(browsers.length).toBeGreaterThanOrEqual(2);
        expect(browsers[0]?.closed).toBe(true);
        expect(browsers[1]?.viewport).toEqual({ width: 1000, height: 640 });
      },
      { timeout: 5_000 },
    );
  });
});

describe("AC-5 preview discovery via PTY scan + PREVIEW: marker", () => {
  it("finds dev-server URLs in terminal output, marker overrides", async () => {
    const { scope, spawner } = makeScope({});
    spawner.last.emit(
      "$ bun run dev\n  ➜  Local:   \u001b[36mhttp://localhost:5173/\u001b[0m\n",
    );
    expect(await scope.workbenchPreviews()).toEqual({
      previews: [{ url: "http://localhost:5173", via: "scan" }],
    });
    // A silent server announces itself with the marker (spike convention).
    spawner.last.emit("PREVIEW: http://localhost:9000/app\n");
    const list = await scope.workbenchPreviews();
    expect(list.previews).toContainEqual({
      url: "http://localhost:9000/app",
      via: "marker",
    });
    // 0.0.0.0 is a bind address, not a browse target.
    spawner.last.emit(
      "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/)\n",
    );
    expect((await scope.workbenchPreviews()).previews).toContainEqual({
      url: "http://localhost:8000",
      via: "scan",
    });
  });
});

describe("AC-2 one op set: dispatch, HTTP tool API, client", () => {
  async function serve() {
    const appOps = fakeAppOps();
    const { scope, spawner, browser } = makeScope({ appOps });
    const api = await serveGateway({
      sessions: [{ scope, token: "tok" }],
    });
    return {
      server: api.server,
      spawner,
      browser,
      appOps,
      client: toolBackend({
        baseUrl: api.baseUrl,
        token: "tok",
        session: "s1",
      }),
      url: api.baseUrl,
    };
  }

  it("every op round-trips over HTTP with the same shape", async () => {
    const { server, client, spawner, browser, appOps } = await serve();
    try {
      // terminal_run crosses the wire and reaches the session's real PTY.
      const run = client.terminalRun({ command: "echo ok" });
      // The emitted output must echo this run's write — wait for the HTTP
      // request to land it in the PTY, not for a wall-clock sleep (#380).
      await vi.waitFor(() => {
        expect(spawner.last.written.join("")).toContain("__LILOS_DONE_1__");
      });
      spawner.last.emit(
        `${spawner.last.written.join("")}ok\n__LILOS_DONE_1__0\n`,
      );
      await expect(run).resolves.toMatchObject({ exitCode: 0, output: "ok" });

      await expect(
        client.browserOpen({ url: "http://localhost:1" }),
      ).resolves.toMatchObject({ url: "http://localhost:1" });
      await client.browserClick({ selector: "#go" });
      expect(browser.clicks).toEqual(["#go"]);
      await client.browserType({ text: "hi", selector: "#f" });
      await client.browserScroll({ dy: 10 });
      await expect(client.browserEval({ expression: "1+1" })).resolves.toEqual({
        value: null,
      });
      expect(await client.browserRead()).toMatchObject({
        url: "http://localhost:1",
      });
      await client.terminalWrite({ data: "x" });
      expect(spawner.last.written.at(-1)).toBe("x");
      expect(await client.terminalRead({})).toHaveProperty("output");
      expect(await client.workbenchPreviews()).toEqual({ previews: [] });

      const post = await client.threadPost({ text: "hello user" });
      expect(post.message.text).toBe("hello user");
      const conv = await client.threadRead({});
      expect(conv.messages.map((m) => m.text)).toContain("hello user");
      expect(appOps.posted).toEqual(["hello user"]);
    } finally {
      server.close();
    }
  });

  it("rejects bad token, wrong session, unknown tool, invalid params", async () => {
    const { server, url } = await serve();
    try {
      const post = (path: string, headers = {}, body = "{}") =>
        fetch(`${url}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        });
      expect((await post("/tools/browser_read")).status).toBe(401);
      // A session id nobody owns resolves to nothing — same 401 as a bad
      // token (the caller can't tell the two apart on purpose).
      expect(
        (
          await post("/tools/browser_read", {
            authorization: "Bearer tok",
            [SESSION_HEADER]: "nope",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await post("/tools/not_a_tool", {
            authorization: "Bearer tok",
            [SESSION_HEADER]: "s1",
          })
        ).status,
      ).toBe(404);
      const res = await post(
        "/tools/browser_open",
        { authorization: "Bearer tok", [SESSION_HEADER]: "s1" },
        JSON.stringify({ url: 5 }),
      );
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe("approval-gated tools: dispatch + areas + declined over HTTP", () => {
  it("the ops round-trip when the gate approves; `folder` and `project` are areas", async () => {
    const appOps = fakeAppOps();
    const { scope } = makeScope({ appOps, ceoAtStart: true });
    expect(scope.areas.has("folder")).toBe(true);
    expect(scope.areas.has("project")).toBe(true);
    /* D-#777: the area is attached so the CEO is offered `update_post`.
       A session that did not hold the position still is not. */
    expect(scope.areas.has("update")).toBe(true);
    expect(toolsForSession(scope.areas, true)).toContain("update_post");
    expect(toolsForSession(scope.areas, false)).not.toContain("update_post");
    const gw = await serveGateway({ sessions: [{ scope, token: "tok" }] });
    const client = toolBackend({
      baseUrl: gw.baseUrl,
      token: "tok",
      session: "s1",
    });
    try {
      const t = await client.threadStart({ title: "T", text: "hi" });
      expect(t.conversation.title).toBe("T");
      const h = await client.teamHire({
        name: "Bea",
        role: "designer",
        model: "m",
        instructions: "i",
      });
      expect(h.employee.name).toBe("Bea");
      const u = await client.teamUpdate({ role: "lead" });
      expect(u.employee.role).toBe("lead");
      const f = await client.folderAdd({ path: "~/x" });
      expect(f.folder.path).toBe("~/x");
      const none = await client.projectList();
      expect(none.projects).toEqual([]);
      const made = await client.projectCreate({
        folder: "/Users/o/shop",
        name: "Shop",
      });
      expect(made.project).toMatchObject({ name: "Shop", key: "SHOP" });
      expect((await client.projectList()).projects).toEqual([made.project]);
      // A folder that already has a project answers that project.
      const again = await client.projectCreate({ folder: "/Users/o/shop" });
      expect(again.project.id).toBe(made.project.id);
      const inProject = await client.threadStart({
        text: "go",
        project: made.project.key,
      });
      expect(inProject.conversation.id).toBeTruthy();
      expect(appOps.started.at(-1)).toEqual({
        text: "go",
        project: "SHOP",
      });
      expect(appOps.asks).toEqual([
        "thread_start T",
        "team_hire Bea (designer)",
        "team_update role",
        "folder_add ~/x",
        "project_create /Users/o/shop",
        "project_create /Users/o/shop",
        "thread_start go in SHOP",
      ]);
    } finally {
      gw.server.close();
      await scope.close();
    }
  });

  it("a decline surfaces as `declined` (HTTP 403) and applies nothing", async () => {
    const appOps = fakeAppOps([], { approve: "decline" });
    const { scope } = makeScope({ appOps });
    const gw = await serveGateway({ sessions: [{ scope, token: "tok" }] });
    const client = toolBackend({
      baseUrl: gw.baseUrl,
      token: "tok",
      session: "s1",
    });
    try {
      await expect(client.folderAdd({ path: "~/x" })).rejects.toThrow(/403/);
      await expect(client.projectCreate({ folder: "/x" })).rejects.toThrow(
        /403/,
      );
      expect(appOps.asks.length).toBe(2);
      expect(appOps.projectRows).toEqual([]);
      // Decline changed nothing — the fake's only thread is still the seed.
      const convs = await client.threadList();
      expect(convs.threads.length).toBe(1);
    } finally {
      gw.server.close();
      await scope.close();
    }
  });
});

describe("CEO-only tools (D-#778)", () => {
  const setCeo = { employeeId: "emp-other" };

  it("is not offered to a session that did not start as CEO", async () => {
    const appOps = fakeAppOps();
    const { scope } = makeScope({ appOps });
    const gw = await serveGateway({ sessions: [{ scope, token: "tok" }] });
    try {
      const res = await fetch(`${gw.baseUrl}/tools/team_set_ceo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tok",
          [SESSION_HEADER]: "s1",
        },
        body: JSON.stringify(setCeo),
      });
      expect(res.status).toBe(404);
      expect(appOps.asks).toEqual([]);
    } finally {
      gw.server.close();
      await scope.close();
    }
  });

  it("rejects the call once the position has moved", async () => {
    const appOps = fakeAppOps([], { ceoId: "someone-else" });
    const { scope } = makeScope({ appOps, ceoAtStart: true });
    try {
      await expect(
        callTool(scope, "team_set_ceo", setCeo),
      ).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(appOps.asks).toEqual([]);
    } finally {
      await scope.close();
    }
  });
});

describe("callTool contract guards", () => {
  it("rejects unknown tools and non-conforming params/results", async () => {
    const { scope } = makeScope({});
    await expect(callTool(scope, "nope", {})).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      callTool(scope, "terminal_run", { command: 1 }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const bad = new Proxy(scope, {
      get: (t, prop) =>
        prop === "browserRead"
          ? async () => ({ nope: 1 })
          : Reflect.get(t, prop as keyof typeof t),
    });
    await expect(callTool(bad, "browser_read", {})).rejects.toMatchObject({
      code: "internal",
    });
  });
});
