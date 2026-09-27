import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";

/**
 * Issue #104 — DM composer keys: Esc stops the running turn through the same
 * `onStop` the Stop button calls (AC-1…AC-4, AC-6 against the real app +
 * engine-fake, stack booted like ac-27-dm.spec.ts); ↑ in an empty composer
 * recalls the last sent message (AC-5); the prototype shows the same
 * behaviour (AC-7, shared dev server). An edit-ask prompt parks the turn on
 * an approval card = a deterministic running state to press Esc on.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
// --repeat-each spreads a file's repeats across worker processes; each boots
// the stack again, so ports are offset per worker or relays race one port (#84).
const WORKER = Number(process.env.TEST_WORKER_INDEX ?? "0");
const wport = (p: number) => p + WORKER * 100;

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

/** Boot `bun run dev` (relay + harness + vite dev) on offset ports. */
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
  try {
    await waitForHttp(webUrl);
    // The page connects to relay + feed the moment it loads and only retries
    // post-handshake drops — wait for them to listen so a slow boot under
    // parallel load can't strand the client on "could not start".
    await waitForHttp(`http://127.0.0.1:${ports.relay}/`);
    await waitForHttp(`http://127.0.0.1:${ports.feed}/`);
    const tokenPath = path.join(home, "relay-token");
    let relayToken = "";
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

const SHOTS = path.join(repo, "test-results", "ac-104");

let stackA: Stack; // engine-fake advertising every capability (incl. steer)
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stackA = await bootStack("keys", {
    relay: wport(4680),
    feed: wport(4681),
    web: wport(5281),
  });
});
test.afterAll(async () => {
  await stackA?.stop();
});

test.describe.configure({ mode: "serial" });

/** Open the app, land on Default's DM (dismissing the first-run card). */
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

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const employeeIdFromUrl = (page: Page) =>
  decodeURIComponent(page.url().split("/dm/")[1].split("/")[0]);

const STOPPED = "Stopped · session.interrupt";
const RUNNING_HINT = "Enter steers · ■ stop";

test("AC-1 Esc in the thread composer stops the running turn — same as Stop", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  await send(page, "Add a release note to the readme");
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({ timeout: 30_000 });
  const box = page.locator("textarea").last();
  await box.click();
  await page.keyboard.press("Escape");
  await expect(page.getByText(STOPPED)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-esc-stopped.png` });
});

test("AC-2 Esc with no turn running does nothing (no Stop → no Esc stop)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  // No session yet: the home composer never gets onStop — Esc is inert.
  const home = page.locator("textarea").first();
  await home.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await expect(page.getByText(STOPPED)).toHaveCount(0);

  // A finished turn: running is false → dm.tsx passes no onStop → Esc inert.
  await send(page, "Say hello then list files");
  await expect(page.getByPlaceholder(/in this session/)).toBeVisible({
    timeout: 90_000,
  });
  const box = page.locator("textarea").last();
  await box.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await expect(page.getByText(STOPPED)).toHaveCount(0);
  await expect(box).toBeFocused();
});

test("AC-3 Esc closes an open popover/dialog first — the turn keeps running", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  await send(page, "Add a release note to the readme");
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({ timeout: 30_000 });

  // Model-picker popover: Esc closes it without touching the turn.
  await page.locator('[data-slot="model-picker-trigger"]').last().click();
  await expect(
    page.locator('[data-slot="popover-content"][data-open]'),
  ).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="popover-content"][data-open]'),
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(RUNNING_HINT)).toBeVisible();
  await expect(page.getByText(STOPPED)).toHaveCount(0);

  // Status dialog: Esc inside it closes only the dialog.
  await page.getByRole("button", { name: "System status" }).click();
  const dialog = page.getByRole("dialog", { name: "System status" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(RUNNING_HINT)).toBeVisible();
  await expect(page.getByText(STOPPED)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-3-overlays.png` });
});

test("AC-4 Esc with a steer draft typed still stops the turn and keeps the text", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  await send(page, "Add a release note to the readme");
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({ timeout: 30_000 });
  const box = page.locator("textarea").last();
  await box.fill("also mention bananas");
  await page.keyboard.press("Escape");
  await expect(page.getByText(STOPPED)).toBeVisible({ timeout: 30_000 });
  await expect(box).toHaveValue("also mention bananas");
  await page.screenshot({ path: `${SHOTS}/ac-4-stopped-keeps-draft.png` });
});

