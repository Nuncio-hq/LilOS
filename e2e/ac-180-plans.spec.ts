import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { wport } from "./ports";

/**
 * Issue #180 — plans & task lists from the real engine, in the real app.
 * engine-fake's `plan:` prompts drive the `plan` capability:
 *   `plan: tasks`   — an agent-kept working list ticking live (no ask);
 *   `plan: propose` — a plan proposal gated by a plan request
 *                     (Approve / Change… / Reject; change → v2 asks again).
 * Same stack as e2e/ac-71-dm.spec.ts (apps/relay + apps/harness on
 * engine-fake + vite dev) on offset ports.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");

interface Stack {
  webUrl: string;
  stop: () => Promise<void>;
}

async function waitForHttp(url: string, ms = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
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
  const procDied = new Promise<never>((_, reject) => {
    proc.once("exit", (code) =>
      reject(new Error(`dev stack exited early (code ${code})`)),
    );
  });
  try {
    await Promise.race([waitForHttp(webUrl), procDied]);
    return {
      webUrl,
      stop: async () => {
        await killProc(proc);
        await expectNoEngineLeak(leakTag);
      },
    };
  } catch (e) {
    await killProc(proc);
    throw e;
  }
}

const SHOTS = path.join(repo, "test-results", "ac-180");
/** Folder for AC-5 sessions — the workbench only exists on a bound folder. */
const wbDir = mkdtempSync(path.join(tmpdir(), "lilos-ac180-wb-"));

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac180", {
    relay: wport(4660),
    feed: wport(4661),
    web: wport(5260),
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

/* ------------------------------------------------------------------ */

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

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

/** Every plan/tasks card in the thread (data-plan carries the planId). */
const planCards = (page: Page) => page.locator("[data-plan]");
const lastCard = (page: Page) => planCards(page).last();

const pickerButton = (page: Page) => page.locator('[data-ws="folder"]');

/** Pick `dir` for the next session (same helper as ac-114): the workbench
   only exists when the conversation has a folder (D-#19). */
async function pickFolder(page: Page, dir: string) {
  const menu = await (async () => {
    await pickerButton(page).click();
    return page
      .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
      .last();
  })();
  /* Recents fill async (folders.list + probe) — a plain isVisible() races
     them and falls into the dialog, where re-adding a known path keeps the
     button disabled forever. Wait for the row before deciding. */
  const recent = menu.locator(`[data-wsfolder="${dir}"]`).first();
  const hit = await recent
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (hit) {
    await recent.click();
  } else {
    await menu.getByText("Add a folder").click();
    const dialog = page.locator("[data-addfolder]");
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-pathinput]").fill(dir);
    await expect(dialog.locator("[data-folderinfo]")).toBeVisible({
      timeout: 15_000,
    });
    await dialog.locator("[data-addbtn]").click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(pickerButton(page)).toContainText(path.basename(dir), {
    timeout: 15_000,
  });
}

/** A fresh conversation carrying prompt `text`, opened into Focus. Pass
   `folder` to bind the session's folder (workbench needs one). */
async function openSession(
  page: Page,
  text: string,
  folder?: string,
): Promise<Locator> {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${stack.webUrl}/`);
  await page
    .getByRole("button", { name: /default/i })
    .first()
    .click();
  if (folder) await pickFolder(page, folder);
  await send(page, text);
  await expect(page).toHaveURL(/\/focus/, { timeout: 30_000 });
  const card = lastCard(page);
  await expect(card).toBeVisible({ timeout: 60_000 });
  return card;
}

test("AC-1 a task list ticks live and reload restores it", async ({ page }) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  /* `plan: slow` (same script, ~1.5s/item) keeps an in_progress step
     observable — at the fast pace the list can complete before the card's
     first poll on a loaded runner. */
  await send(page, "plan: slow — sweep the readme");
  const card = lastCard(page);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toHaveAttribute("data-planstatus", "approved");
  // Items tick: at least one in_progress before the list ends.
  await expect(
    card.locator('[data-planstep="in_progress"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  // Reload mid/late-turn — the seq replay rebuilds the same card.
  await page.reload();
  await expect(lastCard(page)).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-tasks-live.png` });
  // Done folds to "Tasks done" (tap expands back).
  await expect(lastCard(page)).toHaveAttribute("data-planphase", "done", {
    timeout: 90_000,
  });
  await expect(lastCard(page)).toContainText("Tasks done");
});

