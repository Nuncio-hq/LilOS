import { type ChildProcess, execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";

/**
 * Issue #103 — unsent DM drafts are kept per conversation. Each acceptance
 * criterion is a named test; legs run against the real slice (apps/relay +
 * apps/harness with engine-fake + apps/web dev) on offset ports, plus one
 * AC-7 leg on the prototype webServer (baseURL).
 *
 * Serial: later legs reuse the sessions created earlier. AC-5 kills the
 * relay child to force a send failure, so it runs last among real-app legs.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
// Per-worker port offsets so parallel spec files never race one port (#84).
const WORKER = Number(process.env.TEST_WORKER_INDEX ?? "0");
const wport = (p: number) => p + WORKER * 10;
const PORTS = { relay: wport(4700), feed: wport(4705), web: wport(5290) };

const webDir = path.join(repo, "apps", "web");
const SHOTS = path.join(repo, "test-results", "ac-103");
const DRAFT_PREFIX = "lilos:composer-draft:";

interface Stack {
  home: string;
  webUrl: string;
  relayWs: string;
  feedWs: string;
  relayToken: string;
  stop: () => Promise<void>;
}

async function waitForHttp(url: string, ms = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const ok = await fetch(url)
      .then((r) => r.ok || r.status === 404)
      .catch(() => false);
    if (ok) return;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function killProc(proc: ChildProcess): Promise<void> {
  // `bun run dev` stacks shim layers; signal the whole group or children
  // orphan and keep their ports (#84).
  const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      if (proc.pid) process.kill(-proc.pid, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {}
    }
  };
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      killGroup("SIGKILL");
      resolve();
    }, 8_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    killGroup("SIGTERM");
  });
}

async function bootStack(tag: string): Promise<Stack> {
  const home = mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const leakTag = engineTag(tag);
  const proc = spawn("bun", ["run", "dev"], {
    cwd: webDir,
    detached: true,
    env: {
      ...process.env,
      LILOS_HOME: home,
      LILOS_ENGINE_TAG: leakTag,
      LILOS_RELAY_PORT: String(PORTS.relay),
      LILOS_FEED_PORT: String(PORTS.feed),
      LILOS_WEB_PORT: String(PORTS.web),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${PORTS.web}`;
  try {
    await waitForHttp(webUrl);
    await waitForHttp(`http://127.0.0.1:${PORTS.relay}/`);
    await waitForHttp(`http://127.0.0.1:${PORTS.feed}/`);
    const tokenPath = path.join(home, "relay-token");
    let relayToken = "";
    for (let i = 0; i < 300 && !relayToken; i++) {
      try {
        relayToken = readFileSync(tokenPath, "utf8").trim();
      } catch {}
      if (!relayToken) await new Promise((r) => setTimeout(r, 100));
    }
    if (!relayToken)
      throw new Error(`relay token never appeared at ${tokenPath}`);
    return {
      home,
      webUrl,
      relayWs: `ws://127.0.0.1:${PORTS.relay}/ws`,
      feedWs: `ws://127.0.0.1:${PORTS.feed}/ws`,
      relayToken,
      stop: async () => {
        await killProc(proc);
        await expectNoEngineLeak(leakTag);
      },
    };
  } catch (e) {
    proc.kill("SIGKILL");
    throw e;
  }
}

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("drafts");
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const homeComposer = (page: Page) => page.getByPlaceholder(/New session with/);
const threadComposer = (page: Page) =>
  page.getByPlaceholder(/Reply to .* in this session/);

/** Open the app, land on Default's DM (dismissing the first-run card). */
async function dmDefault(page: Page) {
  await page.goto(`${stack.webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  const dmBtn = page.getByRole("button", {
    name: /open dm|set up later|message/i,
  });
  if (
    await dmBtn
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await dmBtn.first().click();
  } else {
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
}

/** Sidebar employee button → their DM home. */
async function openDm(page: Page, name: RegExp | string) {
  await page.locator("aside").getByRole("button", { name }).click();
  await expect(page).toHaveURL(/\/dm\//);
}

/** The session row containing `text` — earlier serial legs leave extra
    sessions, so never click rows positionally. */
const sessionRowWith = (page: Page, text: string) =>
  page.locator("[data-session]", { hasText: text });

const convIdFromUrl = (page: Page) =>
  decodeURIComponent(page.url().split("/dm/")[1].split("/")[1] ?? "");

/** One JSON-RPC call on the relay from inside the page (hello + request). */
async function relayRpc(
  page: Page,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const ws = stack.relayWs;
  const token = stack.relayToken;
  return await page.evaluate(
    async ({ ws, token, method, params }) => {
      const sock = new WebSocket(ws);
      const rpc = (id: number, m: string, p: Record<string, unknown>) =>
        sock.send(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }));
      return await new Promise((resolve, reject) => {
        const fail = (e: unknown) => {
          sock.close();
          reject(e instanceof Error ? e : new Error(String(e)));
        };
        sock.onerror = () => fail(new Error("ws error"));
        sock.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.error) return fail(new Error(msg.error.message));
          if (msg.id === 1) rpc(2, method, params);
          else if (msg.id === 2) {
            sock.close();
            resolve(msg.result);
          }
        };
        sock.onopen = () =>
          rpc(1, "session.hello", {
            protocolVersion: 1,
            token,
            client: { name: "e2e-103" },
          });
      });
    },
    { ws, token, method, params },
  );
}

const draftKeys = (page: Page) =>
  page.evaluate(
    (prefix) =>
      Array.from({ length: localStorage.length }, (_, i) =>
        localStorage.key(i),
      ).filter((k): k is string => !!k?.startsWith(prefix)),
    DRAFT_PREFIX,
  );

test("AC-1 draft survives switching sessions; each thread keeps its own", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await homeComposer(page).fill("session alpha");
  await homeComposer(page).press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);
  const convA = convIdFromUrl(page);

  await threadComposer(page).fill("draft in alpha");

  // A second session's composer shows its own draft (empty until typed).
  await openDm(page, /default/i);
  await homeComposer(page).fill("session beta");
  await homeComposer(page).press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);
  const convB = convIdFromUrl(page);
  expect(convB).not.toBe(convA);
  await expect(threadComposer(page)).toHaveValue("");

  await threadComposer(page).fill("draft in beta");
  await sessionRowWith(page, "session alpha")
    .getByRole("button", { name: /\d+ repl(y|ies)/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/dm/[^/]+/${convA}`));
  await expect(threadComposer(page)).toHaveValue("draft in alpha");
  await page.screenshot({ path: `${SHOTS}/ac-1-draft-restored.png` });
});

