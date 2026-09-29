import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { wport } from "./ports";

/**
 * Issue #179 — subagents and background work in the real app (apps/web,
 * relay + harness on engine-fake), driven by real engine events:
 *   AC-1 the turn's Subagents block: one live row per helper, status +
 *       duration, opening a row shows brief/steps/report; rows survive a
 *       mid-turn reload (seq replay), no duplicates.
 *   AC-2 a helper's file write lands in Workbench → Changes (same checkout).
 *   AC-3 an employee-helper row shows that employee's avatar + Open session
 *       → their own session in their DM.
 *   AC-4 a background process lists under Workbench → Background with
 *       command/status/uptime/URL/output tail; Stop ends it ("stopped by you").
 *   AC-5 Background tab + Stop render only under the `background_jobs`
 *       capability (D-#19).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");
const SHOTS = path.join(repo, "test-results", "ac-179");

interface Stack {
  home: string;
  webUrl: string;
  relayWs: string;
  relayToken: string;
  stop: () => Promise<void>;
}

async function waitForHttp(
  url: string,
  proc?: ChildProcess,
  ms = 120_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      .then((r) => r.ok || r.status === 404)
      .catch(() => false);
    if (ok) return;
    if (proc && proc.exitCode !== null)
      throw new Error(`stack exited ${proc.exitCode} before ${url}`);
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function killProc(proc: ChildProcess): Promise<void> {
  // `bun run dev` stacks shims between proc and the dev-stack children —
  // signal the detached process group or the stack orphans and keeps its
  // ports bound, poisoning the next boot (#84).
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
  extraEnv: Record<string, string> = {},
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
      ...extraEnv,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    await waitForHttp(webUrl, proc);
    await waitForHttp(`http://127.0.0.1:${ports.relay}/`, proc);
    const tokenPath = path.join(home, "relay-token");
    let relayToken = "";
    for (let i = 0; i < 300 && !relayToken; i++) {
      try {
        relayToken = readFileSync(tokenPath, "utf8").trim();
      } catch {}
      if (!relayToken) await new Promise((r) => setTimeout(r, 100));
    }
    return {
      home,
      webUrl,
      relayWs: `ws://127.0.0.1:${ports.relay}/ws`,
      relayToken,
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

/* A git checkout the session's folder pick binds — the fake's helper writes
   land here, which is exactly what Workbench → Changes reads (AC-2). */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-179-"));
