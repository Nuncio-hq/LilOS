import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { WORKER, wport } from "./ports";

/**
 * AC-130: a send the relay refuses (killed mid-send / down) keeps the draft —
 * typed text and image chips stay in the composer so Oscar can press send
 * again. AC-1 home (new-session) composer, AC-2 thread (reply) composer,
 * AC-3 a successful send still clears with no double-send on Enter-Enter,
 * AC-4 the prototype's fake sends still clear (they never fail).
 *
 * Stack is spawned as three separate processes (ac-28 style, not the
 * `bun run dev` umbrella) so the relay can be killed while vite keeps
 * serving the loaded page.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/e2e$/, "");
const webDir = path.join(ROOT, "apps", "web");
const SHOTS = path.join(ROOT, "test-results", "ac-130");
const PORTS = { relay: wport(4740), feed: wport(4741), web: wport(5300) };

const TOAST = "div.fixed.bottom-5";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQI12P8z/CfAQMwMCooKOgDAu2zC+h6pBe+AAAAAElFTkSuQmCC",
  "base64",
);

interface Procs {
  home: string;
  webUrl: string;
  relayToken: string;
  leakTag: string;
  procs: Record<"relay" | "harness" | "web", ChildProcess | undefined>;
  kill: (which?: "relay" | "harness" | "web") => Promise<void>;
  restartRelay: () => Promise<void>;
}

const killProc = (proc: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 8_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    proc.kill("SIGTERM");
  });

async function waitForHttp(url: string, ms = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const ok = await fetch(url)
      .then((r) => r.status > 0)
      .catch(() => false);
    if (ok) return;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
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

async function waitForToken(home: string): Promise<string> {
  const tokenPath = path.join(home, "relay-token");
  for (let i = 0; i < 200; i++) {
    try {
      const t = readFileSync(tokenPath, "utf8").trim();
      if (t) return t;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("relay never wrote its token file");
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
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForHttp(`http://127.0.0.1:${port}/`);
  return p;
}

async function boot(): Promise<Procs> {
  const home = mkdtempSync(path.join(tmpdir(), "lilos-e2e-130-"));
  const leakTag = engineTag("ac130");
  const procs: Procs["procs"] = {
    relay: undefined,
    harness: undefined,
    web: undefined,
  };

  procs.relay = await spawnRelay(home, PORTS.relay);
  const relayToken = await waitForToken(home);

  procs.harness = spawn("bun", ["run", "apps/harness/src/index.ts"], {
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
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForHttp(`http://127.0.0.1:${PORTS.feed}/`);

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
        LILOS_VITE_CACHE_DIR: `node_modules/.vite-ac130-w${WORKER}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForHttp(`http://127.0.0.1:${PORTS.web}`);

  return {
    home,
    webUrl: `http://127.0.0.1:${PORTS.web}`,
    relayToken,
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

async function attach(page: Page, name: string, scope: "home" | "thread") {
  const input =
    scope === "home"
      ? page.locator('main input[type="file"]')
      : page.locator('input[type="file"]').last();
  await input.setInputFiles({ name, mimeType: "image/png", buffer: PNG });
  await expect(formOf(page, scope).getByText(name)).toBeVisible();
}

/** Kill the relay and wait until the page's socket is definitely down so the
   send rejects fast (not_connected) instead of riding the 15s timeout. */
async function relayDown(stack: Procs) {
  await stack.kill("relay");
  await waitForDown(`http://127.0.0.1:${PORTS.relay}/`);
  // Give the client's socket-close + one failed reconnect attempt a beat to
  // land before the submit below.
  await new Promise((r) => setTimeout(r, 1_500));
}

/** Press send again until the kept draft lands: after `restartRelay` the
   client's socket is still in reconnect backoff, so the first retry can be
   refused too — it just keeps the draft and we try again (ac-28's loop). */
async function sendUntil(
  page: Page,
  scope: "home" | "thread",
  sent: () => Promise<boolean>,
  ms = 60_000,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await sent()) return;
    if (Date.now() > deadline)
      throw new Error(`kept draft never sent (${scope} composer)`);
    await formOf(page, scope).evaluate((f: HTMLFormElement) =>
      f.requestSubmit(),
    );
    await page.waitForTimeout(1_000);
  }
}

