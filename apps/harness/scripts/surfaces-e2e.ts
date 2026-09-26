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
  const res = await fetch(`${server.url}/surfaces/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: process.env.HOME }),
  });
  const session = (await res.json()) as {
    session: string;
    token: string;
    viewerUrl: string;
    mcpServer: {
      name: string;
      command: string;
      args: string[];
      env: { name: string; value: string }[];
    };
  };
  check(
    "create session returns mcpServers spec",
    session.mcpServer?.name === "lilos" && session.mcpServer.env.length === 3,
    JSON.stringify(session.mcpServer),
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
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { type: string; url?: string };
    if (m.type === "hello") seen.hello = true;
    if (m.type === "frame") seen.frame = true;
    if (m.type === "term") seen.term = true;
    if (m.type === "url") seen.url = m.url ?? "";
    if (m.type === "activity") seen.activity += 1;
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

  await tool(server.url, session.session, session.token, "terminal_write", {
    data: "echo 'PREVIEW: http://localhost:4173/demo'\n",
  });
  await sleep(800);
  const previews = await tool(
    server.url,
    session.session,
    session.token,
    "previews_list",
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
