import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";

/**
 * Issue #32 — macOS notifications + per-employee badges. ACs:
 *   AC-1 notification on done / needs approval / failed, only when that
 *       conversation is not in view;
 *   AC-2 clicking a notification opens the exact conversation;
 *   AC-3 per-employee badge = needs-approval count (priority) or running count.
 *
 * CI leg (engine-fake, also runs on Linux): the renderer logic is exercised
 * through an injected `window.lilos` bridge — the same shape the Electron
 * preload exposes — so the whole event→notification→route path is real, only
 * the OS banner + click are stubbed. The real macOS banner + click-through is
 * recorded on the VM; the live leg (`scripts/live/32.sh`, LILOS_ENGINE=hermes)
 * re-runs the deterministic part against real `hermes serve`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
// --repeat-each spreads a file's repeats across worker processes; each boots
// the stack again, so ports are offset per worker or relays race one port (#84).
// Pick bases whose port%100 avoids real service ports — worker indices run
// past 18, and 4579+18*100 lands on Redis's 6379 on Oscar's/dev VMs, which
// left the relay retry-loop dead and the web port never served (#84).
const WORKER = Number(process.env.TEST_WORKER_INDEX ?? "0");
const wport = (p: number) => p + WORKER * 100;

const webDir = path.join(repo, "apps", "web");
const SHOTS = path.join(repo, "test-results", "ac-32");
const LIVE = process.env.LILOS_ENGINE === "hermes";

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
    // Bound each poll: a socket that completes the handshake but never
    // answers would otherwise hang the wait past its budget (#84).
    const ok = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      .then((r) => r.ok || r.status === 404)
      .catch(() => false);
    if (ok) return;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function killProc(proc: ChildProcess): Promise<void> {
  // `bun run dev` stacks intermediate shim layers between `proc` and the
  // real dev-stack children, and bun doesn't forward signals through them —
  // signal the whole process group (the spawn is `detached`) or the stack
  // orphans and keeps its ports bound, poisoning the next boot (#84).
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

async function bootStack(
  tag: string,
  ports: { relay: number; feed: number; web: number },
): Promise<Stack> {
  const home = mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const leakTag = engineTag(tag);
  const proc = spawn("bun", ["run", "dev"], {
    cwd: webDir,
    detached: true,
    env: {
      ...process.env,
      LILOS_HOME: home,
      LILOS_ENGINE_TAG: leakTag,
      LILOS_RELAY_PORT: String(ports.relay),
      LILOS_FEED_PORT: String(ports.feed),
      LILOS_WEB_PORT: String(ports.web),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  // The stack umbrella exits as soon as any supervised child dies (e.g. a
  // vite whose --strictPort is still held by the previous repeat's draining
  // child) — fail on that exit instead of timing out against dead air (#84).
  const procDied = new Promise<never>((_, reject) => {
    proc.once("exit", (code) =>
      reject(new Error(`dev stack exited early (code ${code})`)),
    );
  });
  try {
    // Race every readiness probe against the umbrella's exit — a supervised
    // child dying between probes used to burn the full 30s timeout against
    // dead air (and misreported the port as the failure).
    const ready = (async () => {
      await waitForHttp(webUrl);
      // The page connects to relay + feed the moment it loads and only
      // retries post-handshake drops — wait for them to listen so a slow
      // boot under parallel load can't strand the client.
      await waitForHttp(`http://127.0.0.1:${ports.relay}/`);
      await waitForHttp(`http://127.0.0.1:${ports.feed}/`);
    })();
    await Promise.race([ready, procDied]);
    const tokenPath = path.join(home, "relay-token");
    let relayToken = "";
    // 30s headroom: under a full-suite run several stacks boot at once and
    // the relay can take >5s to write its token — an empty token surfaces as
    // a faraway "bad auth token", so fail here instead.
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
      relayWs: `ws://127.0.0.1:${ports.relay}/ws`,
      feedWs: `ws://127.0.0.1:${ports.feed}/ws`,
      relayToken,
      stop: async () => {
        await killProc(proc);
        await expectNoEngineLeak(leakTag);
      },
    };
  } catch (e) {
    // Group kill: `bun run dev` spawns detached — killing only the shim
    // orphans stack.ts + relay + harness + vite and poisons the next boot.
    await killProc(proc);
    throw e;
  }
}

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac32", {
    relay: wport(4663),
    feed: wport(4668),
    web: wport(5255),
  });
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });

interface PostedNote {
  conversationId: string;
  kind: string;
  title: string;
  body: string;
}

type BridgeWindow = Window & {
  __lilosPosts?: PostedNote[];
  __lilosOpenConv?: ((id: string) => void) | null;
  lilos?: unknown;
};

/** Inject the Electron `window.lilos` bridge: record posts, expose the
 * open-conversation callback so the test can simulate a notification click. */
