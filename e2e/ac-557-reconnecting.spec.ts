import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import {
  captureProc,
  killProc,
  pickPorts,
  type StackPorts,
  WORKER,
  waitForFeed,
  waitForHttp,
  waitForRelay,
  waitForToken,
} from "./helpers/stack";

/**
 * AC-557: losing the relay shows a thin "Reconnecting…" line over the
 * composer — in the thread panel AND in Focus (the sidebar status row is
 * hidden there) — and it clears once the socket is back (AC-1). A send made
 * while the line is showing doesn't fail: the client waits out the
 * reconnect and re-sends with the same draft-scoped dedupe key, so the
 * message lands exactly once (AC-2).
 *
 * Three separate processes (ac-130 style, not the `bun run dev` umbrella)
 * so the relay can be killed while vite keeps serving the loaded page.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/e2e$/, "");
const webDir = path.join(ROOT, "apps", "web");
const SHOTS = path.join(ROOT, "test-results", "ac-557");
const LINE = "[data-reconnecting]";
let PORTS: StackPorts;

interface Procs {
  home: string;
  webUrl: string;
  leakTag: string;
  procs: Record<"relay" | "harness" | "web", ChildProcess | undefined>;
  kill: (which?: "relay" | "harness" | "web") => Promise<void>;
  restartRelay: () => Promise<void>;
}

/** The opposite of waitForHttp: resolves once nothing answers on the port. */
async function waitForDown(url: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const down = await fetch(url).then(
      () => false,
      () => true,
    );
    if (down) return;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${url} to go down`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function spawnRelay(home: string, port: number): Promise<ChildProcess> {
  const p = spawn("bun", ["run", "apps/relay/src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      LILOS_RELAY_HOME: home,
      LILOS_RELAY_PORT: String(port),
      LILOS_RELAY_HOST: "127.0.0.1",
    },
    // Piped: readiness checks the spawned relay's own instanceId against
    // /healthz — a foreign relay on the port is a hard boot failure (#273).
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForRelay(port, p, captureProc(p));
  return p;
}

async function boot(): Promise<Procs> {
  const home = mkdtempSync(path.join(tmpdir(), "lilos-e2e-557-"));
  const leakTag = engineTag("ac557");
  const procs: Procs["procs"] = {
    relay: undefined,
    harness: undefined,
    web: undefined,
  };

  procs.relay = await spawnRelay(home, PORTS.relay);
  const relayToken = await waitForToken(home);

  const harness = spawn("bun", ["run", "apps/harness/src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      LILOS_ENGINE: "fake",
      LILOS_RELAY_URL: `ws://127.0.0.1:${PORTS.relay}/ws`,
      LILOS_RELAY_HOME: home,
      LILOS_RELAY_TOKEN: relayToken,
      LILOS_HARNESS_HOME: path.join(home, "harness"),
      LILOS_REPO_ROOT: ROOT,
      LILOS_WORKDIR: path.join(home, "harness", "work"),
      LILOS_FEED_PORT: String(PORTS.feed),
      LILOS_ENGINE_TAG: leakTag,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.harness = harness;
  await waitForFeed(PORTS.feed, harness, captureProc(harness));

  procs.web = spawn(
    "bun",
    [
      path.join(webDir, "node_modules", ".bin", "vite"),
      "--config",
      path.join(webDir, "vite.ac28.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(PORTS.web),
      "--strictPort",
    ],
    {
      cwd: webDir,
      env: {
        ...process.env,
        LILOS_RELAY_WS: `ws://127.0.0.1:${PORTS.relay}/ws`,
        LILOS_RELAY_TOKEN: relayToken,
        LILOS_ENGINE_WS: `ws://127.0.0.1:${PORTS.feed}/ws`,
        LILOS_WEB_PORT: String(PORTS.web),
        LILOS_VITE_CACHE_DIR: `node_modules/.vite-ac557-w${WORKER}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForHttp(`http://127.0.0.1:${PORTS.web}`);

  return {
    home,
    webUrl: `http://127.0.0.1:${PORTS.web}`,
    leakTag,
    procs,
    kill: async (which) => {
      const names: (keyof typeof procs)[] = which
        ? [which]
        : ["web", "harness", "relay"];
      for (const n of names) {
        const p = procs[n];
        if (p) {
          procs[n] = undefined;
          await killProc(p);
        }
      }
    },
    restartRelay: async () => {
      procs.relay = await spawnRelay(home, PORTS.relay);
    },
  };
}

/** Open the app, land on Default's DM home (dismissing the first-run card). */
async function dmDefault(page: Page, base: string) {
  await page.goto(`${base}/`);
  const aside = page.locator("aside").first();
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 60_000,
  });
  const firstRun = page.getByRole("button", { name: /open dm/i });
  if (await firstRun.isVisible().catch(() => false)) {
    await firstRun.click();
  } else {
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page.locator("main form")).toBeVisible({ timeout: 15_000 });
}

/** The composer form on `scope` — "home" is main, "thread" is the panel. */
const formOf = (page: Page, scope: "home" | "thread") =>
  scope === "home" ? page.locator("main form") : page.locator("form").last();
const boxOf = (page: Page, scope: "home" | "thread") =>
  scope === "home"
    ? page.locator("main textarea")
    : page.locator("textarea").last();

/** Open a session: the home composer's send lands on its Focus view. */
async function openSession(page: Page, text: string) {
  await boxOf(page, "home").fill(text);
  await formOf(page, "home").evaluate((f: HTMLFormElement) =>
    f.requestSubmit(),
  );
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
}

/** Back to the thread panel — in-app nav keeps the loaded page state (a
   reload while the relay is down would re-boot into the loading gate). */
async function toThreadPanel(page: Page) {
  await page.getByRole("button", { name: /back to dm/i }).click();
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+$/);
  await expect(formOf(page, "thread")).toBeVisible();
}

async function toFocus(page: Page) {
  await page
    .locator("[data-thread-panel]")
    .getByRole("button", { name: "Focus", exact: true })
    .click();
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  /* The route mounts a fresh FocusView — wait for its own chrome ("Back to
     DM") so assertions/screenshots can't race the swap-in frame. */
  await expect(page.getByRole("button", { name: /back to dm/i })).toBeVisible({
    timeout: 15_000,
  });
}

/** Kill the relay and wait until the page's socket noticed the drop. */
async function relayDown(stack: Procs) {
  await stack.kill("relay");
  await waitForDown(`http://127.0.0.1:${PORTS.relay}/`);
}

/** Bare JSON-RPC client — e2e runs under Node without workspace deps. */
async function rpc(
  home: string,
  calls: { method: string; params: Record<string, unknown> }[],
): Promise<Record<string, unknown>[]> {
  const token = readFileSync(path.join(home, "relay-token"), "utf8").trim();
  const ws = new WebSocket(
    `ws://127.0.0.1:${PORTS.relay}/ws?token=${encodeURIComponent(token)}`,
  );
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  const pending = new Map<string, (r: Record<string, unknown>) => void>();
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data as string) as Record<string, unknown>;
    if (typeof f.id === "string") pending.get(f.id)?.(f);
  };
  const send = (id: string, method: string, params: object) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      pending.set(id, (f) =>
        f.error ? rej(f.error) : res(f.result as Record<string, unknown>),
      );
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  await send("h", "session.hello", { protocolVersion: 1, token });
  const out: Record<string, unknown>[] = [];
  for (const [i, c] of calls.entries())
    out.push(await send(String(i), c.method, c.params));
  ws.close();
  return out;
}

