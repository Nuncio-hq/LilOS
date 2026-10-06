import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import {
  captureProc,
  killProc,
  pickPorts,
  WORKER,
  waitForFeed,
  waitForHttp,
  waitForRelay,
  waitForToken,
} from "./helpers/stack";

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

const viteCacheDir = `node_modules/.vite-ac138-w${WORKER}`;

async function boot(tag: string): Promise<Procs> {
  const base = mkdtempSync(path.join(tmpdir(), `lilos-e2e-138-${tag}-`));
  const leakTag = engineTag(tag);
  const ports = await pickPorts();
  const procs: Procs["procs"] = {
    relay: undefined,
    harness: undefined,
    web: undefined,
  };

  const relay = spawn("bun", ["run", "apps/relay/src/index.ts"], {
    cwd: repo,
    env: {
      ...process.env,
      LILOS_RELAY_HOME: base,
      LILOS_RELAY_PORT: String(ports.relay),
      LILOS_RELAY_HOST: "127.0.0.1",
    },
    // Piped: readiness checks the spawned process's own instanceId against
    // /healthz — a foreign stack on the port is a hard boot failure (#273).
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.relay = relay;
  await waitForRelay(ports.relay, relay, captureProc(relay));
  const relayToken = await waitForToken(base);

  const harnessHome = path.join(base, "harness");
  const harness = spawn("bun", ["run", "apps/harness/src/index.ts"], {
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
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.harness = harness;
  await waitForFeed(ports.feed, harness, captureProc(harness));

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
   hit proves the message index — not the old title filter — found it.
   HIT_TEXT is a long message with the term near its end: the fake's reply
   echoes it back (a second long hit), and under the old 40-token excerpt the
   <mark> fell outside the one-line row — the regression this spec guards. */
const HIT_TEXT =
  "deploy log for the ingest run: build green cache warm smoke tests " +
  "passed dashboards quiet queue drained workers healthy region failover " +
  "idle retries zero latency flat alarms silent and then the quaggmire " +
  "throttle kicked in mid-ingest";
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

  /* engine-fake steers mid-turn sends into the running turn — a follow-up
     only gets its own reply once the composer is back to its idle
     placeholder ("Reply to Default…" on both the peek panel and
     Focus, where a send lands since #114). */
  const idleComposer = page.getByPlaceholder(
    /Reply to Default/,
  );

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
  await expect(idleComposer).toBeVisible({ timeout: 60_000 });
  await send(page, HIT_TEXT);
  await expect(page.getByText(HIT_TEXT).first()).toBeVisible();
  /* The fake's follow-up reply echoes the message with its first letter
     capitalized, deep in its own text — waiting for "Deploy" makes the
     "Default" hit row deterministic: its excerpt used to be clipped before
     the <mark> was reached. (The thread panel is outside `main`.) */
  await expect(
    page.getByText(/Deploy log for the ingest run/).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(idleComposer).toBeVisible({ timeout: 60_000 });

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
  await expect(idleComposer).toBeVisible({ timeout: 60_000 });
  await send(page, HIT_ARCHIVED);
  await expect(page.getByText(HIT_ARCHIVED).first()).toBeVisible();
  await expect(
    page.getByText(/Quaggmire shows inside the archived session too/).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(idleComposer).toBeVisible({ timeout: 60_000 });

  // Back to the DM home; archive session B via its session menu.
  await page.goto(dmHome);
  await expect(page.getByText(ROOT_B).first()).toBeVisible({
    timeout: 30_000,
  });
  const menuBtns = page.getByRole("button", { name: "Thread actions" });
  await expect(menuBtns.first()).toBeVisible();
  // Session order: created ascending — B is the second of two.
  await menuBtns.nth(1).click();
  await page.getByRole("menuitem", { name: "Archive thread" }).click();
  await expect(page.getByText(/Archived/)).toBeVisible({ timeout: 10_000 });

  // AC-2: the filter now shows a Messages group; B's hit carries the
  // archived marker, the term is wrapped in <mark>.
  const filter = page.getByPlaceholder("Filter threads");
  await filter.fill("quaggmire");
  const hitsPanel = page.locator("[data-message-hits]");
  await expect(hitsPanel).toBeVisible({ timeout: 10_000 });
  await expect(hitsPanel.getByText("Messages")).toBeVisible();
  // Group headers carry the session title (falls back to its first message).
  await expect(hitsPanel.getByText(ROOT_A)).toBeVisible();
  await expect(hitsPanel.locator("mark").first()).toHaveText("quaggmire");
  await expect(hitsPanel.locator("[data-archived-hit]").first()).toBeVisible();

  /* Every hit row must visibly show the matched term: each row's <mark>
     renders inside the row's own box and in the viewport — not clipped away
     by the excerpt (the fake's follow-up reply echoes the term deep in its
     text, which is exactly the row that used to lose its mark). */
  const hitRows = hitsPanel.locator("[data-message-hit]");
  // 4 hits: both user follow-ups + both fake replies echoing the term.
  await expect(hitRows).toHaveCount(4, { timeout: 10_000 });
  const hitCount = await hitRows.count();
  expect(hitCount).toBeGreaterThan(0);
  for (let i = 0; i < hitCount; i++) {
    const row = hitRows.nth(i);
    expect(
      await row.locator("mark").count(),
      `hit row ${i} shows no marked term`,
    ).toBeGreaterThan(0);
    const mark = row.locator("mark").first();
    await expect(mark).toBeInViewport();
    const rowBox = await row.boundingBox();
    const markBox = await mark.boundingBox();
    expect(rowBox, `hit row ${i} has no box`).not.toBeNull();
    expect(markBox, `hit row ${i} mark is not rendered`).not.toBeNull();
    if (!rowBox || !markBox) continue;
    expect(markBox.x).toBeGreaterThanOrEqual(rowBox.x - 1);
    expect(markBox.y).toBeGreaterThanOrEqual(rowBox.y - 1);
    expect(markBox.x + markBox.width).toBeLessThanOrEqual(
      rowBox.x + rowBox.width + 1,
    );
    expect(markBox.y + markBox.height).toBeLessThanOrEqual(
      rowBox.y + rowBox.height + 1,
    );
  }
  await page.screenshot({ path: `${SHOTS}/ac2-message-hits.png` });

  // AC-3 + #195 AC-3: clicking a hit opens the session IN THE PEEK PANEL
  // (the conversation URL, not /focus) scrolled to and flashing THAT
  // message — the row's data-message-hit id names the anchor it scrolls to.
  const clicked = hitsPanel
    .locator("[data-message-hit]")
    .filter({ hasText: "mid-ingest" })
    .first();
  const hitId = await clicked.getAttribute("data-message-hit");
  expect(hitId).toBeTruthy();
  await clicked.click();
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_[^/]+$/, {
    timeout: 10_000,
  });
  const panel = page.locator("[data-thread-panel]");
  await expect(panel).toBeVisible();
  const anchor = panel.locator(`[data-msg="${hitId}"]`);
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
