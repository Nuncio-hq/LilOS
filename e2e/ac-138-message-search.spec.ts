import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";

/**
 * Issue #138 — full-text search inside sessions: the DM session filter also
 * returns message hits (AC-2), a click opens the session scrolled/flashed to
 * that message (AC-3), archived sessions surface with a marker (AC-4), and
 * the empty state says messages are searched too.
 *
 * Same three-process boot as ac-28 (relay + harness + vite), own ports.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");
const SHOTS = path.join(repo, "test-results", "ac-138");

interface Procs {
  home: string;
  webUrl: string;
  ports: { relay: number; feed: number; web: number };
  procs: Record<"relay" | "harness" | "web", ChildProcess | undefined>;
  kill: () => Promise<void>;
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

const WORKER = Number(process.env.TEST_WORKER_INDEX ?? "0");
const viteCacheDir = `node_modules/.vite-ac138-w${WORKER}`;

async function boot(tag: string): Promise<Procs> {
  const base = mkdtempSync(path.join(tmpdir(), `lilos-e2e-138-${tag}-`));
  const leakTag = engineTag(tag);
  const ports = {
    relay: 4710 + WORKER * 10,
    feed: 4714 + WORKER * 10,
    web: 5340 + WORKER * 10,
  };
  const procs: Procs["procs"] = {
    relay: undefined,
    harness: undefined,
    web: undefined,
  };

  procs.relay = spawn("bun", ["run", "apps/relay/src/index.ts"], {
    cwd: repo,
    env: {
      ...process.env,
      LILOS_RELAY_HOME: base,
      LILOS_RELAY_PORT: String(ports.relay),
      LILOS_RELAY_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForHttp(`http://127.0.0.1:${ports.relay}/`);
  const relayToken = await waitForToken(base);

  const harnessHome = path.join(base, "harness");
  procs.harness = spawn("bun", ["run", "apps/harness/src/index.ts"], {
    cwd: repo,
    env: {
      ...process.env,
      LILOS_ENGINE: "fake",
      LILOS_RELAY_URL: `ws://127.0.0.1:${ports.relay}/ws`,
      LILOS_RELAY_HOME: base,
      LILOS_RELAY_TOKEN: relayToken,
      LILOS_HARNESS_HOME: harnessHome,
      LILOS_REPO_ROOT: repo,
      LILOS_WORKDIR: path.join(harnessHome, "work"),
      LILOS_FEED_PORT: String(ports.feed),
      LILOS_ENGINE_TAG: leakTag,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForHttp(`http://127.0.0.1:${ports.feed}/`);

  procs.web = spawn(
    "bun",
    [
      path.join(webDir, "node_modules", ".bin", "vite"),
      "--config",
      path.join(webDir, "vite.ac28.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(ports.web),
      "--strictPort",
    ],
    {
      cwd: webDir,
      env: {
        ...process.env,
        LILOS_RELAY_WS: `ws://127.0.0.1:${ports.relay}/ws`,
        LILOS_RELAY_TOKEN: relayToken,
        LILOS_ENGINE_WS: `ws://127.0.0.1:${ports.feed}/ws`,
        LILOS_WEB_PORT: String(ports.web),
        LILOS_VITE_CACHE_DIR: viteCacheDir,
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  await waitForHttp(`http://127.0.0.1:${ports.web}`);
  return {
    home: base,
    webUrl: `http://127.0.0.1:${ports.web}`,
    ports,
    procs,
    kill: async () => {
      for (const n of ["web", "harness", "relay"] as const) {
        const p = procs[n];
        if (p) {
          procs[n] = undefined;
          await killProc(p);
        }
      }
      await expectNoEngineLeak(leakTag);
    },
  };
}

/** Open the app, land on Default's DM home (dismissing the first-run card). */
async function dmDefault(stack: Procs, page: Page) {
  await page.goto(`${stack.webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 60_000,
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

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

let stack: Procs;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  rmSync(path.join(webDir, viteCacheDir), { recursive: true, force: true });
  stack = await boot("main");
});
test.afterAll(async () => {
  await stack?.kill();
});
test.describe.configure({ mode: "serial" });

/* Terms live only inside messages (never in a title/first message), so a
   hit proves the message index — not the old title filter — found it. */
const HIT_TEXT = "the quaggmire throttle kicked in mid-ingest";
const HIT_ARCHIVED = "quaggmire shows inside the archived session too";
const ROOT_A = "Summarize the repo layout in one line";
const ROOT_B = "Second session for the archive marker check";

test("AC-2/3/4 message hits: grouped, highlighted, click scrolls, archived marked", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await dmDefault(stack, page);
  const dmHome = page.url();

  // Session A: open, wait for the fake reply, then send a follow-up holding
  // the term — a message that is NOT the title or first message.
  await send(page, ROOT_A);
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_/, { timeout: 15_000 });
  await expect(
    page
      .locator("main")
      .getByText(/Short answer|Done on/i)
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  await send(page, HIT_TEXT);
  await expect(page.getByText(HIT_TEXT).first()).toBeVisible();

  // Session B: same shape, then archived — its hit must carry the marker.
  await page.goto(dmHome);
  await send(page, ROOT_B);
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_/, { timeout: 15_000 });
  await expect(
    page
      .locator("main")
      .getByText(/Short answer|Done on/i)
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  await send(page, HIT_ARCHIVED);
  await expect(page.getByText(HIT_ARCHIVED).first()).toBeVisible();

  // Back to the DM home; archive session B via its session menu.
  await page.goto(dmHome);
  await expect(page.getByText(ROOT_B).first()).toBeVisible({
    timeout: 30_000,
  });
  const menuBtns = page.getByRole("button", { name: "Session actions" });
  await expect(menuBtns.first()).toBeVisible();
  // Session order: created ascending — B is the second of two.
  await menuBtns.nth(1).click();
  await page.getByRole("menuitem", { name: "Archive session" }).click();
  await expect(page.getByText(/Archived/)).toBeVisible({ timeout: 10_000 });

  // AC-2: the filter now shows a Messages group; B's hit carries the
  // archived marker, the term is wrapped in <mark>.
  const filter = page.getByPlaceholder("Filter sessions");
  await filter.fill("quaggmire");
  const hitsPanel = page.locator("[data-message-hits]");
  await expect(hitsPanel).toBeVisible({ timeout: 10_000 });
  await expect(hitsPanel.getByText("Messages")).toBeVisible();
  await expect(hitsPanel.locator("mark").first()).toHaveText("quaggmire");
  await expect(hitsPanel.locator("[data-archived-hit]").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac2-message-hits.png` });

  // AC-3: clicking the live session's hit opens it and flashes the message.
  await hitsPanel
    .locator("[data-message-hit]")
    .filter({ hasText: "mid-ingest" })
    .click();
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_/, { timeout: 10_000 });
  /* The live-turn overlay can echo the phrase too — anchor the stored row. */
  const anchor = page
    .locator('[data-msg^="msg_"]')
    .filter({ hasText: "mid-ingest" });
  await expect(anchor).toBeVisible({ timeout: 15_000 });
  await expect(anchor).toHaveClass(/amber/, { timeout: 5_000 });
  await page.screenshot({ path: `${SHOTS}/ac3-hit-scrolled.png` });

  // Back to the box: the empty state now says messages are searched too.
  await page.goto(dmHome);
  await expect(filter).toBeVisible({ timeout: 30_000 });
  await filter.fill("definitely-not-anywhere");
  await expect(page.getByText(/Titles and messages are searched/i)).toBeVisible(
    { timeout: 10_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac2-empty-state.png` });
});
