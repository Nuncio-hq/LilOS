/**
 * Real-driver leg of issue #36 (AC-1/AC-4/AC-5): stands up `serveSurfaces`
 * with real headless Chromium + a real PTY, drives the tool API, attaches a
 * viewer socket, and checks takeover input both ways. Run with Bun:
 *   bun apps/harness/scripts/surfaces-e2e.ts
 * Prints one PASS/FAIL line per check plus a summary; exit 1 on any FAIL.
 */
import { serveSurfaces } from "../src/surfaces/server";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const watchdog = setTimeout(() => {
  console.log("WATCHDOG: timed out");
  process.exit(2);
}, 90_000);

const tool = async (
  base: string,
  session: string,
  token: string,
  name: string,
  args: unknown = {},
) => {
  const res = await fetch(`${base}/tools/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-lilos-session": session,
    },
    body: JSON.stringify(args),
  });
  const body = (await res.json()) as {
    result?: unknown;
    error?: { code: string; message: string };
  };
  if (!res.ok) throw new Error(`${name} ${res.status}: ${body.error?.message}`);
  return body.result as Record<string, never>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = await serveSurfaces(0);
try {
  // Session management is in-process only — nothing on the port may pick a
  // binding or an alias (AC-3); prove the management route is closed.
  const closed = await fetch(`${server.url}/surfaces/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: process.env.HOME }),
  });
  check("POST /surfaces/sessions is not reachable", closed.status === 404);
  const session = server.create({ cwd: process.env.HOME });
  check(
    "create session returns mcpServers spec",
    session.mcpServer?.name === "lilos" && session.mcpServer.env.length === 3,
    JSON.stringify(session.mcpServer),
  );
  check(
    "create session returns the HTTP MCP spec (AC-2)",
    session.mcpServerHttp?.type === "http" &&
      session.mcpServerHttp.url.endsWith("/mcp"),
    JSON.stringify(session.mcpServerHttp),
  );

  // #337 AC-2 leg: the same session over streamable-HTTP MCP —
  // initialize (carrying the host policy), tools/list, tools/call.
  const mcp = async (method: string, params?: unknown, id = 1) => {
    const r = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${session.token}`,
        "x-lilos-session": session.session,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? {},
      }),
    });
    return (await r.json()) as {
      result?: Record<string, unknown>;
      error?: { message: string };
    };
  };
  const hello = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  check(
    "mcp initialize carries the host policy (AC-5)",
    String(hello.result?.instructions).includes("[LilOS host policy v"),
  );
  const listed = await mcp("tools/list");
  const listedNames = ((listed.result?.tools ?? []) as { name: string }[]).map(
    (t) => t.name,
  );
  check(
    "mcp tools/list renders from the catalog (AC-1)",
    listedNames.includes("terminal_run") &&
      listedNames.includes("workbench_previews") &&
      listedNames.includes("browser_open"),
    listedNames.join(","),
  );
  const catalog = await fetch(`${server.url}/tools`, {
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-lilos-session": session.session,
    },
  });
  const catalogBody = (await catalog.json()) as {
    tools?: { name: string }[];
  };
  check(
    "GET /tools lists the same catalog",
    (catalogBody.tools ?? []).length === listedNames.length,
  );
  const mcpRun = await mcp("tools/call", {
    name: "terminal_run",
    arguments: { command: "echo MCP-OK" },
  });
  check(
    "mcp tools/call runs terminal_run",
    JSON.stringify(mcpRun.result ?? {}).includes("MCP-OK"),
    JSON.stringify(mcpRun).slice(0, 120),
  );

  const bad = await fetch(`${server.url}/tools/browser_read`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lilos-session": session.session,
    },
    body: "{}",
  });
  check("tool call without token → 401", bad.status === 401);

  // AC-4 leg: viewer attaches first, then agent drives — frames must flow.
  const ws = new WebSocket(session.viewerUrl);
  const seen = {
    hello: false,
    frame: false,
    term: false,
    url: "",
    activity: 0,
    control: [] as string[],
    page: null as null | { width: number; height: number },
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as {
      type: string;
      url?: string;
      holder?: string;
      page?: { width: number; height: number };
    };
    if (m.type === "hello") seen.hello = true;
    if (m.type === "frame") seen.frame = true;
    if (m.type === "term") seen.term = true;
    if (m.type === "url") seen.url = m.url ?? "";
    if (m.type === "activity") seen.activity += 1;
    if (m.type === "term.control") seen.control.push(m.holder ?? "");
    if (m.type === "page") seen.page = m.page ?? null;
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("viewer ws failed"));
  });
  check("viewer hello", await waitFor(() => seen.hello, 3000));

  const opened = await tool(
    server.url,
    session.session,
    session.token,
    "browser_open",
    {
      url: "data:text/html,<title>t</title><h1>LILOS-E2E</h1><button id=b onclick='document.title=\"clicked\"'>b</button>",
    },
  );
  check("browser_open reaches the owned page", typeof opened.url === "string");

  check("viewer receives live frame", await waitFor(() => seen.frame, 8000));
  const read = await tool(
    server.url,
    session.session,
    session.token,
    "browser_read",
  );
  check("browser_read returns page text", /LILOS-E2E/.test(String(read.text)));

  await tool(server.url, session.session, session.token, "browser_click", {
    selector: "#b",
  });
  const title = await tool(
    server.url,
    session.session,
    session.token,
    "browser_read",
  );
  check(
    "browser_click by selector hits the page",
    String(title.title) === "clicked",
  );

  // viewer takeover: pixel click on the page center + a key, then term.input.
  ws.send(
    JSON.stringify({
      type: "browser.input",
      event: { kind: "mouse", event: "down", x: 100, y: 100, button: "left" },
    }),
  );
  ws.send(
    JSON.stringify({
      type: "browser.input",
      event: { kind: "mouse", event: "up", x: 100, y: 100, button: "left" },
    }),
  );
  ws.send(JSON.stringify({ type: "term.input", data: "echo VIEWER-TYPED\n" }));
  await sleep(600);
  const tail = await tool(
    server.url,
    session.session,
    session.token,
    "terminal_read",
    { tailBytes: 8000 },
  );
  check(
    "viewer term.input reaches the PTY",
    /VIEWER-TYPED/.test(String(tail.output)),
  );

  // AC-1 (issue #56): that keystroke took the terminal — the agent's next
  // call gets a clear user_control conflict instead of silently interleaving.
  check(
    "takeover announced on the wire (term.control user)",
    await waitFor(() => seen.control.at(-1) === "user", 3000),
  );
  const blocked = await fetch(`${server.url}/tools/terminal_run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`,
      "x-lilos-session": session.session,
    },
    body: JSON.stringify({ command: "echo nope" }),
  });
  const blockedBody = (await blocked.json()) as {
    error?: { code?: string };
  };
  check(
    "agent terminal_run during takeover → 409 user_control",
    blocked.status === 409 && blockedBody.error?.code === "user_control",
    `status=${blocked.status} body=${JSON.stringify(blockedBody)}`,
  );
  ws.send(JSON.stringify({ type: "term.release" }));
  check(
    "term.release hands the terminal back",
    await waitFor(() => seen.control.at(-1) === "agent", 3000),
  );

  const ran = await tool(
    server.url,
    session.session,
    session.token,
    "terminal_run",
    { command: "echo TERM-$((1+1))" },
  );
  check(
    "terminal_run captures output",
    /TERM-2/.test(String(ran.output)),
    String(ran.output),
  );

  // AC-3: a redirect lands on the final URL — the viewer's url event follows.
  const landed = `${server.url}/landed`;
  const redir = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(null, { status: 302, headers: { location: landed } }),
  });
  ws.send(
    JSON.stringify({
      type: "browser.navigate",
      url: `http://127.0.0.1:${redir.port}/go`,
    }),
  );
  check(
    "url event follows a redirect to the final URL",
    await waitFor(() => seen.url === landed, 8000),
    `last url=${seen.url}`,
  );
  redir.stop(true);

  // AC-4: the viewer pane's pixels drive the remote page's viewport.
  ws.send(JSON.stringify({ type: "browser.resize", width: 640, height: 360 }));
  let dims = "";
  for (let i = 0; i < 60; i++) {
    const r = await tool(
      server.url,
      session.session,
      session.token,
      "browser_eval",
      { expression: "innerWidth + 'x' + innerHeight" },
    );
    dims = String(r.value);
    if (dims === "640x360") break;
    await sleep(150);
  }
  check(
    "browser.resize resizes the remote viewport",
    dims === "640x360",
    `innerWidth×innerHeight=${dims}`,
  );
  check(
    "page event carries the new box",
    await waitFor(
      () => seen.page?.width === 640 && seen.page?.height === 360,
      5000,
    ),
    `page=${JSON.stringify(seen.page)}`,
  );

  await tool(server.url, session.session, session.token, "terminal_write", {
    data: "echo 'PREVIEW: http://localhost:4173/demo'\n",
  });
  await sleep(800);
  const previews = await tool(
    server.url,
    session.session,
    session.token,
    "workbench_previews",
  );
  check(
    "PREVIEW: marker found",
    JSON.stringify(previews).includes("localhost:4173"),
  );

  ws.close();
  const scope = server.scopeFor(session.session);
  check("scope survives viewer disconnect (AC-1)", scope !== null);
  const ran2 = await tool(
    server.url,
    session.session,
    session.token,
    "terminal_run",
    { command: "echo STILL-ALIVE" },
  );
  check(
    "PTY keeps running with no viewers",
    /STILL-ALIVE/.test(String(ran2.output)),
  );

  check("viewer saw term events", seen.term);
  check("viewer saw tool activity", seen.activity > 0);

  await server.destroy(session.session);
} finally {
  await server.close();
  clearTimeout(watchdog);
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`surfaces-e2e: ${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(60);
  }
  return fn();
}
