import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { bootStack } from "./helpers/stack";
import { wport } from "./ports";

/**
 * Issue #80 — DM identity + streaming markdown. AC-1 asserts the user's
 * message avatar IS the sidebar footer's avatar (same initial, same computed
 * colour — never the anonymous grey "Y"). AC-2 asserts markdown renders
 * mid-stream (the prompt's `slow:` directive stretches its own text
 * phase so the stream is observable — #432; no stack-wide tick). AC-3
 * captures both in the Electron desktop app.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
// --repeat-each spreads a file's repeats across worker processes; each boots
// the stack again, so ports are offset per worker or relays race one port (#84).

const desktopDir = path.join(repo, "apps", "desktop");

const SHOTS = path.join(repo, "test-results", "ac-80");
/* AC-1 never gates on a running turn — its prompt runs at the engine tick. */
const PROMPT = "What does the replay contract carry?"; // hits the default script
/* `slow:75` paces only this turn (~4 s) — the mid-stream window AC-2's
   markdown asserts need; the streaming block is live whenever they look. */
const STREAM_PROMPT = `slow:75 ${PROMPT}`;
/* AC-3 asserts mid-stream markdown after reopening the session — its send
   needs the longer ~8 s window to still be streaming then (#432). */
const STREAM_PROMPT_DESKTOP = `slow:150 ${PROMPT}`;

/* The footer's me-row: the aside's last child, its avatar fallback. */
const footerAvatar = (page: Page) =>
  page.locator("aside > div:last-child [data-slot='avatar-fallback']");

/* The grid row the user's message renders in (avatar + Who + text) — Row's
   root is `group relative grid`, distinct from the agent-turn's group wrap.
   Scoped to the feed's session rows: the open peek panel (#195) renders the
   same message in its thread, which is not the row with the "N replies" chip. */
const userRow = (page: Page, text: string) =>
  page
    .locator("[data-session] div.group.grid")
    .filter({ has: page.locator('[data-slot="avatar-fallback"]') })
    .filter({ hasText: text })
    .last();

const bg = (loc: Locator) =>
  loc.evaluate((el) => getComputedStyle(el).backgroundColor);

