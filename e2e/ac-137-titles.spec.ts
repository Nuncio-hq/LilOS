import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";

/**
 * Issue #137 — sessions name themselves: a placeholder from the first
 * message, then the engine's derived title, then its small-model (llm)
 * title — and a user rename always wins over a late engine title.
 * Runs the real stack (relay + harness + vite, engine-fake).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");
const SHOTS = path.join(repo, "test-results", "ac-137");

const WORKER = Number(process.env.TEST_WORKER_INDEX ?? "0");
const wport = (p: number) => p + WORKER * 100;
const PORTS = { relay: wport(4760), feed: wport(4761), web: wport(5360) };

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

let stack: { home: string; webUrl: string; proc: ChildProcess };
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const home = mkdtempSync(path.join(tmpdir(), "lilos-e2e-137-"));
  const leakTag = engineTag("ac137");
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
  stack = { home, webUrl: `http://127.0.0.1:${PORTS.web}`, proc };
  try {
    await waitForHttp(stack.webUrl);
    await waitForHttp(`http://127.0.0.1:${PORTS.relay}/`);
    await waitForHttp(`http://127.0.0.1:${PORTS.feed}/`);
  } catch (e) {
    await killProc(proc);
    throw e;
  }
});
test.afterAll(async () => {
  if (stack?.proc) {
    await killProc(stack.proc);
    await expectNoEngineLeak(engineTag("ac137"));
  }
});
test.describe.configure({ mode: "serial" });
test.use({ trace: "retain-on-failure" });

async function dmDefault(page: Page) {
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

/** The open thread's header title. */
const headerTitle = (page: Page) => page.locator("[data-session-title]");

/** Stage ordering: placeholder < derived < llm — titles must never regress.
    The prompt avoids edit-verbs so engine-fake runs a clean read turn. */
const STAGE = [
  "Explain the whole repository layout in…", // placeholder: first 6 words + …
  "Explain the whole repository layout in detail p…", // derived: ≤48 chars
  "Explain The Whole Repository Layout In Detail Please", // llm upgrade
] as const;
const PROMPT = "Explain the whole repository layout in detail please";

test("AC-3/AC-4 placeholder then engine titles land live in header, list, search", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await send(page, PROMPT);
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_/, { timeout: 10_000 });

  /* AC-4 "≤1 visible flicker placeholder → derived → llm": poll the header
     title and assert the observed stages only ever move forward. */
  const seen: string[] = [];
  const deadline = Date.now() + 60_000;
  for (;;) {
    const t =
      (await headerTitle(page)
        .textContent()
        .catch(() => "")) ?? "";
    if (t && seen.at(-1) !== t) seen.push(t);
    if (t === STAGE[2]) break;
    if (Date.now() > deadline)
      throw new Error(`title never reached the llm stage; trace: ${seen}`);
    await page.waitForTimeout(80);
  }
  const stages = seen.map((t) => STAGE.indexOf(t as (typeof STAGE)[number]));
  for (const t of seen) {
    expect(
      STAGE.includes(t as (typeof STAGE)[number]),
      `unexpected title "${t}" in trace ${seen}`,
    ).toBe(true);
  }
  for (let i = 1; i < stages.length; i++) {
    expect(stages[i], `title regressed: ${seen}`).toBeGreaterThan(
      stages[i - 1],
    );
  }
  expect(seen.at(-1)).toBe(STAGE[2]);
  await page.screenshot({ path: `${SHOTS}/ac34-header-llm-title.png` });

  // AC-4: the session list row + title search show the engine title.
  await page.goBack();
  await expect(page).toHaveURL(/\/dm\/[^/]+$/, { timeout: 10_000 });
  const row = page.getByText(STAGE[2]).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder("Filter sessions").fill("Detail Please");
  await expect(row).toBeVisible();
  await page.getByPlaceholder("Filter sessions").fill("zzz-no-match");
  await expect(row).toBeHidden();
  await page.getByPlaceholder("Filter sessions").fill("");
  await page.screenshot({ path: `${SHOTS}/ac34-list-auto-title.png` });
});

test("AC-2 a mid-turn rename survives the late llm title", async ({ page }) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  /* "Add a footer" parks on an approval ask mid-turn: the derived title has
     landed but the llm title is still owed — a deterministic race window. */
  await send(page, "Add a footer to the page");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_/, { timeout: 10_000 });
  await expect(
    page.getByRole("button", { name: "Allow once" }).first(),
  ).toBeVisible({ timeout: 60_000 });

  // Back to the session list; rename the running session.
  await page.goBack();
  const row = page.locator("div[data-session]", {
    hasText: "Add a footer to the page",
  });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Rename session" }).click();
  const input = page.getByLabel("Session title");
  await input.fill("My footer session");
  await input.press("Enter");
  await expect(
    page.locator("div[data-session]", { hasText: "My footer session" }),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac2-renamed-mid-turn.png` });

  // Finish the turn: the canned flow asks more than once — keep answering
  // "Allow once" until it completes; the llm title must not overwrite the
  // rename.
  await row.getByRole("button", { name: /\d+ repl(y|ies)/ }).click();
  const doneOn = page.locator("main").getByText("Done on").first();
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await doneOn.isVisible().catch(() => false)) break;
    const allow = page.getByRole("button", { name: "Allow once" }).first();
    if (await allow.isVisible().catch(() => false)) await allow.click();
    if (Date.now() > deadline)
      throw new Error("turn never completed after answering approvals");
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1_500); // settle window for the late title write
  await expect(headerTitle(page)).toHaveText("My footer session");

  // Reload → reconnect replays the engine title; the rename still stands.
  await page.reload();
  await expect(headerTitle(page)).toHaveText("My footer session", {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac2-rename-kept.png` });
});
