import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { wport } from "./ports";

/**
 * Issue #106 — approval modes per conversation, real app (apps/web over
 * relay + harness on engine-fake). AC-1 the composer pill switches Ask ↔
 * Full access from the agent's next action (mid-turn included); AC-2 Full
 * access is enforced by the harness (no card ever reaches the user, the
 * turn logs "Auto-approved"); AC-3 new conversations start on Settings'
 * default and never remember the last-used level; AC-4 cards offer
 * Once / This session / Always / Deny; AC-9 the Settings Approvals copy
 * says what the level gates.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");

interface Stack {
  home: string;
  webUrl: string;
  stop: () => Promise<void>;
}

async function waitForHttp(url: string, ms = 120_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(5_000) })
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
  const homeDir = mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const leakTag = engineTag(tag);
  const proc = spawn("bun", ["run", "dev"], {
    cwd: webDir,
    detached: true,
    env: {
      ...process.env,
      LILOS_HOME: homeDir,
      LILOS_ENGINE_TAG: leakTag,
      LILOS_RELAY_PORT: String(ports.relay),
      LILOS_FEED_PORT: String(ports.feed),
      LILOS_WEB_PORT: String(ports.web),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    await waitForHttp(webUrl);
    await waitForHttp(`http://127.0.0.1:${ports.relay}/`);
    await waitForHttp(`http://127.0.0.1:${ports.feed}/`);
    const tokenPath = path.join(homeDir, "relay-token");
    for (let i = 0; i < 300; i++) {
      try {
        if (readFileSync(tokenPath, "utf8").trim()) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      home: homeDir,
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

const SHOTS = path.join(repo, "test-results", "ac-106");
const pill = (page: Page) => page.locator('[data-slot="access-pill"]');
const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]');
const settled = (page: Page) => page.locator("[data-turnsettled]").last();

/** Land on the DM home composer of the seeded employee. */
async function dmHome(stack: Stack, page: Page) {
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

const settingsDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Settings" });

test.describe.configure({ mode: "serial" });
test.use({ video: "on" });

test("AC-1+AC-2+AC-4+AC-3 the pill drives the mode; cards offer the four options; defaults don't leak", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const stack = await bootStack("ac106", {
    relay: wport(4906),
    feed: wport(4907),
    web: wport(5406),
  });
  try {
    /* ── New conversation starts on Ask (the factory default) ── */
    await dmHome(stack, page);
    await expect(pill(page)).toBeVisible();
    await expect(pill(page)).toHaveAttribute("data-access", "ask");
    await expect(pill(page)).toContainText("Ask");

    /* ── One click → Full access: orange shield + label, no dialog ── */
    await pill(page).click();
    await expect(pill(page)).toHaveAttribute("data-access", "full");
    await expect(pill(page)).toContainText("Full access");
    await expect(pill(page)).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: `${SHOTS}/ac-1-pill-full.png` });

    /* ── Full access: the gated turn completes with no card at all ── */
    await send(page, "Add a footer to the page");
    await expect(settled(page)).toBeVisible({ timeout: 90_000 });
    await expect(openCard(page)).toHaveCount(0);
    await expect(page.getByText(/Auto-approved/).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-2-auto-approved.png` });

    /* ── The thread's own pill persisted Full access; switch back to Ask ── */
    await expect(pill(page)).toHaveAttribute("data-access", "full");
    await pill(page).click();
    await expect(pill(page)).toHaveAttribute("data-access", "ask");

    /* ── Ask: the card offers Once / This session / Always / Deny ── */
    await send(page, "Change the header color");
    const card = openCard(page).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    for (const name of ["Once", "This session", "Always", "Deny"]) {
      await expect(
        card.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    await page.screenshot({ path: `${SHOTS}/ac-4-four-options.png` });

    /* ── AC-1 mid-turn: flip to Full while the card is open — the NEXT
       approval never becomes a card. */
    await pill(page).click();
    await expect(pill(page)).toHaveAttribute("data-access", "full");
    await card.getByRole("button", { name: "Once", exact: true }).click();
    await expect(settled(page)).toBeVisible({ timeout: 90_000 });
    // Only that one card ever opened for this turn's other gated steps.
    await expect(openCard(page)).toHaveCount(0);
    await expect(page.getByText(/Auto-approved/).first()).toBeVisible();

    /* ── AC-3: a fresh conversation doesn't inherit the last-used level ── */
    await dmHome(stack, page);
    await expect(pill(page)).toHaveAttribute("data-access", "ask");
    await expect(pill(page)).toContainText("Ask");
  } finally {
    await stack.stop();
  }
});

test("AC-3+AC-9 Settings Approvals: policy pick, honest copy, and the default seeds new conversations", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("ac106s", {
    relay: wport(4916),
    feed: wport(4917),
    web: wport(5416),
  });
  try {
    await dmHome(stack, page);
    await page
      .locator("aside")
      .getByRole("button", { name: "Settings" })
      .click();
    await expect(settingsDialog(page)).toBeVisible();
    await settingsDialog(page)
      .getByRole("tab", { name: "Approvals", exact: true })
      .click();

    /* The engine declares approval_policy → the policy pick renders. */
    const policy = settingsDialog(page).getByRole("radiogroup", {
      name: "Engine approval policy",
    });
    await expect(policy).toBeVisible();
    for (const name of ["Smart", "Manual", "Off"])
      await expect(
        policy.getByRole("radio", { name, exact: true }),
      ).toBeVisible();

    /* AC-9: the access default names what it gates — no sandbox promise. */
    await expect(
      settingsDialog(page).getByText(/asks before risky commands/),
    ).toBeVisible();
    await expect(
      settingsDialog(page).getByText(/never stops to ask/),
    ).toBeVisible();
    await expect(
      settingsDialog(page).getByText(/outside its folder|works anywhere/i),
    ).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-9-settings.png` });

    /* Default → Full access seeds the NEXT new conversation only. */
    await settingsDialog(page)
      .getByRole("radiogroup", { name: "Default access for new conversations" })
      .getByRole("radio", { name: "Full access", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await dmHome(stack, page);
    await expect(pill(page)).toHaveAttribute("data-access", "full");

    /* …and switching the engine policy lands on the engine (fake records it). */
    await page
      .locator("aside")
      .getByRole("button", { name: "Settings" })
      .click();
    await settingsDialog(page)
      .getByRole("tab", { name: "Approvals", exact: true })
      .click();
    await settingsDialog(page)
      .getByRole("radiogroup", { name: "Engine approval policy" })
      .getByRole("radio", { name: "Manual", exact: true })
      .click();
    await expect(
      settingsDialog(page)
        .getByRole("radiogroup", { name: "Engine approval policy" })
        .getByRole("radio", { name: "Manual", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
  } finally {
    await stack.stop();
  }
});