async function dmDefault(page: Page, webUrl: string) {
  await page.goto(`${webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 90_000,
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

test.describe.configure({ mode: "serial" });

test("AC-1 the user's message avatar is the footer avatar (not a grey 'Y')", async ({
  page,
}) => {
  // bootStack + send + Focus navigation need headroom under parallel load.
  test.setTimeout(180_000);
  const stack = await bootStack(
    "ac80a",
    {
      relay: wport(4660),
      feed: wport(4661),
      web: wport(5262),
    },
    // #118: the signed-in name is the OS user's — pin it so the identity
    // assertions below stay deterministic on any machine.
    { LILOS_USER_NAME: "Oscar" },
  );
  try {
    await dmDefault(page, stack.webUrl);
    await send(page, PROMPT);
    // Sending opens the session in Focus (#114); Back lands on the feed.
    await page.getByRole("button", { name: "Back to DM" }).click();
    const row = userRow(page, PROMPT);
    await expect(row).toBeVisible({ timeout: 30_000 });
    const rowFb = row.locator('[data-slot="avatar-fallback"]');
    const footFb = footerAvatar(page);
    await expect(rowFb).toHaveText("O");
    await expect(footFb).toHaveText("O");
    // Same computed colour on both → literally one identity; and never the
    // old anonymous fallback's near-white grey (bg-muted ≈ oklch(0.97 0 0)).
    const [rowBg, footBg] = [await bg(rowFb), await bg(footFb)];
    expect(rowBg).toBe(footBg);
    expect(rowBg).not.toBe("oklch(0.97 0 0)");
    // The Who line names the signed-in human, not "You".
    await expect(row).toContainText("Oscar");
    await expect(row).not.toContainText("You");
  } finally {
    await stack.stop();
  }
});

test("AC-2 markdown renders while the reply streams, then settles unchanged", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const stack = await bootStack(
    "ac80b",
    { relay: wport(4664), feed: wport(4665), web: wport(5334) },
    // The `slow:` prompt stretches its own text phase (~4 s → observable
    // mid-stream); pin the human's name (#118).
    { LILOS_USER_NAME: "Oscar" },
  );
  try {
    await dmDefault(page, stack.webUrl);
    await send(page, STREAM_PROMPT);
    // Send lands in Focus (#114); the peek panel (conv URL minus /focus)
    // keeps this test covering the thread-panel markdown path.
    await page.waitForURL(/\/focus$/);
    await page.goto(page.url().replace(/\/focus$/, ""));
    const turn = page.locator("[data-agentturn]").first();
    const streaming = turn.locator("[data-streaming]");
    await expect(streaming).toBeVisible({ timeout: 60_000 });
    // Mid-stream the bullet and the `seq` code span are already real markdown.
    await expect(streaming.locator("li").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      streaming.locator("code").filter({ hasText: "seq" }),
    ).toBeVisible();
    await expect(streaming).not.toContainText("`");
    await expect(streaming).not.toContainText(/^-\s/m);
    await page.screenshot({ path: `${SHOTS}/ac-2-mid-stream.png` });
    // Done: the streaming block detaches; the same markdown stays rendered.
    await expect(streaming).toHaveCount(0, { timeout: 60_000 });
    await expect(
      turn.locator("code").filter({ hasText: "seq" }).first(),
    ).toBeVisible();
    await expect(turn.locator("li").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-2-done.png` });
  } finally {
    await stack.stop();
  }
});

test("AC-3 desktop app: same identity + streaming markdown in Electron", async () => {
  test.setTimeout(240_000);
  const stack = await bootStack(
    "ac80c",
    { relay: wport(4667), feed: wport(4669), web: wport(5335) },
    { LILOS_USER_NAME: "Oscar" },
  );
  try {
    const build = spawn("bun", ["scripts/dev.ts", "--payload-only"], {
      cwd: desktopDir,
      env: { ...process.env },
      stdio: "inherit",
    });
    await new Promise<void>((resolve, reject) => {
      build.once("exit", (c) =>
        c === 0 ? resolve() : reject(new Error(`desktop build exit ${c}`)),
      );
    });
    const portOf = (ws: string) => new URL(ws).port;
    const app = await _electron.launch({
      args:
        process.platform === "linux"
          ? [desktopDir, "--no-sandbox"]
          : [desktopDir],
      env: {
        ...process.env,
        LILOS_RELAY_HOME: stack.home,
        LILOS_RELAY_PORT: portOf(stack.relayWs),
        LILOS_FEED_PORT: portOf(stack.feedWs),
        LILOS_WEB_URL: stack.webUrl,
        LILOS_USER_NAME: "Oscar",
      },
    });
    try {
      const win = await app.firstWindow();
      await dmDefault(win, stack.webUrl);
      await send(win, STREAM_PROMPT_DESKTOP);
      // Send opens Focus (#114); Back returns to the feed the row lives on.
      await win.getByRole("button", { name: "Back to DM" }).click();
      // AC-1 in the desktop window: the user's row avatar IS the footer avatar.
      const row = userRow(win, PROMPT);
      await expect(row).toBeVisible({ timeout: 30_000 });
      const rowFb = row.locator('[data-slot="avatar-fallback"]');
      const footFb = footerAvatar(win);
      expect(await bg(rowFb)).toBe(await bg(footFb));
      await win.screenshot({ path: `${SHOTS}/ac-3-desktop-avatar.png` });
      // AC-2 in the desktop window: markdown mid-stream — reopen the session.
      await row.getByRole("button", { name: /repl/i }).click();
      await expect(win.locator("[data-agentturn]")).toHaveCount(1, {
        timeout: 15_000,
      });
      const streaming = win.locator("[data-agentturn] [data-streaming]");
      await expect(streaming.locator("li").first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(streaming.locator("code").first()).toBeVisible();
      await win.screenshot({ path: `${SHOTS}/ac-3-desktop-streaming.png` });
      await expect(streaming).toHaveCount(0, { timeout: 60_000 });
      await win.screenshot({ path: `${SHOTS}/ac-3-desktop-done.png` });
    } finally {
      await app.close();
    }
  } finally {
    await stack.stop();
  }
});