let stack: Procs;
test.beforeAll(async () => {
  PORTS = await pickPorts();
  stack = await boot();
});
test.afterAll(async () => {
  await stack?.kill();
  if (stack?.leakTag) await expectNoEngineLeak(stack.leakTag);
});
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);
/* AC-2's outage→send→reconnect→single-delivery flow records a webm under
   test-results — the PR's screen-recording evidence. */
test.use({ video: "on" });

test("AC-1 the Reconnecting line shows in Thread and Focus on relay loss and clears on restart", async ({
  page,
}) => {
  await dmDefault(page, stack.webUrl);
  await openSession(page, "a session for the reconnect line");
  await toThreadPanel(page);

  await relayDown(stack);
  // Thread panel: the line lands as soon as the socket close does (~instant).
  await expect(page.locator(LINE)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(LINE)).toContainText(/reconnecting/i);
  await page.screenshot({ path: `${SHOTS}/ac1-line-thread.png` });

  // Focus: the sidebar status row is hidden here — the line covers it.
  await toFocus(page);
  await expect(page.locator(LINE)).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/ac1-line-focus.png` });

  // Restart → the line clears in Focus and stays clear in the panel.
  await stack.restartRelay();
  await expect(page.locator(LINE)).toHaveCount(0, { timeout: 30_000 });
  await toThreadPanel(page);
  await expect(page.locator(LINE)).toHaveCount(0);
});

test("AC-2 a send made while reconnecting lands exactly once after the relay is back", async ({
  page,
}) => {
  await dmDefault(page, stack.webUrl);
  await openSession(page, "a session for the outage send");
  await toThreadPanel(page);

  const text = `sent during the outage ${Date.now()}`;
  await boxOf(page, "thread").fill(text);

  await relayDown(stack);
  await expect(page.locator(LINE)).toBeVisible({ timeout: 10_000 });
  // The send pends on the reconnect instead of failing — the draft stays in
  // the box until it lands.
  await formOf(page, "thread").evaluate((f: HTMLFormElement) =>
    f.requestSubmit(),
  );
  await page.screenshot({ path: `${SHOTS}/ac2-send-pending.png` });

  await stack.restartRelay();
  await expect(page.locator(LINE)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(`text=${text}`).last()).toBeVisible({
    timeout: 30_000,
  });
  await expect(boxOf(page, "thread")).toHaveValue("");
  await page.screenshot({ path: `${SHOTS}/ac2-sent-once.png` });

  // Wire check: exactly one message with that text reached the relay.
  const emp = page.url().match(/\/dm\/([^/]+)/)?.[1] ?? "default";
  const conv = page.url().match(/\/dm\/[^/]+\/([^/]+?)(?:\/focus)?$/)?.[1];
  const r = await rpc(stack.home, [
    { method: "channels.openDm", params: { employeeId: emp } },
  ]);
  const channelId = (r[0] as { channel: { id: string } }).channel.id;
  const listed = await rpc(stack.home, [
    { method: "messages.list", params: { channelId, conversationId: conv } },
  ]);
  const sent = (
    listed[0] as { messages: { authorKind: string; text: string }[] }
  ).messages.filter((m) => m.text === text && m.authorKind === "user");
  expect(sent).toHaveLength(1);
});

/* PR evidence matrix — NOT an AC gate. The Reconnecting line in Thread and
   Focus, light and dark, at the three PR shot sizes, written to shots/557/.
   The stack is shared; each theme drives one kill/restart cycle on its own
   browser context. */
const OUT = path.join(ROOT, "shots", "557");
const S1288x700 = { width: 1288, height: 700 };
const S1288x900 = { width: 1288, height: 900 };
const S1440x900 = { width: 1440, height: 900 };

test("shots — the line in Thread and Focus, light/dark, 1288x700 + 1288x900 + 1440x900", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  for (const theme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ viewport: S1288x700 });
    try {
      await ctx.addInitScript((t) => {
        localStorage.setItem("lilos-onboarded", "1");
        localStorage.setItem("lilos-theme", t);
      }, theme);
      const page = await ctx.newPage();
      await dmDefault(page, stack.webUrl);
      if (theme === "dark") {
        await expect(page.locator("html")).toHaveClass(/dark/);
      } else {
        await expect(page.locator("html")).not.toHaveClass(/dark/);
      }
      await openSession(page, "a session for the reconnect line");
      await toThreadPanel(page);

      await relayDown(stack);
      await expect(page.locator(LINE)).toBeVisible({ timeout: 10_000 });
      const shot = (name: string) =>
        page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`) });
      await shot("line-thread-1288x700");
      await page.setViewportSize(S1440x900);
      await page.waitForTimeout(300);
      await shot("line-thread-1440x900");
      await page.setViewportSize(S1288x900);
      await page.waitForTimeout(300);
      await shot("line-thread-1288x900");

      await toFocus(page);
      await expect(page.locator(LINE)).toBeVisible();
      await page.waitForTimeout(300);
      await shot("line-focus-1288x900");
      await page.setViewportSize(S1440x900);
      await page.waitForTimeout(300);
      await shot("line-focus-1440x900");
      await page.setViewportSize(S1288x700);
      await page.waitForTimeout(300);
      await shot("line-focus-1288x700");

      await stack.restartRelay();
      await expect(page.locator(LINE)).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await ctx.close();
    }
  }
});
