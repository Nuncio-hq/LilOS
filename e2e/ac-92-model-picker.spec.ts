import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";

/**
 * Issue #92 — model picker v2 in the REAL app (apps/web over relay + harness
 * on engine-fake; the prototype spec ac-30 covers the mock stack). Each
 * acceptance criterion is a named test. The fake catalog is
 * Fake Small (no dial) / Fake Large (3 stops + fast, the default) /
 * Fake Reasoning (7-stop ladder + fast) / Fake Opus 2 (a "/" id) /
 * Fake Fresh (only via `models.list {refresh:true}`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const WORKER = Number(process.env.TEST_WORKER_INDEX ?? "0");
const wport = (p: number) => p + WORKER * 100;
const webDir = path.join(repo, "apps", "web");

interface Stack {
  home: string;
  webUrl: string;
  stop: () => Promise<void>;
}

async function waitForHttp(url: string, ms = 120_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    // A wedged fetch (accepted socket, starved handler) hangs the loop for
    // the whole budget otherwise — cap each attempt so retries stay cheap.
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
  home?: string,
): Promise<Stack> {
  const homeDir = home ?? mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
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
    // The relay writes its token asynchronously — wait so no client 401s.
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

const SHOTS = path.join(repo, "test-results", "ac-92");

let stackA: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stackA = await bootStack("picker", {
    relay: wport(4743),
    feed: wport(4747),
    web: wport(5341),
  });
});
test.afterAll(async () => {
  await stackA?.stop();
});

test.describe.configure({ mode: "serial" });
// The pick → next-turn footer flow is the AC-4 evidence the PR needs on film.
test.use({ video: "on" });

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

/** Open the app, land on Default's DM home (dismissing the first-run card). */
async function dmDefault(stack: Stack, page: Page) {
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

const triggers = (page: Page) =>
  page.locator('[data-slot="model-picker-trigger"]');

/** Open a trigger's popover and drill into the searchable model list. */
async function openModelList(page: Page, which: "first" | "last") {
  await triggers(page)[which]().click();
  await page.getByRole("button", { name: /Model$/ }).click();
}

const option = (page: Page, name: string) =>
  page.locator("[cmdk-item]", { hasText: name });

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

test("AC-1 + AC-5 the new-session composer starts on the employee default and lists every engine model grouped by provider", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await dmDefault(stackA, page);
  const home = triggers(page).first();
  // The employee default (fake-large) — never a sticky last-used pick.
  await expect(home).toContainText("Fake Large");
  await expect(home).toContainText("Medium");
  await home.click();
  await page.getByRole("button", { name: /Model$/ }).click();
  // Every model the engine reports, under its provider group.
  const group = page.getByRole("group", { name: "Fake" });
  await expect(group).toBeVisible();
  for (const name of [
    "Fake Small",
    "Fake Large",
    "Fake Reasoning",
    "Fake Opus 2",
  ])
    await expect(option(page, name)).toHaveCount(1);
  // The refresh-only model is NOT listed until the engine is asked.
  await expect(option(page, "Fake Fresh")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-1-catalog.png` });
  expect(errors).toEqual([]);
});

test("AC-2 the slider has exactly the picked model's stops; no ticks; Faster/Smarter ends", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await dmDefault(stackA, page);
  await triggers(page).first().click();
  const slider = page.getByRole("slider", { name: "Reasoning effort" });
  // fake-large: efforts [low, medium, high] → slider 0..2.
  await expect(slider).toHaveAttribute("max", "2");
  await expect(page.getByText("Faster", { exact: true })).toBeVisible();
  await expect(page.getByText("Smarter", { exact: true })).toBeVisible();
  // No per-level tick buttons — drag/arrow only.
  await expect(page.getByRole("button", { name: "High" })).toHaveCount(0);
  await page.getByRole("button", { name: /Model$/ }).click();
  // Fake Reasoning reports the full ladder (7 stops).
  await option(page, "Fake Reasoning").click();
  await expect(slider).toHaveAttribute("max", "6");
  // A model without reasoning control shows no slider.
  await page.getByRole("button", { name: /Model$/ }).click();
  await option(page, "Fake Small").click();
  await expect(
    page.getByText("This model has no reasoning control."),
  ).toBeVisible();
  await expect(slider).toHaveCount(0);
  // …nor a fast toggle (Fake Small reports no fast tier).
  await expect(page.getByRole("button", { name: "Fast mode" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-2-no-dial.png` });
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("AC-3 + AC-4 the next turn runs the picked model + effort + fast; the footer shows them; a mid-turn pick applies next turn", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  await dmDefault(stackA, page);
  // Park the first turn on an approval — provably running while we repick.
  await send(page, "Add a release note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  // A pick while running never errors and applies to the NEXT turn.
  await openModelList(page, "last");
  await option(page, "Fake Reasoning").click();
  await page.getByRole("button", { name: "Fast mode" }).click();
  const slider = page.getByRole("slider", { name: "Reasoning effort" });
  await slider.press("ArrowUp"); // medium → high
  await page.keyboard.press("Escape");
  // Approve the pending ask so the parked turn can finish.
  for (let i = 0; i < 6; i++) {
    const b = page.getByRole("button", { name: "Allow once" });
    if (
      !(await b
        .first()
        .isVisible()
        .catch(() => false))
    )
      break;
    await b.first().click();
    await page.waitForTimeout(400);
  }
  const turn = page.locator("[data-agentturn]").last();
  await expect(turn).toContainText(/Done on|Review it/, { timeout: 90_000 });
  // The running turn still reports the model it STARTED on — the pick
  // applies from the next turn.
  await expect(turn).toContainText("Fake Large", { timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-midturn-pick.png` });

  // The NEXT turn runs the pick — footer = engine turn.started truth.
  await send(page, "what changed?");
  await expect(
    page
      .locator("[data-agentturn]")
      .last()
      .getByText("· Fake Reasoning · High · Fast"),
  ).toBeVisible({ timeout: 90_000 });
  await expect(triggers(page).last()).toContainText("Fake Reasoning");
  await page.screenshot({ path: `${SHOTS}/ac-4-footer.png` });

  // AC-8: a "/" id round-trips verbatim — the footer resolves Fake Opus 2
  // from the catalog (the raw id never gets re-split into provider/model).
  // The High effort is kept across the switch (opus-2 reports it too), and
  // Fast drops because opus-2 has no fast tier.
  await openModelList(page, "last");
  await option(page, "Fake Opus 2").click();
  await page.keyboard.press("Escape");
  await expect(triggers(page).last()).toContainText("Fake Opus 2");
  await send(page, "one more thing");
  await expect(
    page.locator("[data-agentturn]").last().getByText("· Fake Opus 2 · High"),
  ).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: `${SHOTS}/ac-8-slash-id.png` });
  expect(errors).toEqual([]);
});

test("AC-6 + AC-7 Refresh surfaces a new model without restart; Edit models' ONE hide list survives a relay restart; new models default to visible", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  await dmDefault(stackA, page);
  await openModelList(page, "first");
  // Refresh renders only because the engine declares it; the click re-lists.
  await page.getByRole("option", { name: /Refresh models/ }).click();
  await expect(option(page, "Fake Fresh")).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/ac-6-refresh.png` });

  // Edit models: the provider row hides the whole group…
  await page.getByRole("option", { name: /Edit models/ }).click();
  const dialog = page.getByRole("dialog", { name: "Models" });
  await dialog.getByRole("checkbox", { name: /Show all Fake/ }).click();
  await page.keyboard.press("Escape");
  await openModelList(page, "first");
  // Every non-selected model leaves the list; the current pick stays visible
  // so the picker never yanks the selection out from under a session on it.
  await expect(option(page, "Fake Small")).toHaveCount(0);
  await expect(option(page, "Fake Reasoning")).toHaveCount(0);
  await expect(option(page, "Fake Large")).toHaveCount(1);
  // …and re-showing it restores every model (tri-state back to all-on).
  await page.getByRole("option", { name: /Edit models/ }).click();
  await dialog.getByRole("checkbox", { name: /Show all Fake/ }).click();
  await expect(dialog.getByText("5/5")).toBeVisible();
  // Then hide ONE model — Fake Reasoning leaves the list, the others stay.
  await dialog.getByRole("switch", { name: /Show Fake Reasoning/ }).click();
  await page.keyboard.press("Escape");
  await openModelList(page, "first");
  await expect(option(page, "Fake Reasoning")).toHaveCount(0);
  await expect(option(page, "Fake Large")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${SHOTS}/ac-7-hidden.png` });

  // The ONE LilOS list lives in the relay's sqlite — it survives a full
  // stack restart on the same LILOS_HOME.
  const stackB = await bootStack(
    "picker-restart",
    { relay: wport(4753), feed: wport(4754), web: wport(5345) },
    stackA.home,
  );
  try {
    await dmDefault(stackB, page);
    await openModelList(page, "first");
    await expect(option(page, "Fake Reasoning")).toHaveCount(0);
    // A model the engine adds AFTER the last edit is visible by default.
    await page.getByRole("option", { name: /Refresh models/ }).click();
    await expect(option(page, "Fake Fresh")).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/ac-7-restart.png` });
  } finally {
    await stackB.stop();
  }
  expect(errors).toEqual([]);
});