/** Bare JSON-RPC client — e2e runs under Node without workspace deps. */
async function rpc(
  home: string,
  calls: { method: string; params: Record<string, unknown> }[],
): Promise<Record<string, unknown>[]> {
  const token = readFileSync(path.join(home, "relay-token"), "utf8").trim();
  const ws = new WebSocket(`ws://127.0.0.1:${PORTS.relay}/ws`);
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

async function channelIdFor(page: Page, stack: Procs): Promise<string> {
  const emp = page.url().match(/\/dm\/([^/]+)/)?.[1] ?? "default";
  const r = await rpc(stack.home, [
    { method: "channels.openDm", params: { employeeId: emp } },
  ]);
  return (r[0] as { channel: { id: string } }).channel.id;
}

let stack: Procs;
test.beforeAll(async () => {
  stack = await boot();
});
test.afterAll(async () => {
  await stack?.kill();
  if (stack?.leakTag) await expectNoEngineLeak(stack.leakTag);
});
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test("AC-1 a refused send in the home composer keeps the text and image chips", async ({
  page,
}) => {
  await dmDefault(page, stack.webUrl);
  await boxOf(page, "home").fill("kept through a refused send");
  await attach(page, "kept.png", "home");

  await relayDown(stack);
  await formOf(page, "home").evaluate((f: HTMLFormElement) =>
    f.requestSubmit(),
  );

  // The failure toast fires and the draft is untouched.
  await expect(page.locator(TOAST)).toContainText(/try again/i, {
    timeout: 30_000,
  });
  await expect(boxOf(page, "home")).toHaveValue("kept through a refused send");
  await expect(formOf(page, "home").getByText("kept.png")).toBeVisible();
  // Still on the DM home — no conversation was opened.
  await expect(page).toHaveURL(/\/dm\/[^/]+$/);
  await page.screenshot({ path: `${SHOTS}/ac1-draft-kept.png` });

  // Relay back: pressing send again posts the kept draft and opens the session.
  await stack.restartRelay();
  await sendUntil(
    page,
    "home",
    async () => /\/dm\/[^/]+\/[^/]+\/focus$/.test(page.url()), // sessions open in Focus (#114)
  );
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/, { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac1-retry-sent.png` });
});

test("AC-2 a refused reply in the thread composer keeps the text and image chips", async ({
  page,
}) => {
  await dmDefault(page, stack.webUrl);

  // Open a session while the relay is healthy so the thread composer shows.
  await boxOf(page, "home").fill("open a session first");
  await formOf(page, "home").evaluate((f: HTMLFormElement) =>
    f.requestSubmit(),
  );
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  await expect(formOf(page, "thread")).toBeVisible();

  await boxOf(page, "thread").fill("reply kept through a refused send");
  await attach(page, "reply-kept.png", "thread");

  await relayDown(stack);
  await formOf(page, "thread").evaluate((f: HTMLFormElement) =>
    f.requestSubmit(),
  );

  await expect(page.locator(TOAST)).toContainText(/try again/i, {
    timeout: 30_000,
  });
  await expect(boxOf(page, "thread")).toHaveValue(
    "reply kept through a refused send",
  );
  await expect(
    formOf(page, "thread").getByText("reply-kept.png"),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac2-draft-kept.png` });

  // Retry lands the reply in the thread once the relay is back.
  await stack.restartRelay();
  await sendUntil(
    page,
    "thread",
    async () => (await boxOf(page, "thread").inputValue()) === "",
  );
  await expect(boxOf(page, "thread")).toHaveValue("");
  await expect(
    page.locator("text=reply kept through a refused send").last(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac2-retry-sent.png` });
});

test("AC-3 a successful send clears the composer and Enter-Enter sends once", async ({
  page,
}) => {
  await dmDefault(page, stack.webUrl);
  await boxOf(page, "home").fill("opens cleanly");
  await formOf(page, "home").evaluate((f: HTMLFormElement) =>
    f.requestSubmit(),
  );
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);

  // Reply via a real Enter-Enter: one send, composer cleared.
  const text = "double-enter sends once";
  await boxOf(page, "thread").fill(text);
  await boxOf(page, "thread").press("Enter");
  await boxOf(page, "thread").press("Enter");
  await expect(boxOf(page, "thread")).toHaveValue("");
  await expect(page.locator(`text=${text}`).last()).toBeVisible({
    timeout: 30_000,
  });

  // Wire check: exactly one message with that text reached the relay.
  const conv = page.url().match(/\/dm\/[^/]+\/([^/]+?)(?:\/focus)?$/)?.[1];
  const channelId = await channelIdFor(page, stack);
  const listed = await rpc(stack.home, [
    { method: "messages.list", params: { channelId, conversationId: conv } },
  ]);
  const sent = (
    listed[0] as { messages: { authorKind: string; text: string }[] }
  ).messages.filter((m) => m.text === text && m.authorKind === "user");
  expect(sent).toHaveLength(1);
  await page.screenshot({ path: `${SHOTS}/ac3-sent-once.png` });
});

test("AC-4 the prototype keeps its fake-send behaviour: send clears the composer", async ({
  page,
}) => {
  // The shared prototype dev server (playwright webServer, :5199).
  await page.goto("/");
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /builder/i })
    .click();
  const main = page.locator("main");
  await expect(main.locator("form")).toBeVisible();
  await main.locator("textarea").fill("prototype send clears");
  await main
    .locator("form")
    .evaluate((f: HTMLFormElement) => f.requestSubmit());
  await expect(main.locator("textarea")).toHaveValue("");
  await expect(main.locator("text=prototype send clears")).toBeVisible();
});