test("AC-5 ↑ recalls the last sent message — thread, then home composer", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(stackA, page);
  await send(page, "first root: pick a color");
  await expect(page.getByText("first root: pick a color").first()).toBeVisible({
    timeout: 30_000,
  });
  /* The root preview lands in the home feed before the send's async navigate
     commits — wait for the thread URL so the next send hits the thread
     composer, not a second top-level message (same race as ac-28, #103). */
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_/, { timeout: 10_000 });
  // ↑ recall reads the last message Oscar SENT — it must not depend on
  // whether the running turn has finished (a steer counts too).
  await send(page, "second reply: make it blue");
  await expect(
    page.getByText("second reply: make it blue").first(),
  ).toBeVisible({ timeout: 30_000 });

  // Thread composer: ↑ fills with the last reply Oscar sent, caret at end.
  const box = page.locator("textarea").last();
  await box.click();
  await page.keyboard.press("ArrowUp");
  await expect(box).toHaveValue("second reply: make it blue");
  const caret = await box.evaluate(
    (el: HTMLTextAreaElement) => el.selectionStart,
  );
  expect(caret).toBe("second reply: make it blue".length);
  await page.screenshot({ path: `${SHOTS}/ac-5-recalled.png` });

  // ↑ with a draft is the usual caret move — text is never replaced.
  await box.fill("draft in progress");
  await box.press("ArrowUp");
  await expect(box).toHaveValue("draft in progress");

  // Home composer recalls the last TOP-LEVEL message = this session's root.
  await page.goto(`${stackA.webUrl}/dm/${employeeIdFromUrl(page)}`);
  const home = page.locator("textarea").first();
  await home.click();
  await page.keyboard.press("ArrowUp");
  await expect(home).toHaveValue("first root: pick a color");
  await page.screenshot({ path: `${SHOTS}/ac-5-home-recalled.png` });
});

test("AC-6 the Stop button's label mentions Esc", async ({ page }) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  await send(page, "Add a release note to the readme");
  const stop = page.getByRole("button", { name: /stop/i });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(stop).toHaveAttribute("aria-label", /Esc/);
  await expect(stop).toHaveAttribute("title", /Esc/);
});

/* ---- AC-7: the prototype (UI source of truth) shows the same behaviour ---- */

async function sendProtoDM(page: Page, text: string) {
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  const box = page.getByPlaceholder(/New session with Builder/);
  await box.fill(text);
  await box.press("Enter");
}

test("AC-7 prototype: Esc stops the turn; ↑ recalls; Esc closes the @ menu", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await sendProtoDM(page, "Check the relay reconnect plan");
  const steer = page.getByPlaceholder(/is working\. Enter steers this turn/);
  await expect(steer).toBeVisible({ timeout: 15_000 });

  // A mid-turn send lands in the steer buffer, not the replies — ↑ must still
  // recall it (parity with the real app, where the steer IS a user message).
  await steer.fill("also the flaky e2e retry counts");
  await steer.press("Enter");
  await expect(page.locator('[data-steerstate="pending"]').first()).toBeVisible(
    { timeout: 10_000 },
  );
  await steer.click();
  await page.keyboard.press("ArrowUp");
  await expect(steer).toHaveValue("also the flaky e2e retry counts");

  // Esc stops the turn (same as ■) and keeps the recalled draft.
  await page.keyboard.press("Escape");
  await expect(page.getByText(STOPPED).first()).toBeVisible({
    timeout: 15_000,
  });
  const box = page.getByPlaceholder(/Reply to Builder/);
  await expect(box).toHaveValue("also the flaky e2e retry counts");
  await page.screenshot({ path: `${SHOTS}/ac-7-prototype.png` });

  // A fresh send after the stop is the newest message — ↑ recalls it now.
  await box.fill("a second, plain message");
  await box.press("Enter");
  await expect(page.getByText("a second, plain message").first()).toBeVisible({
    timeout: 15_000,
  });
  const composer = page.locator("textarea").last();
  await composer.click();
  await page.keyboard.press("ArrowUp");
  await expect(composer).toHaveValue("a second, plain message");

  // The `@` employee menu in the channel composer: Esc closes it first.
  await page.goto("/");
  const chan = page.getByPlaceholder(/Message #engineering/);
  await chan.fill("@");
  const menu = page.getByRole("listbox", { name: "Mention an employee" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
