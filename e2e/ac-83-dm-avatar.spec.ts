import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { electronScreenshot, launchDesktop } from "./helpers/electron";
import {
  bootStack,
  pickPorts,
  skipFirstRun,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #83 — message row avatar alignment. A row's first content line was
 * the title/actions row, so the grid avatar top-aligned with it and floated
 * a line above the "Oscar · 07:20 PM" header. AC-2 measures the avatar
 * top edge against the name line's top edge in the live web app (≤4px —
 * happy-dom has no layout engine, so this must be real layout). AC-1 checks
 * the row's text and controls sit in the column right of the avatar and that
 * hover doesn't shift anything; AC-3 repeats the check inside the Electron
 * desktop app and captures the row there.
 *
 * v3: your messages are right-aligned bubbles with no avatar, so the avatar
 * + name pair this spec guards is the agent turn's header (`data-agentwho`: a
 * 20px orb and the agent's name beside it, over the answer). AC-1 checks the
 * name and time sit in the column right of the orb, that the answer is NOT
 * pushed into a gutter (it spans the column under the header), and that your
 * bubble is flush with the column's right edge; hover must not shift
 * anything. The "N replies" chip and the DM feed's `[data-session]` row
 * existed only on the deleted DM home, so the idle/selected states move to
 * the Threads list row for the same thread (it is `aria-current` while its
 * thread is open).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
// --repeat-each spreads a file's repeats across worker processes; each boots
// the stack again, so ports are offset per worker or relays race one port (#84).

const SHOTS = path.join(repo, "test-results", "ac-83");
const PROMPT = "What does the replay contract carry?"; // engine-fake script
const AGENT = { id: "default", name: "Default" };

/* The thread panel's first agent header: the orb is its first child, the
   name its first childless span, the time the span after it. */
const panelRow = (page: Page) =>
  page.locator("[data-thread-panel] [data-agentturn] [data-agentwho]").first();

/* The same thread's row on the Threads page (an "Earlier today" row once its
   turn is finished and seen): the agent's avatar and name in one flex line. */
const listRow = (page: Page) =>
  page
    .locator("#v3-main")
    .getByRole("button")
    .filter({ hasText: /replay contract/i })
    .first();

// All boxes are sampled inside ONE evaluate so they always come from the same
// rendered frame — separate boundingBox() calls can straddle a reflow and mix
// frames (#84).
const tops = (row: Locator) =>
  row.evaluate((el) => {
    const yOf = (n: Element | null | undefined) =>
      n ? n.getBoundingClientRect().y : null;
    const nameSpan = [...el.querySelectorAll("span")].find(
      (n) => n.childElementCount === 0 && n.textContent?.trim() === "Default",
    );
    const avatarTop = yOf(el.firstElementChild);
    const nameTop = yOf(nameSpan);
    const lineTop = yOf(el);
    if (avatarTop === null || nameTop === null) {
      throw new Error("row avatar or name line not laid out");
    }
    return { avatarTop, nameTop, lineTop };
  });

