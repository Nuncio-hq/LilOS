import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { launchDesktop } from "./helpers/electron";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #301 — the Focus expand/collapse button lands dead on first click:
 * the thread panel ⇄ Focus swap mounts a fresh `.lilos-drag` header with the
 * toggle at the same spot the cursor is already over, and the OS-side
 * draggable-region map isn't recomputed until a pointer event forces it —
 * the click is swallowed as a window drag. In v3 the swap is the side peek's
 * thread panel ⇄ session view (`full=1`): both views keep their own
 * `.lilos-drag` header inside `[data-thread-panel]`.
 *
 * What this spec can and cannot prove: Playwright's `page.mouse.click`
 * dispatches synthetic events that never reach the native NSView hit-test,
 * so no synthetic click can *fail* the way Oscar's real one did. What it
 * CAN assert end to end is the fix's mechanism: a MutationObserver watching
 * `style` mutations on `.lilos-drag` elements proves `watchDragRegions()`
 * actually re-pushed the region map after the swap (the flip is a real
 * two-frame DOM diff), and `elementFromPoint` + computed `-webkit-app-region`
 * prove the control sits in a no-drag rect in CSS terms. The real-click
 * repro before/after the fix is the screencapture evidence on the PR.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-301");

const isMac = process.platform === "darwin";

const appRegion = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) =>
      getComputedStyle(el).getPropertyValue("-webkit-app-region"),
    );

/* A thread open beside Threads (`open=…thread:<id>`), and the session view
   (`full=1`) it widens into. The thread may sit behind the person it was
   started from in the trail. */
const PANEL_URL = /[?&]open=([^&]*,)?thread:[^&,]+/;
const FULL_URL = /[#&]full=1(&|$)/;
const expectPanelUrl = async (win: Page) => {
  await expect(win).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await expect(win).not.toHaveURL(FULL_URL);
};

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  /* pickPorts (bound-and-probed): --repeat-each N marches the worker index
     and a fixed base+index·100 slot can land on a port the machine already
     owns (index 10 → web :6379, this fleet's redis), where --strictPort
     vite exits the stack before the first click (#484). */
  stack = await bootStack("ac301", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

test("#301 Focus toggle stays clickable across the panel ⇄ Focus header swap", async () => {
  test.skip(!isMac, "native drag regions are a macOS leg");
  test.setTimeout(180_000);
  const { app, win } = await launchDesktop(stack);
  try {
    const person = v3Sidebar(win).getByRole("button", { name: /default/i });
    await expect(person).toBeVisible({ timeout: 60_000 });
    /* A person opens in the side peek; "Message" starts the chat, and the
       send takes the draft's place with its thread. */
    await person.click();
    await v3Peek(win).getByRole("button", { name: "Message" }).click();
    const box = v3Peek(win).getByPlaceholder("Message Default…");
    await expect(box).toBeVisible({ timeout: 30_000 });
    await box.fill("check in");
    await v3Peek(win).getByRole("button", { name: "Send" }).click();
    await expectPanelUrl(win);

    /* #577: a send lands on the panel — step into the session view and back
       so the Expand button sits at the spot the next click will land (the
       session view's one back control is "Back to DM"). */
    await panelIntoFocus(win);
    await win.getByTitle("Back to DM", { exact: true }).click();
    await expectPanelUrl(win);

    const expand = win
      .locator("[data-thread-panel]")
      .getByTitle("Focus", { exact: true });
    await expect(expand).toBeVisible({ timeout: 30_000 });

    // Count every inline-style mutation the region watcher performs on a
    // .lilos-drag element — proof the OS map was re-pushed after a swap,
    // installed BEFORE the click that mounts Focus.
    await win.evaluate(() => {
      (window as unknown as { __regionFlips: number }).__regionFlips = 0;
      const mo = new MutationObserver((muts) => {
        for (const m of muts)
          if (m.target instanceof Element && m.target.closest(".lilos-drag"))
            (window as unknown as { __regionFlips: number }).__regionFlips += 1;
      });
      mo.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ["style"],
      });
    });

    // The control must sit in a no-drag rect inside its drag strip.
    await expect
      .poll(() => appRegion(win, "[data-thread-panel] .lilos-drag"))
      .toBe("drag");
    await expect
      .poll(() => appRegion(win, 'button[title="Focus"]'))
      .toBe("no-drag");
    const box1 = await expand.boundingBox();
    if (!box1) throw new Error("expand button has no box");
    const cx = box1.x + box1.width / 2;
    const cy = box1.y + box1.height / 2;
    const hit = await win.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('button[title="Focus"]') ? "button" : "other";
      },
      [cx, cy] as const,
    );
    expect(hit).toBe("button");

    // Synthetic click #1 at that point, no prior mouse-out — mounts Focus.
    await win.mouse.click(cx, cy);
    await expect(win).toHaveURL(FULL_URL, { timeout: 30_000 });
    /* #577: the swapped-in control is the one back control, "Back to
       DM" — same header spot as the old Exit-focus affordance. */
    const collapse = win.getByTitle("Back to DM", { exact: true });
    await expect(collapse).toBeVisible({ timeout: 30_000 });

    // The watcher's recompute ran against the newly mounted header…
    await expect
      .poll(() =>
        win.evaluate(
          () => (window as unknown as { __regionFlips: number }).__regionFlips,
        ),
      )
      .toBeGreaterThan(0);
    // …and the fresh button is again a no-drag rect at the same spot.
    await expect
      .poll(() => appRegion(win, "[data-thread-panel] > header"))
      .toBe("drag");
    await expect
      .poll(() => appRegion(win, 'button[title="Back to DM"]'))
      .toBe("no-drag");
    const box2 = await collapse.boundingBox();
    if (!box2) throw new Error("back button has no box");
    const hit2 = await win.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('button[title="Back to DM"]') ? "button" : "other";
      },
      [box2.x + box2.width / 2, box2.y + box2.height / 2] as const,
    );
    expect(hit2).toBe("button");
    await win.screenshot({ path: `${SHOTS}/301-focus-swapped.png` });

    // Click #2, back to the panel — same coordinates, still no mouse-out.
    await win.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await expectPanelUrl(win);
    await expect(expand).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
  }
});