test("AC-2 stop mid-turn cancels the in-flight items", async ({ page }) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  /* `plan: slow` paces the same list with a ~1.5s hold per item — the
     interrupt lands mid-list deterministically (a fast `plan: tasks` can
     finish between the in_progress render and Escape on a loaded runner). */
  await send(page, "plan: slow — a list to interrupt");
  const card = lastCard(page);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(
    card.locator('[data-planstep="in_progress"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  // Esc in the composer interrupts the running turn.
  const box = page.locator("main textarea").last();
  await box.click();
  await page.keyboard.press("Escape");
  await expect(card).toHaveAttribute("data-planphase", "stopped", {
    timeout: 30_000,
  });
  await expect(card).toContainText(/Stopped · \d+\/\d+/);
  await expect(
    card.locator('[data-planstep="cancelled"]').first(),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-2-stopped.png` });
});

test("AC-3 a proposed plan asks Approve / Change… / Reject and counts in the sidebar", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const card = await openSession(page, "plan: propose — backoff reconnect");
  await expect(card).toHaveAttribute("data-planstatus", "proposed");
  await expect(card).toHaveAttribute("data-planphase", "waiting");
  await expect(card).toContainText("Waiting for you");
  await expect(card).toContainText("Goal · ");
  await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Change…" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Reject" })).toBeVisible();
  // The session reads "needs you" in the sidebar like an approval (AC-3).
  // Focus has no sidebar (#246) — back to the panel, which shows the card too.
  await page.getByTitle("Back to DM").click();
  await expect(page.locator("[data-badge-approvals]")).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-3-plan-ask.png` });
  // Park it approved so the next serial test's session starts clean.
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveAttribute("data-planstatus", "approved", {
    timeout: 30_000,
  });
});

test("AC-4 approve ticks the steps; reject stops it; change yields v2 and folds v1", async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Approve → the engine runs the steps, the card ticks to done.
  const approved = await openSession(page, "plan: propose — v1 approve");
  await approved.getByRole("button", { name: "Approve" }).click();
  await expect(approved).toHaveAttribute("data-planstatus", "approved");
  await expect(approved).toHaveAttribute("data-planphase", "done", {
    timeout: 90_000,
  });
  await expect(approved).toContainText(/Plan done|done/);
  await page.screenshot({ path: `${SHOTS}/ac-4-approved.png` });

  // Reject → the engine is told, nothing runs, the card reads Rejected.
  const rejected = await openSession(page, "plan: propose — v1 reject");
  await rejected.getByRole("button", { name: "Reject" }).click();
  await expect(rejected).toHaveAttribute("data-planstatus", "rejected", {
    timeout: 30_000,
  });
  await expect(rejected).toContainText("Rejected");
  await expect(rejected.locator("[data-planstep]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-4-rejected.png` });

  // Change… → composer prefilled; send answers the request; v2 arrives and
  // v1 folds "Replaced by v2".
  const card = await openSession(page, "plan: propose — v1 change");
  await card.getByRole("button", { name: "Change…" }).click();
  const box = page.locator("main textarea").last();
  await expect(box).toHaveValue("Change the plan: ", { timeout: 15_000 });
  await box.fill("Change the plan: skip the banner step");
  await box.press("Enter");
  /* Key on the element, not the status: a proposed-only locator dies the
     instant the card flips, so it could never observe "approved". The last
     plan card is the live version; superseded ones fold ahead of it. */
  const v2 = lastCard(page);
  await expect(v2).toContainText("v2", { timeout: 60_000 });
  const v1 = planCards(page).first();
  await expect(v1).toHaveAttribute("data-planstatus", "replaced");
  await expect(v1).toContainText("Replaced by v2");
  await page.screenshot({ path: `${SHOTS}/ac-4-changed-v2.png` });
  // Approving v2 runs its steps to the end.
  await v2.getByRole("button", { name: "Approve" }).click();
  await expect(v2).toHaveAttribute("data-planstatus", "approved");
  await expect(v2).toHaveAttribute("data-planphase", "done", {
    timeout: 120_000,
  });
});

/** A fresh conversation without a plan expectation — waits for the turn to
   settle on the reply text, not for a card. */
async function openPlain(page: Page, text: string, folder?: string) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${stack.webUrl}/`);
  await page
    .getByRole("button", { name: /default/i })
    .first()
    .click();
  if (folder) await pickFolder(page, folder);
  await send(page, text);
  await expect(page).toHaveURL(/\/focus/, { timeout: 30_000 });
  await expect(page.getByText(/Short answer/)).toBeVisible({
    timeout: 60_000,
  });
}

test("AC-5 the Workbench Plan tab shows the current plan and earlier versions; hidden without one", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // A folder-bound session with no plan shows its workbench but no Plan tab.
  await openPlain(page, "Say hello once", wbDir);
  await expect(page.getByRole("tab", { name: /^Plan/ })).toHaveCount(0, {
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-5-no-plan-tab.png` });

  // A change→v2 session lists v1 in the panel's earlier versions.
  const card = await openSession(page, "plan: propose — tab history", wbDir);
  await card.getByRole("button", { name: "Change…" }).click();
  const box = page.locator("main textarea").last();
  await box.fill("Change the plan: tighten the retry cap");
  await box.press("Enter");
  const v2 = lastCard(page);
  await expect(v2).toContainText("v2", { timeout: 60_000 });
  const tab = page.getByRole("tab", { name: /^Plan/ });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click();
  await page.screenshot({ path: `${SHOTS}/ac-5-plan-tab.png` });
  // The panel shows v2 plus the earlier version it replaced.
  await expect(page.getByText(/v1 · Replaced/).first()).toBeVisible({
    timeout: 15_000,
  });
  await v2.getByRole("button", { name: "Reject" }).click();
});
