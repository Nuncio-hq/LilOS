import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { allowAllWhile, expectSettled } from "./helpers/approvals";
import { wport } from "./ports";

/**
 * Issue #320 — a turn's collapsible blocks open themselves while it runs,
   but only by DEFAULT: the user's first click wins for the rest of the turn.
   Collapsing the steps block mid-run keeps it collapsed while more steps
   land, the parked approval card still shows (it renders outside the block),
   and at turn end the block folds to "N steps" unless the user opened it. */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");
const SHOTS = path.join(repo, "test-results", "ac-320");

/* Each step card is itself a collapsible — the block's own trigger/panel are
   the FIRST matches inside [data-tasksteps]; when the block collapses every
   nested panel unmounts, so a plain count still proves closed. */
const PANEL = '[data-tasksteps] [data-slot="collapsible-content"]';
const TRIGGER = '[data-tasksteps] [data-slot="collapsible-trigger"]';

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
) {
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
      LILOS_USER_NAME: "Oscar",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    await waitForHttp(webUrl);
    await waitForHttp(`http://127.0.0.1:${ports.relay}/`);
    await waitForHttp(`http://127.0.0.1:${ports.feed}/`);
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

async function dmDefault(stack: { webUrl: string }, page: Page) {
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

test("AC-1/2/3 collapsing a running turn's steps stays collapsed; approval stays visible", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("collapse", {
    relay: wport(4663),
    feed: wport(4664),
    web: wport(5247),
  });
  try {
    await dmDefault(stack, page);
    // An edit-ask prompt parks the turn on an approval — deterministic
    // running state with a steps block auto-opened.
    await send(page, "Add a release note to the readme");
    const turn = page.locator("[data-agentturn]").last();
    await expect(turn.locator("[data-tasksteps]")).toBeVisible({
      timeout: 60_000,
    });
    // Auto-open as today: the steps panel is expanded while the turn runs.
    await expect(turn.locator(PANEL)).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/steps-autoopen.png` });

    // Click the header — it collapses even though the turn is still running.
    await turn.locator(TRIGGER).first().click();
    await expect(turn.locator(PANEL)).toHaveCount(0);
    // The collapsed header still shows the live state (running tool / pulse).
    await expect(turn.locator("[data-tasksteps]")).toContainText(/…|steps/);

    // AC-2: the parked approval renders outside the collapsed block — it's
    // visible and answerable while the steps stay folded.
    await expect(page.getByText("Approval needed").first()).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: `${SHOTS}/collapsed-approval-visible.png` });

    // Keep answering approvals until the turn settles; the whole time the
    // block must stay collapsed (new steps must not re-open it).
    const staysCollapsed = (async () => {
      for (;;) {
        const settled = await turn.locator("[data-turnsettled]").count();
        if (settled > 0) return;
        const open = await turn.locator(PANEL).count();
        if (open > 0)
          throw new Error("steps block re-opened while the turn ran");
        await page.waitForTimeout(150);
      }
    })();
    await allowAllWhile(page, staysCollapsed);
    await expectSettled(turn);
    // More than one step landed while it was collapsed, and at turn end it
    // folded to "N steps" (the user never re-opened it).
    await expect(turn.locator("[data-tasksteps]")).toContainText(/\d+ steps?/);
    await expect(turn.locator(PANEL)).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/settled-collapsed.png` });

    // The block still toggles normally afterwards.
    await turn.locator(TRIGGER).first().click();
    await expect(turn.locator(PANEL)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/settled-reopened.png` });
  } finally {
    await stack.stop();
  }
});