async function injectBridge(page: Page) {
  await page.addInitScript(() => {
    const w = window as BridgeWindow;
    w.__lilosPosts = [];
    w.__lilosOpenConv = null;
    w.lilos = {
      notifications: {
        post: (n: PostedNote) => (w.__lilosPosts ?? []).push(n),
      },
      onOpenConversation: (cb: (id: string) => void) => {
        w.__lilosOpenConv = cb;
        return () => {};
      },
    };
  });
}

const posts = (page: Page) =>
  page.evaluate(() => (window as BridgeWindow).__lilosPosts ?? []);

const postKeys = (page: Page) =>
  page.evaluate(() =>
    ((window as BridgeWindow).__lilosPosts ?? []).map(
      (n) => `${n.conversationId}:${n.kind}`,
    ),
  );

const clickNotification = (page: Page, conversationId: string) =>
  page.evaluate((id) => {
    (window as BridgeWindow).__lilosOpenConv?.(id);
  }, conversationId);

/** Wait until the injected bridge recorded a post for `convId` of `kind`. */
async function waitForPost(
  page: Page,
  convId: string,
  kind: string,
  ms = 60_000,
) {
  await expect
    .poll(() => postKeys(page), { timeout: ms })
    .toContain(`${convId}:${kind}`);
}

async function dmDefault(page: Page) {
  await page.goto(`${stack.webUrl}/`);
  const aside = page.locator("aside");
  // Under real hermes the first-run hire waits on the engine's agent catalog
  // — the "Hiring your first employee…" placeholder clears only then. The
  // auto-hired agent is always profile id `default`; its display name is
  // "Default" on engine-fake and "default" on hermes.
  const employeeRow = aside.getByText(/^default$/i);
  await expect(employeeRow).toBeVisible({ timeout: LIVE ? 120_000 : 30_000 });
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
    await employeeRow.click();
  }
  await expect(page).toHaveURL(/\/dm\//);
}

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

/** After send() the URL becomes /dm/<emp>/<conv> — return the pair. */
const convFromUrl = async (page: Page) => {
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 15_000 });
  const m = /\/dm\/([^/]+)\/([^/]+)/.exec(new URL(page.url()).pathname);
  if (!m) throw new Error(`not on a conversation page: ${page.url()}`);
  return { employeeId: decodeURIComponent(m[1]), conversationId: m[2] };
};

const convUrl = (employeeId: string, conversationId: string) =>
  `${stack.webUrl}/dm/${encodeURIComponent(employeeId)}/${conversationId}`;