test("AC-2 home composer keeps its own draft, separate from thread drafts", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await homeComposer(page).fill("home draft");
  await homeComposer(page).press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);

  await homeComposer(page).fill("next top-level thought");
  await threadComposer(page).fill("thread draft");
  // Both composers hold their own draft at once — home key ≠ thread key.
  await expect(homeComposer(page)).toHaveValue("next top-level thought");
  await expect(threadComposer(page)).toHaveValue("thread draft");
  await page.screenshot({ path: `${SHOTS}/ac-2-home-vs-thread.png` });
});

test("AC-3 switching employees keeps each employee's drafts", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await relayRpc(page, "employees.create", { name: "Blanca" });
  await expect(
    page.locator("aside").getByRole("button", { name: /blanca/i }),
  ).toBeVisible({ timeout: 15_000 });

  await homeComposer(page).fill("draft for default");
  await openDm(page, /blanca/i);
  await expect(homeComposer(page)).toHaveValue("");
  await homeComposer(page).fill("draft for blanca");
  await openDm(page, /default/i);
  await expect(homeComposer(page)).toHaveValue("draft for default");
  await openDm(page, /blanca/i);
  await expect(homeComposer(page)).toHaveValue("draft for blanca");
  await page.screenshot({ path: `${SHOTS}/ac-3-employee-drafts.png` });
});

