import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { launchDesktop } from "./helpers/electron";
import {
  bootStack,
  panelFocusReady,
  pickPorts,
  type Stack,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #301 — the Focus expand/collapse button landed dead on first click:
 * the thread panel ⇄ Focus swap mounted a fresh `.lilos-drag` header with the
 * toggle at the same spot the cursor was already over, and the OS-side
 * draggable-region map wasn't recomputed until a pointer event forced it —
 * the click was swallowed as a window drag. In v3 the swap is the side peek's
 * thread panel ⇄ session view (`full=1`), and the one control for it is the
 * peek header's Widen/Narrow (the thread draws no expand button of its own,
 * and its header scrolls with the conversation rather than being a drag
 * strip), which swap at the same spot.
 *
 * What this spec can and cannot prove: Playwright's `page.mouse.click`
 * dispatches synthetic events that never reach the native NSView hit-test,
 * so no synthetic click can *fail* the way Oscar's real one did. What it
 * CAN assert end to end is that the control sits in a no-drag rect in CSS
 * terms (`-webkit-app-region` is never `drag` there) and that
 * `elementFromPoint` at its centre is the button — for Widen, and for the
 * Narrow that takes its place — and that a first synthetic click at that
 * point, with no prior mouse-out, does the swap both ways.
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

    /* #577: a send lands on the panel. The peek header's Widen sits at the
       spot the click will land, and Narrow takes the same spot once the
       session view is up — the swap the cursor never leaves. */
    const peek = v3Peek(win);
    const widen = peek.getByTitle("Widen over the page", { exact: true });
    const narrow = peek.getByTitle("Narrow, back beside the page", {
      exact: true,
    });
    await panelFocusReady(win);
    await expect(widen).toBeVisible({ timeout: 30_000 });

    // The control must sit in a no-drag rect: not inside any drag strip.
    await expect
      .poll(() => appRegion(win, 'button[title="Widen over the page"]'))
      .not.toBe("drag");
    const box1 = await widen.boundingBox();
    if (!box1) throw new Error("widen button has no box");
    const cx = box1.x + box1.width / 2;
    const cy = box1.y + box1.height / 2;
    const hit = await win.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('button[title="Widen over the page"]')
          ? "button"
          : "other";
      },
      [cx, cy] as const,
    );
    expect(hit).toBe("button");

    // Synthetic click #1 at that point, no prior mouse-out — mounts Focus.
    await win.mouse.click(cx, cy);
    await expect(win).toHaveURL(FULL_URL, { timeout: 30_000 });
    // The swapped-in control is the one way back, at the same header spot.
    await expect(narrow).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() =>
        appRegion(win, 'button[title="Narrow, back beside the page"]'),
      )
      .not.toBe("drag");
    const box2 = await narrow.boundingBox();
    if (!box2) throw new Error("narrow button has no box");
    const hit2 = await win.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('button[title="Narrow, back beside the page"]')
          ? "button"
          : "other";
      },
      [box2.x + box2.width / 2, box2.y + box2.height / 2] as const,
    );
    expect(hit2).toBe("button");
    await win.screenshot({ path: `${SHOTS}/301-focus-swapped.png` });

    // Click #2, back to the panel — same coordinates, still no mouse-out.
    await win.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await expectPanelUrl(win);
    await expect(widen).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
  }
});
