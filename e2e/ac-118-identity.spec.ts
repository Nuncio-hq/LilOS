import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { wport } from "./ports";

/**
 * Issue #118 — the user's name, company name and avatar colour are
 * relay-owned domain data (profile.get / profile.update), not hardcoded.
 * AC-1: a name set at first run is stored in the relay's sqlite and every
 * surface shows it. AC-2: the fields fold into the existing first-run card,
 * prefilled from the OS user's full name ("<First>'s Co"), first run stays
 * at 3 steps or fewer. AC-4: an existing install (onboarded, nothing stored)
 * shows the same prefilled identity without re-running first run.
 * (Settings editing is #132 — out of this slice.)
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";

const webDir = path.join(repo, "apps", "web");

interface Stack {
  home: string;
  webUrl: string;
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
    await waitForHttp(webUrl);
    await waitForHttp(`http://127.0.0.1:${ports.relay}`);
    return {
      home,
      webUrl,
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

const SHOTS = path.join(repo, "test-results", "ac-118");

/** Read the relay-owned profile straight out of sqlite — AC-1 evidence that
   the identity is domain data, not page state. */
function storedSettings(home: string): Record<string, string> {
  const out = spawnSync(
    BUN,
    [
      "-e",
      `const db = new (await import("bun:sqlite")).Database(${JSON.stringify(
        path.join(home, "relay.sqlite"),
      )});
       console.log(JSON.stringify(db.query("SELECT user_name, company_name, avatar_color FROM profile WHERE id = 1").get() ?? {}));`,
    ],
    { encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error(`sqlite read failed: ${out.stderr}`);
  return JSON.parse(out.stdout.trim() || "{}") as Record<string, string>;
}

const sidebarHeader = (page: Page) => page.locator("aside > div").first();

test.describe.configure({ mode: "serial" });

test("AC-2 first run folds name+company into the card, prefilled; AC-1 the choice is stored and shown", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await bootStack(
    "ac118a",
    { relay: wport(4670), feed: wport(4671), web: wport(5336) },
    { LILOS_USER_NAME: "Test User" },
  );
  try {
    await page.goto(`${stack.webUrl}/`);
    const card = page.locator("[data-first-run]");
    await expect(card).toBeVisible({ timeout: 30_000 });

    // The identity fields sit on the same card as the checklist — folded
    // into the existing step, no extra screen (AC-2: 3 steps or fewer).
    expect(
      await card.locator("[data-first-run-step]").count(),
    ).toBeLessThanOrEqual(3);
    const nameInput = card.getByLabel("Your name");
    const companyInput = card.getByLabel("Company name");
    await expect(nameInput).toHaveValue("Test User", { timeout: 30_000 });
    await expect(companyInput).toHaveValue("Test's Co");
    await page.screenshot({ path: `${SHOTS}/ac-2-first-run-prefilled.png` });

    await nameInput.fill("Ada");
    await companyInput.fill("Ada Labs");
    await card.getByRole("button", { name: /open dm/i }).click();
    await expect(page).toHaveURL(/\/dm\//);

    // Every surface renders the stored identity (AC-1).
    await expect(sidebarHeader(page)).toContainText("Ada Labs");
    await expect(page.locator("aside")).toContainText("Ada");
    const box = page.locator("textarea").last();
    await box.fill("hello identity");
    await box.press("Enter");
    // Sending opens the session in Focus (#114); Back lands on the feed where
    // the row renders.
    await page.getByRole("button", { name: "Back to DM" }).click();
    const ownRow = page
      .locator("div.group.grid")
      .filter({ hasText: "hello identity" })
      .last();
    await expect(ownRow).toContainText("Ada", { timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/ac-1-surfaces.png` });

    // And it is actually relay-owned: sqlite carries the row.
    await expect
      .poll(() => storedSettings(stack.home), { timeout: 10_000 })
      .toEqual({
        user_name: "Ada",
        company_name: "Ada Labs",
        avatar_color: "bg-blue-600",
      });
  } finally {
    await stack.stop();
  }
});

test("AC-4 an existing install without stored values shows the prefilled identity", async ({
  page,
}) => {
  const stack = await bootStack(
    "ac118b",
    { relay: wport(4674), feed: wport(4675), web: wport(5337) },
    { LILOS_USER_NAME: "Test User" },
  );
  try {
    await page.addInitScript(() =>
      localStorage.setItem("lilos-onboarded", "1"),
    );
    await page.goto(`${stack.webUrl}/`);
    // Onboarded → straight into the DM, no first-run card.
    await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
    await expect(page.locator("[data-first-run]")).toHaveCount(0);
    await expect(sidebarHeader(page)).toContainText("Test's Co");
    await expect(page.locator("aside")).toContainText("Test User");
    await page.screenshot({ path: `${SHOTS}/ac-4-existing-install.png` });
  } finally {
    await stack.stop();
  }
});