test("AC-4 a draft survives a page reload", async ({ page }) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await homeComposer(page).fill("survives reload");
  await homeComposer(page).press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);
  await threadComposer(page).fill("still here after reload");
  await page.reload();
  await expect(threadComposer(page)).toHaveValue("still here after reload", {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-4-after-reload.png` });
});

test("AC-6 clearing text drops the draft; archive + remove prune theirs", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await dmDefault(page);
  await homeComposer(page).fill("session to archive");
  await homeComposer(page).press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);
  const convA = convIdFromUrl(page);

  // Delete-all removes the stored draft (no empty entries pile up).
  await threadComposer(page).fill("wip");
  await threadComposer(page).fill("");
  await page.waitForTimeout(300);
  expect(await draftKeys(page)).toEqual([]);

  // Archiving a session drops its draft — scope to this leg's session row:
  // earlier tests' sessions exist on the same serial stack.
  await threadComposer(page).fill("draft to prune");
  await sessionRowWith(page, "session to archive")
    .getByRole("button", { name: "Session actions" })
    .click();
  await page.getByRole("menuitem", { name: "Archive session" }).click();
  await page.waitForTimeout(500);
  for (const k of await draftKeys(page)) expect(k.endsWith(convA)).toBe(false);
  await page.screenshot({ path: `${SHOTS}/ac-6-pruned.png` });

  // Removing an employee drops its home draft (and its threads').
  await relayRpc(page, "employees.create", { name: "Carmen" });
  await expect(
    page.locator("aside").getByRole("button", { name: /carmen/i }),
  ).toBeVisible({ timeout: 15_000 });
  await openDm(page, /carmen/i);
  await homeComposer(page).fill("carmen draft");
  expect((await draftKeys(page)).length).toBeGreaterThan(0);
  const listed = (await relayRpc(page, "employees.list", {})) as {
    employees?: { id: string; name: string }[];
  };
  const carmenId = listed.employees?.find((e) => e.name === "Carmen")?.id;
  expect(carmenId).toBeTruthy();
  await relayRpc(page, "employees.remove", { id: carmenId });
  await page.waitForTimeout(500);
  for (const k of await draftKeys(page))
    expect(k.endsWith(`:${carmenId}`)).toBe(false);
});

test("AC-5 sending clears only that draft; a failed send keeps the text", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await dmDefault(page);
  // Two sessions, one draft each.
  await homeComposer(page).fill("session one");
  await homeComposer(page).press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);
  const convA = convIdFromUrl(page);
  await threadComposer(page).fill("alpha draft");
  await openDm(page, /default/i);
  await homeComposer(page).fill("session two");
  await homeComposer(page).press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);
  const convB = convIdFromUrl(page);
  await threadComposer(page).fill("beta draft");

  // Send in B: B clears, A's draft untouched.
  await threadComposer(page).press("Enter");
  await expect(threadComposer(page)).toHaveValue("", { timeout: 30_000 });
  await sessionRowWith(page, "session one")
    .getByRole("button", { name: /\d+ repl(y|ies)/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/dm/[^/]+/${convA}`));
  await expect(threadComposer(page)).toHaveValue("alpha draft");

  // A failed send keeps the text: SIGKILL the relay so the client's socket
  // closes — the send rejects (`relay not connected`) and nothing can clear
  // the draft. Only a resolved send clears, so the text is safe either way.
  const pids = execSync(`lsof -ti tcp:${PORTS.relay} -sTCP:LISTEN`)
    .toString()
    .trim();
  for (const pid of pids.split("\n").filter(Boolean))
    process.kill(Number(pid), "SIGKILL");
  await page.waitForTimeout(1_500); // let the browser's onclose land
  await threadComposer(page).press("Enter");
  await page.waitForTimeout(1_000);
  await expect(threadComposer(page)).toHaveValue("alpha draft");
  await page.screenshot({ path: `${SHOTS}/ac-5-failed-send-kept.png` });
  void convB;
});

test("AC-7 prototype shows the same behaviour", async ({ page }) => {
  await page.goto("/");
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  const home = page.getByPlaceholder(/New session with Builder/);
  const thread = page.getByPlaceholder(/Reply to .* in this session/);
  await home.fill("prototype session");
  await home.press("Enter");
  await expect(thread).toBeVisible({ timeout: 15_000 });
  await thread.fill("proto draft");
  // Switch to another employee's DM and back — Builder's draft is still there.
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Reviewer/ })
    .click();
  await expect(page.getByPlaceholder(/New session with Reviewer/)).toBeVisible({
    timeout: 15_000,
  });
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  await expect(thread).toHaveValue("proto draft", { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-7-prototype.png` });
});
