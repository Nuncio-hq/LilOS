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

/**
 * Issue #83 — DM feed row avatar alignment. A session row's first content
 * line was the title/actions row, so the grid avatar top-aligned with it and
 * floated a line above the "Oscar · 07:20 PM" header. AC-2 measures the row's
 * avatar top edge against the name line's top edge in the live web app
 * (≤4px — happy-dom has no layout engine, so this must be real layout).
 * AC-1 checks the reply chip sits in the column right of the avatar and that
 * hover doesn't shift anything; AC-3 repeats the check inside the Electron
 * desktop app and captures the row there.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
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
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 8_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

async function bootStack(
  tag: string,
  ports: { relay: number; feed: number; web: number },
  extraEnv: Record<string, string> = {},
): Promise<Stack> {
  const home = mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const proc = spawn("bun", ["run", "dev"], {
    cwd: webDir,
    env: {
      ...process.env,
      LILOS_HOME: home,
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
    return {
      home,
      webUrl,
      relayWs: `ws://127.0.0.1:${ports.relay}/ws`,
      feedWs: `ws://127.0.0.1:${ports.feed}/ws`,
      stop: () => killProc(proc),
    };
  } catch (e) {
    proc.kill("SIGKILL");
    throw e;
  }
}

const SHOTS = path.join(repo, "test-results", "ac-83");
const PROMPT = "What does the replay contract carry?"; // engine-fake script

/* The middle-pane session row: `[data-session]` wraps the `Row` grid. The
   row's avatar is its grid column 1 (the reply chip's mini avatar also
   matches [data-slot=avatar], so `.first()` keeps the row's), and the name
   line's top is measured at the "Oscar" span — exact text, since the avatar
   fallback "O" also carries `font-semibold`. */
const feedRow = (page: Page) => page.locator("[data-session]").first();
const rowAvatar = (row: Locator) => row.locator("[data-slot='avatar']").first();
const nameLine = (row: Locator) => row.getByText("Oscar", { exact: true });
/* The first content line of the row — the element holding the name/time row.
   Measured alongside the "Oscar" span so the check doesn't depend on text-node
   boxes (font metric differences across platforms). */
const nameLineRow = (row: Locator) =>
  row.locator(":scope > .grid > *:nth-child(2) > *:first-child");

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

