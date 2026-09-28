import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";

/**
 * Issue #80 — DM identity + streaming markdown. AC-1 asserts the user's
 * message avatar IS the sidebar footer's avatar (same initial, same computed
 * colour — never the anonymous grey "Y"). AC-2 asserts markdown renders
 * mid-stream (ENGINE_FAKE_TICK stretches the text phase so the stream is
 * observable). AC-3 captures both in the Electron desktop app.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
// --repeat-each spreads a file's repeats across worker processes; each boots
// the stack again, so ports are offset per worker or relays race one port (#84).
const WORKER = Number(process.env.TEST_WORKER_INDEX ?? "0");
const wport = (p: number) => p + WORKER * 100;

const webDir = path.join(repo, "apps", "web");
const desktopDir = path.join(repo, "apps", "desktop");

interface Stack {
  home: string;
  webUrl: string;
  relayWs: string;
  feedWs: string;
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
    // vite answers HTTP before the relay accepts WS — wait for both or the
    // page hits "WebSocket error before open" under parallel load (#84).
    await waitForHttp(webUrl);
    await waitForHttp(`http://127.0.0.1:${ports.relay}`);
    return {
      home,
      webUrl,
      relayWs: `ws://127.0.0.1:${ports.relay}/ws`,
      feedWs: `ws://127.0.0.1:${ports.feed}/ws`,
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

const SHOTS = path.join(repo, "test-results", "ac-80");
const PROMPT = "What does the replay contract carry?"; // hits the default script

/* The footer's me-row: the aside's last child, its avatar fallback. */
const footerAvatar = (page: Page) =>
  page.locator("aside > div:last-child [data-slot='avatar-fallback']");

/* The grid row the user's message renders in (avatar + Who + text) — Row's
   root is `group relative grid`, distinct from the agent-turn's group wrap. */
const userRow = (page: Page, text: string) =>
  page
    .locator("div.group.grid")
    .filter({ has: page.locator('[data-slot="avatar-fallback"]') })
    .filter({ hasText: text })
    .last();

const bg = (loc: Locator) =>
  loc.evaluate((el) => getComputedStyle(el).backgroundColor);

async function dmDefault(page: Page, webUrl: string) {
  await page.goto(`${webUrl}/`);
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

test.describe.configure({ mode: "serial" });

test("AC-1 the user's message avatar is the footer avatar (not a grey 'Y')", async ({
  page,
}) => {
  const stack = await bootStack("ac80a", {
    relay: wport(4660),
    feed: wport(4661),
    web: wport(5262),
  });
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
  const stack = await bootStack(
    "ac80b",
    { relay: wport(4664), feed: wport(4665), web: wport(5264) },
    { ENGINE_FAKE_TICK: "150" }, // ~6s text phase → observable mid-stream
  );
  try {
    await dmDefault(page, stack.webUrl);
    await send(page, PROMPT);
    // Send lands in Focus (#114); the peek panel (conv URL minus /focus)
    // keeps this test covering the thread-panel markdown path.
    await page.waitForURL(/\/focus$/);
    await page.goto(page.url().replace(/\/focus$/, ""));
    const turn = page.locator("[data-agentturn]").first();
    const streaming = turn.locator("[data-streaming]");
    await expect(streaming).toBeVisible({ timeout: 60_000 });
    // Mid-stream the bullet and the `seq` code span are already real markdown.
    await expect(streaming.locator("li")).toBeVisible({ timeout: 60_000 });
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
    { relay: wport(4667), feed: wport(4669), web: wport(5266) },
    { ENGINE_FAKE_TICK: "150" },
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
      },
    });
    try {
      const win = await app.firstWindow();
      await dmDefault(win, stack.webUrl);
      await send(win, PROMPT);
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
      await expect(streaming.locator("li")).toBeVisible({ timeout: 60_000 });
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
