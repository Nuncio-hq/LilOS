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
    await waitForHttp(webUrl);
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
/* The name/time line is selected in-page (see tops()): the element at
   ":scope > .grid > *:nth-child(2) > *:first-child". */

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
    relay: wport(4670),
    feed: wport(4671),
    web: wport(5273),
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
    // All three boxes are sampled inside ONE evaluate so they always come
    // from the same rendered frame — separate boundingBox() calls can straddle
    // a reflow and mix frames (#84).
    const tops = async () =>
      row.evaluate((el) => {
        const yOf = (n: Element | null | undefined) =>
          n ? n.getBoundingClientRect().y : null;
        const nameSpan = [...el.querySelectorAll("span")].find(
          (n) => n.childElementCount === 0 && n.textContent?.trim() === "Oscar",
        );
        const avatarTop = yOf(el.querySelector("[data-slot='avatar']"));
        const nameTop = yOf(nameSpan);
        const lineTop = yOf(
          el.querySelector(":scope > .grid > *:nth-child(2) > *:first-child"),
        );
        if (avatarTop === null || nameTop === null) {
          throw new Error("row avatar or name line not laid out");
        }
        return { avatarTop, nameTop, lineTop };
      });
    // Geometry asserts must sample the layout's fixed point: the
    // reply-preview strip lands a feed-tick after the message and grows the
    // row, so a single read can catch mid-reflow geometry (#84). Read until
    // two consecutive samples are pixel-stable.
    const settledTops = async () => {
      let prev = await tops();
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(100);
        const next = await tops();
        if (
          Math.abs(next.avatarTop - prev.avatarTop) < 0.5 &&
          Math.abs(next.nameTop - prev.nameTop) < 0.5 &&
          next.lineTop !== null &&
          prev.lineTop !== null &&
          Math.abs(next.lineTop - prev.lineTop) < 0.5
        ) {
          return next;
        }
        prev = next;
      }
      return prev;
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
      const { avatarTop, nameTop, lineTop } = await settledTops();
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
    // Same single-frame rule as tops(): separate boundingBox() calls can
    // straddle a reflow and mix frames (#84 — CI hit a 7px false negative).
    const { avatarBox, chipBox } = await row.evaluate((el) => {
      const r = (n: Element | null | undefined) => {
        const b = n?.getBoundingClientRect();
        return b ? { x: b.x, width: b.width } : null;
      };
      const buttons = el.querySelectorAll("button");
      return {
        avatarBox: r(el.querySelector("[data-slot='avatar']")),
        chipBox: r(buttons[buttons.length - 1]),
      };
    });
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
    relay: wport(4674),
    feed: wport(4676),
    web: wport(5277),
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
      // One evaluate → one frame; Promise.all of two boundingBox() calls can
      // still straddle a reflow (#84).
      const { a, n } = await row.evaluate((el) => {
        const y = (e: Element | null | undefined) =>
          e?.getBoundingClientRect().y ?? null;
        const nameSpan = [...el.querySelectorAll("span")].find(
          (s) => s.childElementCount === 0 && s.textContent?.trim() === "Oscar",
        );
        return {
          a: y(el.querySelector("[data-slot='avatar']")),
          n: y(nameSpan),
        };
      });
      if (a === null || n === null)
        throw new Error("row avatar or name line not laid out");
      expect(Math.abs(n - a)).toBeLessThanOrEqual(4);
    } finally {
      await app.close();
    }
  } finally {
    await stack.stop();
  }
});
