/**
 * #549 plugin-tools unit tests — the self-heal that activates `lilos` on
 * OUR backend (the enable nudge is routed to the host record's owner, not
 * to an observe-only --isolated backend), and the session-start offered-
 * tools log (AC-3).
 */
import { describe, expect, test } from "vitest";
import {
  ensureLilosBackend,
  logSessionTools,
  profileHomeFor,
} from "../src/plugin-tools.js";
import { FakeGateway } from "./fake-gateway.js";

const BACKEND = { url: "http://127.0.0.1:1", token: "tok" };
const HOME = "/tmp/hermes-home";

function deps(logs: string[], fetchFn?: typeof fetch) {
  return {
    log: (line: string) => logs.push(line),
    ...(fetchFn ? { fetchFn } : {}),
  };
}

const okFetch: typeof fetch = (() =>
  Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;

describe("profileHomeFor", () => {
  test("default profile is the home itself; named profiles are profiles/<name>", () => {
    expect(profileHomeFor("default", "/h")).toBe("/h");
    expect(profileHomeFor("builder", "/h")).toBe("/h/profiles/builder");
  });
});

describe("ensureLilosBackend", () => {
  test("plugin active on our backend → no POST, and it says so", async () => {
    const gw = new FakeGateway();
    const logs: string[] = [];
    const fetchCalls: string[] = [];
    const fetchFn: typeof fetch = ((u: string) => {
      fetchCalls.push(String(u));
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    await ensureLilosBackend({
      gw,
      agent: "builder",
      hermesHome: HOME,
      backend: BACKEND,
      deps: deps(logs, fetchFn),
    });
    expect(fetchCalls).toHaveLength(0);
    expect(logs.join("\n")).toContain("active on our backend");
  });

  test("plugin missing → POSTs activate {name,home} with the session token, then confirms", async () => {
    const gw = new FakeGateway();
    gw.plugins = []; // the nudge went to the host owner's record
    const logs: string[] = [];
    const posts: { url: string; body: string; token?: string }[] = [];
    const fetchFn: typeof fetch = ((u: string, init?: RequestInit) => {
      posts.push({
        url: String(u),
        body: String(init?.body),
        token: (init?.headers as Record<string, string>)?.[
          "X-Hermes-Session-Token"
        ],
      });
      /* Activation registers the plugin — flip the manager's view. */
      gw.plugins = [{ name: "lilos", enabled: true }];
      return Promise.resolve(new Response('{"ok":true}'));
    }) as typeof fetch;
    await ensureLilosBackend({
      gw,
      agent: "builder",
      hermesHome: HOME,
      backend: BACKEND,
      deps: deps(logs, fetchFn),
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(
      "http://127.0.0.1:1/api/dashboard/agent-plugins/activate",
    );
    expect(posts[0].token).toBe("tok");
    expect(JSON.parse(posts[0].body)).toEqual({
      name: "lilos",
      home: `${HOME}/profiles/builder`,
    });
    expect(logs.join("\n")).toContain("activated on our backend");
  });

  test("activation accepted but plugin still absent → names the config gate", async () => {
    const gw = new FakeGateway();
    gw.plugins = [];
    const logs: string[] = [];
    await ensureLilosBackend({
      gw,
      agent: "builder",
      hermesHome: HOME,
      backend: BACKEND,
      deps: deps(logs, okFetch),
    });
    expect(logs.join("\n")).toContain("plugins.enabled");
  });

  test("backend without the activate endpoint (404) → logged, session still proceeds", async () => {
    const gw = new FakeGateway();
    gw.plugins = [];
    const logs: string[] = [];
    const fetchFn: typeof fetch = (() =>
      Promise.resolve(new Response("no", { status: 404 }))) as typeof fetch;
    await ensureLilosBackend({
      gw,
      agent: "builder",
      hermesHome: HOME,
      backend: BACKEND,
      deps: deps(logs, fetchFn),
    });
    expect(logs.join("\n")).toMatch(/no agent-plugins\/activate|refused/);
  });

  test("no backend endpoint (engine detached) → logged, no POST", async () => {
    const gw = new FakeGateway();
    gw.plugins = [];
    const logs: string[] = [];
    await ensureLilosBackend({
      gw,
      agent: "builder",
      hermesHome: HOME,
      deps: deps(logs, okFetch),
    });
    expect(logs.join("\n")).toContain("no backend endpoint");
  });

  test("a dead gateway → logged, never throws", async () => {
    const gw = new FakeGateway();
    gw.plugins = [];
    const dead = {
      request: () => Promise.reject(new Error("closed")),
    } as unknown as FakeGateway;
    const logs: string[] = [];
    await ensureLilosBackend({
      gw: dead,
      agent: "builder",
      hermesHome: HOME,
      backend: BACKEND,
      deps: deps(logs, okFetch),
    });
    expect(logs.join("\n")).toContain("plugin check failed");
  });
});

describe("logSessionTools (AC-3)", () => {
  test("logs the offered tool names incl. lilos_*", async () => {
    const gw = new FakeGateway();
    const logs: string[] = [];
    await logSessionTools({
      gw,
      runtimeSid: "sid-1",
      agent: "builder",
      deps: deps(logs),
    });
    const line = logs.find((l) => l.includes("offered"));
    expect(line).toBeTruthy();
    expect(line).toContain("lilos_context");
    expect(line).toContain("lilos_team_list");
  });

  test("lilos toolset still absent post-heal → named", async () => {
    const gw = new FakeGateway();
    gw.toolsets = gw.toolsets.filter((t) => t.name !== "lilos");
    const logs: string[] = [];
    await logSessionTools({
      gw,
      runtimeSid: "sid-1",
      agent: "builder",
      deps: deps(logs),
    });
    expect(logs.join("\n")).toContain("no lilos_* tools offered");
  });

  test("dead gateway → logged, never throws", async () => {
    const dead = {
      request: () => Promise.reject(new Error("closed")),
    } as unknown as FakeGateway;
    const logs: string[] = [];
    await logSessionTools({
      gw: dead,
      runtimeSid: "sid-1",
      agent: "builder",
      deps: deps(logs),
    });
    expect(logs.join("\n")).toContain("check failed");
  });
});