// Geometry asserts must sample the layout's fixed point: a reply lands a
// feed-tick after the message and grows the thread, so a single read can
// catch mid-reflow geometry (#84). Read until two consecutive samples are
// pixel-stable.
const settledTops = async (page: Page, row: Locator) => {
  let prev = await tops(row);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(100);
    const next = await tops(row);
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
const dumpRow = async (row: Locator) => {
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
    const gridStyle = getComputedStyle(el);
    return {
      row: box(el),
      grid: {
        display: gridStyle.display,
        templateColumns: gridStyle.gridTemplateColumns,
      },
      avatars: [...el.querySelectorAll("[data-slot='avatar']")].map((a) => ({
        box: box(a),
        cls: (a.getAttribute("class") ?? "").slice(0, 70),
      })),
      names: [...el.querySelectorAll("*")]
        .filter(
          (n) => n.childElementCount === 0 && n.textContent?.trim() === "Oscar",
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

// Assert the measured top-edge delta; on failure dump the row's DOM and all
// avatar/name boxes so CI (no artifact upload) still shows cause.
const expectAligned = async (page: Page, row: Locator, tag: string) => {
  const { avatarTop, nameTop, lineTop } = await settledTops(page, row);
  const delta = Math.abs(nameTop - avatarTop);
  const lineDelta = lineTop === null ? null : Math.abs(lineTop - avatarTop);
  if (delta > 4 || lineDelta === null || lineDelta > 4) {
    await dumpRow(row);
    console.log(
      `[ac83] ${tag}: nameTop=${nameTop} avatarTop=${avatarTop} lineTop=${lineTop}`,
    );
  }
  expect(delta, `${tag}: name span vs avatar`).toBeLessThanOrEqual(4);
  expect(lineDelta, `${tag}: name line vs avatar`).not.toBeNull();
  expect(lineDelta, `${tag}: name line vs avatar`).toBeLessThanOrEqual(4);
};

/* The Threads list row's own avatar/name pair (the agent's letter chip and its
   name, one `items-center` line): same top-edge rule, one frame. */
const listTops = (row: Locator) =>
  row.evaluate((el) => {
    const avatar = [...el.querySelectorAll("span[aria-hidden='true']")].find(
      (n) => (n as HTMLElement).style.width !== "",
    );
    const name = avatar?.nextElementSibling;
    if (!avatar || !name) throw new Error("list row avatar or name missing");
    return {
      avatarTop: avatar.getBoundingClientRect().y,
      nameTop: name.getBoundingClientRect().y,
    };
  });

const expectListAligned = async (page: Page, row: Locator, tag: string) => {
  let prev = await listTops(row);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(100);
    const next = await listTops(row);
    if (
      Math.abs(next.avatarTop - prev.avatarTop) < 0.5 &&
      Math.abs(next.nameTop - prev.nameTop) < 0.5
    )
      break;
    prev = next;
  }
  const { avatarTop, nameTop } = prev;
  expect(
    Math.abs(nameTop - avatarTop),
    `${tag}: list row name vs avatar (${nameTop} vs ${avatarTop})`,
  ).toBeLessThanOrEqual(4);
};

test.describe.configure({ mode: "serial" });

test("AC-1/AC-2 the avatar and name line share a top edge (≤4px)", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const stack = await bootStack(
    "ac83a",
    await pickPorts(),
    // #118: pin the OS user's name so nothing else in the panel reads
    // like the agent's.
    { LILOS_USER_NAME: "Oscar" },
  );
  try {
    await skipFirstRun(page);
    await startChat(page, stack.webUrl, AGENT, PROMPT);
    /* The send lands in the side peek; the agent's header renders with its turn. */
    const row = panelRow(page);
    await expect(row).toBeVisible({ timeout: 60_000 });
    // Settled state: engine-fake's reply is in and its turn is over.
    await expect(page.locator("[data-turnsettled]")).toBeVisible({
      timeout: 60_000,
    });
    await page.screenshot({ path: `${SHOTS}/ac-1-feed-row.png` });
    await expectAligned(page, row, "default viewport");
    // Same check at a narrow width — the name line must not wrap below the
    // avatar when fonts/window sizes differ (the Linux CI failure mode).
    await page.setViewportSize({ width: 900, height: 720 });
    await expectAligned(page, row, "900px viewport");
    await page.setViewportSize({ width: 1280, height: 720 });
    // AC-1: the agent's name and time sit in the column to the RIGHT of the
    // orb, the answer spans the column under the header, and your bubble is
    // flush with the column's right edge. Same single-frame rule as tops():
    // separate boundingBox() calls can straddle a reflow and mix frames (#84
    // — CI hit a 7px false negative).
    const geo = await row.evaluate((el) => {
      const x = (n: Element | null | undefined) =>
        n?.getBoundingClientRect().x ?? null;
      const orb = el.firstElementChild?.getBoundingClientRect();
      const turn = el.closest("[data-agentturn]");
      const bubble = document.querySelector(
        "[data-thread-panel] [data-userturn]",
      );
      return {
        orbRight: orb ? orb.x + orb.width : null,
        name: x(
          [...el.querySelectorAll("span")].find(
            (n) =>
              n.childElementCount === 0 && n.textContent?.trim() === "Default",
          ),
        ),
        // The answer's prose — not the reasoning's, which sits inside the work fold.
        answer: x(
          [...(turn?.querySelectorAll(".lilos-prose") ?? [])].find(
            (n) => !n.closest("[data-tasksteps]"),
          ),
        ),
        orbLeft: orb?.x ?? null,
        colRight: turn?.getBoundingClientRect().right ?? null,
        bubbleRight: bubble?.getBoundingClientRect().right ?? null,
      };
    });
    if (geo.orbRight === null) throw new Error("agent orb missing");
    expect(geo.name, "name right of the orb").toBeGreaterThanOrEqual(
      geo.orbRight - 1,
    );
    expect(
      geo.answer,
      "answer starts under the orb, not in a gutter",
    ).toBeLessThanOrEqual((geo.orbLeft ?? 0) + 1);
    // The agent turn spans the whole column, so its right edge IS the column's.
    expect(
      Math.abs((geo.colRight ?? 0) - (geo.bubbleRight ?? -99)),
      "bubble flush with the column's right edge",
    ).toBeLessThanOrEqual(1);
    // AC-1: hover (and its background change) doesn't shift the row's layout.
    await row.hover();
    await expectAligned(page, row, "hovered");
    // AC-1 states: the thread's Threads-list row is `aria-current` (selected)
    // while its thread is open. Close the peek (idle: no open thread) and
    // re-measure the list row's own avatar/name pair, reopen it from the row
    // (selected) and measure again; the panel row is re-measured there too.
    await v3Peek(page).getByTitle("Close (Esc)").click();
    await expect(v3Peek(page)).toHaveCount(0);
    const list = listRow(page);
    await expect(list).toBeVisible({ timeout: 30_000 });
    await expect(list).not.toHaveAttribute("aria-current", "true");
    await expectListAligned(page, list, "idle (no open thread)");
    await list.click(); // the row reopens the thread in the peek
    await expect(page).toHaveURL(/open=thread:[^&]+$/);
    await expect(list).toHaveAttribute("aria-current", "true");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expectListAligned(page, list, "selected (thread open)");
    await expectAligned(page, row, "selected (thread open)");
  } finally {
    await stack.stop();
  }
});

test("AC-3 desktop app: the thread row in Electron", async () => {
  test.setTimeout(240_000);
  const stack = await bootStack("ac83b", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
  try {
    const { app, win } = await launchDesktop(stack, {
      env: { LILOS_USER_NAME: "Oscar" },
    });
    try {
      await startChat(win, stack.webUrl, AGENT, PROMPT);
      const row = panelRow(win);
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(win.locator("[data-turnsettled]")).toBeVisible({
        timeout: 60_000,
      });
      // Screenshot first — the buggy run's shot is the "before" evidence.
      await electronScreenshot(app, win, `${SHOTS}/ac-3-desktop-dm.png`);
      // One evaluate → one frame; Promise.all of two boundingBox() calls can
      // still straddle a reflow (#84).
      const { avatarTop, nameTop } = await settledTops(win, row);
      expect(Math.abs(nameTop - avatarTop)).toBeLessThanOrEqual(4);
    } finally {
      await app.close();
    }
  } finally {
    await stack.stop();
  }
});