const repoDir = path.join(ROOT, "lilos-repo");
mkdirSync(repoDir, { recursive: true });
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
git(["init", "-b", "trunk"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
execFileSync(
  "sh",
  [
    "-c",
    'echo "# Fixture repo for #179 e2e" > README.md && git add -A && git commit -m init',
  ],
  { cwd: repoDir },
);

/* A slightly stretched tick so a reload can land mid-turn (AC-1 replay)
   without making the suite crawl. */
let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack(
    "ac179",
    { relay: wport(4760), feed: wport(4761), web: wport(5320) },
    { ENGINE_FAKE_TICK: "180" },
  );
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

const FOCUS_URL = /\/dm\/[^/]+\/[^/]+\/focus$/;

/** Open the app past first-run, landed on the auto-hired Default's DM. */
async function openDefault(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${stack.webUrl}/?roots=${ROOT}`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /Default/ })).toBeVisible({
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
    await aside.getByRole("button", { name: /Default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
}

/** Navigate to an employee's DM home from the sidebar. */
async function openEmployee(page: Page, name: RegExp | string) {
  await page.locator("aside").getByRole("button", { name }).click();
  await expect(page).toHaveURL(/\/dm\//);
}

const pickerButton = (page: Page) => page.locator('[data-ws="folder"]');

/** Pick `dir` for the next session (ac-114's flow: recents or Add folder). */
async function pickSessionFolder(page: Page, dir: string) {
  await pickerButton(page).click();
  const menu = page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
  const recent = menu.locator(`[data-wsfolder="${dir}"]`);
  if (
    await recent
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await recent.first().click();
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

const send = async (page: Page, text: string) => {
  const box = page.locator("main textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const turns = (page: Page) => page.locator("[data-agentturn]");
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });
const sessionRow = (page: Page) => page.locator("[data-session] button").last();

/** Wait until the newest turn is settled (its steps/stream markers clear). */
async function turnSettled(page: Page) {
  await expect(turns(page).last().locator("[data-turnsettled]")).toBeVisible({
    timeout: 90_000,
  });
  await expect(turns(page).locator("[data-streaming]")).toHaveCount(0, {
    timeout: 90_000,
  });
}

test("AC-1 a delegate turn shows one live row per helper; opening a row shows brief/steps/report; mid-turn reload replays the rows without duplicates", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefault(page);
  await pickSessionFolder(page, repoDir);
  await send(page, "delegate the relay scan to subagents");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });

  const block = page.locator("[data-subagents]").last();
  await expect(block).toBeVisible({ timeout: 60_000 });
  // First live row streams in — reload mid-turn right now.
  await expect(
    page.locator("[data-subagent][data-status='running']").first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-live.png` });
  await page.reload();
  const replayed = page.locator("[data-subagents]").last();
  await expect(replayed).toBeVisible({
    timeout: 60_000,
  });

  // The turn finishes: exactly one row per helper — two done, one failed.
  await expect(replayed.locator("[data-subagent]")).toHaveCount(3, {
    timeout: 60_000,
  });
  await expect(
    replayed.locator("[data-subagent][data-status='done']"),
  ).toHaveCount(2);
  await expect(
    replayed.locator("[data-subagent][data-status='failed']"),
  ).toHaveCount(1);
  await expect(
    page
      .locator("[data-subagents] .text-red-600")
      .filter({ hasText: /failed/ }),
  ).toBeVisible();
  // Durations render on finished rows.
  await expect(replayed.locator("[data-subagent]").first()).toContainText(
    /\d+s/,
  );

  // Opening a row shows its brief, its own steps and its report.
  const first = page.locator("[data-subagents] [data-subagent]").first();
  await first.click();
  await expect(first).toContainText("Brief ·");
  await expect(first).toContainText(/Searched|search_files/);
  await expect(first).toContainText(
    /Relay exports.*envelope shape over the wire/,
  );
  await page.screenshot({ path: `${SHOTS}/ac-1-done.png` });
  await turnSettled(page);
});