test("AC-1/AC-2 the avatar and name line share a top edge (≤4px)", async ({
  page,
}) => {
  const stack = await bootStack("ac83a", {
    relay: 4620,
    feed: 4621,
    web: 5215,
  });
  try {
    await dmDefault(page, stack.webUrl);
    await send(page, PROMPT);
    const row = feedRow(page);
    await expect(row).toBeVisible({ timeout: 30_000 });
    // Settled state: engine-fake's reply is in, the session chip is rendered.
    await expect(row.getByText(/\d+ repl(y|ies)/)).toBeVisible({
      timeout: 60_000,
    });
    const tops = async () => {
      const avatar = await rowAvatar(row).boundingBox();
      const name = await nameLine(row).boundingBox();
      if (!avatar || !name) {
        throw new Error("row avatar or name line not laid out");
      }
      return { avatarTop: avatar.y, nameTop: name.y };
    };
    // On failure, dump what was measured so CI (which can't upload artifacts)
    // still shows the real DOM + boxes.
    const dumpRow = async () => {
      const d = await row.evaluate((el) => {
        const box = (n: Element) => {
          const r = n.getBoundingClientRect();
          return {
            x: +r.x.toFixed(1),
            y: +r.y.toFixed(1),
            w: +r.width.toFixed(1),
            h: +r.height.toFixed(1),
          };
        };
        const grid = el.querySelector(":scope > .grid");
        const gridStyle = grid ? getComputedStyle(grid) : null;
        return {
          row: box(el),
          grid: grid
            ? {
                display: gridStyle?.display,
                templateColumns: gridStyle?.gridTemplateColumns,
                box: box(grid),
              }
            : null,
          avatars: [...el.querySelectorAll("[data-slot='avatar']")].map(
            (a) => ({
              box: box(a),
              cls: (a.getAttribute("class") ?? "").slice(0, 70),
            }),
          ),
          oscars: [...el.querySelectorAll("*")]
            .filter(
              (n) =>
                n.childElementCount === 0 && n.textContent?.trim() === "Oscar",
            )
            .map((n) => ({
              box: box(n),
              tag: n.tagName,
              cls: (n.getAttribute("class") ?? "").slice(0, 70),
            })),
          html: el.outerHTML.slice(0, 5000),
        };
      });
      console.log(`[ac83-dump] ${JSON.stringify(d)}`);
    };
    // Assert the measured top-edge delta; on failure dump the row's DOM and
    // all avatar/name boxes so CI (no artifact upload) still shows cause.
    const expectAligned = async (tag: string) => {
      const { avatarTop, nameTop } = await tops();
      const lineBox = await nameLineRow(row).boundingBox();
      const lineTop = lineBox ? lineBox.y : null;
      const delta = Math.abs(nameTop - avatarTop);
      const lineDelta = lineTop === null ? null : Math.abs(lineTop - avatarTop);
      if (delta > 4 || lineDelta === null || lineDelta > 4) {
        await dumpRow();
        console.log(
          `[ac83] ${tag}: nameTop=${nameTop} avatarTop=${avatarTop} lineTop=${lineTop}`,
        );
      }
      expect(delta, `${tag}: name span vs avatar`).toBeLessThanOrEqual(4);
      expect(lineDelta, `${tag}: name line vs avatar`).not.toBeNull();
      expect(lineDelta, `${tag}: name line vs avatar`).toBeLessThanOrEqual(4);
    };
    await page.screenshot({ path: `${SHOTS}/ac-1-feed-row.png` });
    await expectAligned("default viewport");
    // Same check at a narrow width — the name line must not wrap below the
    // avatar when fonts/window sizes differ (the Linux CI failure mode).
    await page.setViewportSize({ width: 900, height: 720 });
    await expectAligned("900px viewport");
    await page.setViewportSize({ width: 1280, height: 720 });
    // AC-1: text + reply chip sit in the column to the RIGHT of the avatar.
    const avatarBox = await rowAvatar(row).boundingBox();
    const chipBox = await row.locator("button").last().boundingBox();
    if (!avatarBox || !chipBox) throw new Error("row boxes missing");
    expect(chipBox.x).toBeGreaterThanOrEqual(avatarBox.x + avatarBox.width - 1);
    // AC-1: hover (and its background change) doesn't shift the row's layout.
    await row.hover();
    await expectAligned("hovered");
    // AC-1 selected state: the row is `active` while its session is open —
    // drop to the plain DM view (idle) and back (selected) and re-measure.
    const empId = /\/dm\/([^/]+)/.exec(page.url())?.[1];
    if (!empId) throw new Error(`not on a DM route: ${page.url()}`);
    await page.goto(`${stack.webUrl}/dm/${empId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expectAligned("idle (no open session)");
    await row.locator("button").last().click(); // chip reopens the session
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expectAligned("selected (session open)");
  } finally {
    await stack.stop();
  }
});

test("AC-3 desktop app: the DM feed row in Electron", async () => {
  test.setTimeout(240_000);
  const stack = await bootStack("ac83b", {
    relay: 4622,
    feed: 4623,
    web: 5216,
  });
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
      const row = feedRow(win);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.getByText(/\d+ repl(y|ies)/)).toBeVisible({
        timeout: 60_000,
      });
      // Screenshot first — the buggy run's shot is the "before" evidence.
      await win.screenshot({ path: `${SHOTS}/ac-3-desktop-dm.png` });
      const [a, n] = await Promise.all([
        rowAvatar(row).boundingBox(),
        nameLine(row).boundingBox(),
      ]);
      if (!a || !n) throw new Error("row avatar or name line not laid out");
      expect(Math.abs(n.y - a.y)).toBeLessThanOrEqual(4);
    } finally {
      await app.close();
    }
  } finally {
    await stack.stop();
  }
});