test("AC-1/AC-2/AC-3 (engine-fake): notify only when not in view, click opens the conversation, badges count", async ({
  page,
}) => {
  test.skip(LIVE, "fake-only leg — live leg runs via scripts/live/32.sh");
  test.setTimeout(240_000);
  await injectBridge(page);
  await dmDefault(page);

  // ── conv A: completes while in view → no notification ────────────────
  await send(page, "Say hello then list files");
  const convA = await convFromUrl(page);
  await expect(page.locator("[data-agentturn]").first()).toContainText(
    /envelope|file|Done|answer/i,
    { timeout: 90_000 },
  );
  // Turn fully done (badge cleared) + a beat for any stray event → the
  // in-view suppression really suppressed, not just raced.
  const aside = page.locator("aside");
  await expect(aside.locator("[data-badge-running]")).toHaveCount(0, {
    timeout: 60_000,
  });
  await page.waitForTimeout(500);
  expect(await posts(page)).toEqual([]); // AC-1 suppression

  // ── conv B: opens an approval while conv A is in view → ask badge + ask
  await page.goto(`${stack.webUrl}/dm/${convA.employeeId}`);
  await send(page, "Add a release note to the readme");
  const convB = await convFromUrl(page);
  await page.goto(convUrl(convA.employeeId, convA.conversationId));

  // AC-3: approvals badge on the employee while the ask waits.
  // #71 restyled the badge to `needs you`; the count lives on the title.
  await expect(aside.locator("[data-badge-approvals]")).toHaveText(
    "needs you",
    { timeout: 60_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac-3-badge-approvals.png` });

  await waitForPost(page, convB.conversationId, "ask");
  const askPost = (await posts(page)).find(
    (n) => n.conversationId === convB.conversationId,
  );
  expect(askPost?.title).toContain("approval");
  expect(askPost?.body).toBeTruthy();

  // AC-2: a notification click opens that exact conversation.
  await clickNotification(page, convB.conversationId);
  await expect(page).toHaveURL(
    new RegExp(`/dm/${convA.employeeId}/${convB.conversationId}`),
  );
  // Deterministic wait: the card carries data-ask-state once the relay ask
  // is in the store — this used to race channel.subscribe vs ask.opened
  // and could lose the ask permanently (issue #148).
  await expect(page.locator('[data-ask-state="open"]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Approval needed").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-2-click-through.png` });
  await page.getByRole("button", { name: "Allow once" }).first().click();

  // ── conv C: finishes out of view → done notification + running badge ─
  await page.goto(`${stack.webUrl}/dm/${convA.employeeId}`);
  await send(page, "Say hi to Carol");
  const convC = await convFromUrl(page);
  await page.goto(convUrl(convA.employeeId, convA.conversationId));
  // While it runs the blue running badge shows.
  await expect(aside.locator("[data-badge-running]")).toBeVisible({
    timeout: 60_000,
  });
  await waitForPost(page, convC.conversationId, "done");

  // ── conv D: fails out of view → failed notification ──────────────────
  await page.goto(`${stack.webUrl}/dm/${convA.employeeId}`);
  await send(page, "fail now please");
  const convD = await convFromUrl(page);
  await page.goto(convUrl(convA.employeeId, convA.conversationId));
  await waitForPost(page, convD.conversationId, "failed");
  const failPost = (await posts(page)).find(
    (n) => n.conversationId === convD.conversationId,
  );
  expect(failPost?.body).toContain("engine-fake");

  // Clicking the failed notification opens conv D with its error visible.
  await clickNotification(page, convD.conversationId);
  await expect(page).toHaveURL(
    new RegExp(`/dm/${convA.employeeId}/${convD.conversationId}`),
  );
  await expect(page.getByText(/Error: engine-fake/)).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-32-final.png` });
});

/**
 * Live leg (`scripts/live/32.sh`, LILOS_ENGINE=hermes): the deterministic part
 * — a real engine turn finishing out of view posts a notification and the
 * click opens that conversation. Approvals/failures can't be forced
 * deterministically through a real model, so those legs stay in the
 * engine-fake suite (same engine-protocol events; the notification path is
 * engine-agnostic).
 */
test("AC-32 live: done notification + click-through under real hermes", async ({
  page,
}) => {
  test.skip(!LIVE, "live leg — run via scripts/live/32.sh");
  test.setTimeout(300_000);
  await injectBridge(page);
  await dmDefault(page);

  await send(page, "Reply with exactly the word: ok");
  const convA = await convFromUrl(page);

  // A second conversation finishes while we look at the first.
  await page.goto(`${stack.webUrl}/dm/${convA.employeeId}`);
  await send(page, "Reply with exactly the word: done");
  const convB = await convFromUrl(page);
  await page.goto(convUrl(convA.employeeId, convA.conversationId));

  await waitForPost(page, convB.conversationId, "done", 240_000);
  await clickNotification(page, convB.conversationId);
  await expect(page).toHaveURL(
    new RegExp(`/dm/${convA.employeeId}/${convB.conversationId}`),
  );
});