test("AC-2 a helper's file write counts in Workbench → Changes (same checkout)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openDefault(page);
  await sessionRow(page).click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });

  const changes = tab(page, /Changes/);
  await expect(changes).toBeVisible({ timeout: 30_000 });
  await changes.click();
  /* The "Draft the summary" helper wrote notes/summary.md into the session
     checkout during AC-1 — untracked rows list under Changes. */
  await expect(page.getByText("notes/summary.md").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-changes.png` });
});

test("AC-3 an employee-helper row shows their avatar + Open session into their DM", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefault(page);

  // Hire Reviewer (Use profile), then open its DM and send one message —
  // the engine links an employee-helper to their live session (D-#25).
  // A disabled row means the profile is already hired — skip straight to it.
  const reviewerAside = page
    .locator("aside")
    .getByRole("button", { name: "Reviewer" });
  if (!(await reviewerAside.isVisible().catch(() => false))) {
    await page
      .locator("aside")
      .getByRole("button", { name: "Add Employees" })
      .click();
    const dlg = page.locator("div.fixed.inset-0", {
      hasText: "Hire an employee",
    });
    await dlg.getByRole("button", { name: "Use profile" }).click();
    await page.screenshot({ path: `${SHOTS}/ac-3-hire-dialog.png` });
    const pickBtn = dlg.getByRole("button", { name: /reviewer/ }).first();
    await expect(pickBtn).toBeEnabled({ timeout: 15_000 });
    await pickBtn.click();
    await dlg
      .getByRole("button", { name: /Hire Reviewer/ })
      .dispatchEvent("click");
    await expect(reviewerAside).toBeVisible({ timeout: 30_000 });
  }
  await openEmployee(page, "Reviewer");
  await send(page, "wake up");
  await expect(page.locator("[data-agentturn]").last()).toBeVisible({
    timeout: 60_000,
  });
  await turnSettled(page);

  // Back on Default's open conversation, delegate with a @reviewer mention:
  // the third helper is reported as that employee's own helper.
  await openEmployee(page, /Default/);
  await sessionRow(page).click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  /* A mid-string @mention stays literal text in the outgoing message — the
     fake keys the employee-helper branch on `@<profile>`. (Leading the draft
     with it would leave the mention menu open on Enter.) */
  await send(page, "delegate the summary work to subagents; @reviewer helps");
  const block = page.locator("[data-subagents]").last();
  await expect(block).toBeVisible({ timeout: 60_000 });
  const helper = block
    .locator("[data-subagent]")
    .filter({ hasText: /Reviewer · Draft the summary/ });
  await expect(helper).toHaveCount(1, { timeout: 60_000 });
  await expect(
    block.locator("[data-subagent][data-status='done']"),
  ).toHaveCount(2, { timeout: 60_000 });
  await expect(
    block.locator("[data-subagent][data-status='failed']"),
  ).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/ac-3-employee-helper.png` });

  const open = helper.getByRole("button", { name: "Open session" });
  await expect(open).toBeVisible();
  await open.click();
  // Their own session in their DM — not a copy of the helper's work (D-#25).
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+$/, { timeout: 30_000 });
  await expect(page.locator("main").getByText("wake up").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-3-open-session.png` });
});

test("AC-4 a background process lists in Background with command/status/uptime/URL/tail; Stop ends it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefault(page);
  await sessionRow(page).click();
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await turnSettled(page);

  await send(page, "leave the dev server running in the background");
  const bg = tab(page, /Background/);
  // The tab appears as soon as the engine reports the job (within seconds).
  await expect(bg).toBeVisible({ timeout: 30_000 });
  await bg.click();

  const row = page.locator("[data-job]").first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("bun run dev");
  await expect(row).toContainText(/running/);
  await expect(row).toContainText(/up \d+[smh]/);
  // URL appears once the dev server's "Local:" line prints.
  await expect(row.getByRole("link", { name: /localhost:4173/ })).toBeVisible({
    timeout: 30_000,
  });
  // Expanding the row shows the live output tail.
  await row.getByRole("button").first().click();
  await expect(row).toContainText(/vite v7 ready|GET \/ 200/, {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-4-running.png` });

  // Stop ends it — the row reads "stopped by you".
  await row.getByRole("button", { name: "Stop" }).click();
  await expect(row).toContainText("stopped by you", { timeout: 30_000 });
  await expect(row).toHaveAttribute("data-status", "stopped");
  await page.screenshot({ path: `${SHOTS}/ac-4-stopped.png` });
  await turnSettled(page);
});

test("AC-5 no `background_jobs` capability → no Background tab and no Stop (D-#19)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stackB = await bootStack(
    "ac179nocaps",
    { relay: wport(4765), feed: wport(4766), web: wport(5325) },
    { LILOS_HIDE_CAPS: "background_jobs" },
  );
  try {
    await page.addInitScript(() =>
      localStorage.setItem("lilos-onboarded", "1"),
    );
    await page.goto(`${stackB.webUrl}/?roots=${ROOT}`);
    const aside = page.locator("aside");
    await expect(aside.getByRole("button", { name: /Default/ })).toBeVisible({
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
      await aside.getByRole("button", { name: /Default/i }).click();
    }
    await expect(page).toHaveURL(/\/dm\//);

    await send(page, "leave the dev server running in the background");
    await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
    await expect(turns(page).last().locator("[data-turnsettled]")).toBeVisible({
      timeout: 90_000,
    });
    // The engine emitted no job events and declared no capability: the tab
    // never renders and neither do job rows or a Stop control.
    await expect(tab(page, /Background/)).toHaveCount(0);
    await expect(page.locator("[data-job]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-5-no-capability.png` });
  } finally {
    await stackB.stop();
  }
});
