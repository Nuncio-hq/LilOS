import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { ensureDesktopPayload } from "./helpers/electron";
import { growDmThread } from "./helpers/relay-thread";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #554 — the Mac app's ⌘F finds text inside the open thread.
 *
 *   AC-1 ⌘F / ⌘G / ⇧⌘G / Esc work in Thread AND Focus and match rows held
 *        off-screen (#430/#512).
 *   AC-2 Find is listed in the Edit menu.
 *   AC-3 Electron E2E: a word in an early turn of a long thread is
 *        highlighted and scrolled into view.
 *
 * The menu's accelerators are consumed by macOS and never reach the page —
 * Playwright's synthetic keys can't press them either — so the spec clicks
 * the real menu items through `app.evaluate`, the same path the OS takes.
 * One 60-turn engine-fake thread is grown through relay RPC (#574); the
 * probe word rides user turns 2 and 58, which hold as stubs off-screen.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const desktopDir = path.join(repo, "apps", "desktop");
const SHOTS = path.join(repo, "test-results", "ac-554");
const isMac = process.platform === "darwin";

/* A word planted in two turns — early (held) and late — so the ordinal
   readout and the direction keys have two real matches to walk. */
const PROBE = "findprobe554";

let stack: Stack;
let app: ElectronApplication;
let win: Page;

async function launchDesktop(webUrl: string): Promise<ElectronApplication> {
  await ensureDesktopPayload(desktopDir);
  return _electron.launch({
    args:
      process.platform === "linux"
        ? [desktopDir, "--no-sandbox"]
        : [desktopDir],
    env: {
      ...process.env,
      LILOS_RELAY_HOME: stack.home,
      LILOS_RELAY_PORT: String(stack.ports.relay),
      LILOS_FEED_PORT: String(stack.ports.feed),
      LILOS_WEB_URL: webUrl,
    },
  });
}

async function dismissFirstRun(win: Page) {
  const skip = win.getByRole("button", { name: /set up later/i });
  if (
    await skip
      .first()
      .isVisible()
      .catch(() => false)
  )
    await skip.first().click();
  await expect(win.locator("[data-first-run]")).toHaveCount(0, {
    timeout: 10_000,
  });
}

/** Click a real application-menu item — the renderer path the OS takes. */
const clickMenuItem = (id: string) =>
  app.evaluate(
    ({ Menu }, menuId) =>
      Menu.getApplicationMenu()?.getMenuItemById(menuId)?.click(),
    id,
  );

/** The deepest element whose own text is exactly the probe — the row Chromium
    scrolled to — measured against the conversation scrollport clip. */
async function probeMatch(scope: string, text: string) {
  return win.evaluate(
    ({ sel, probe }) => {
      const scopeEl = document.querySelector(sel);
      if (!scopeEl) return null;
      const walker = document.createTreeWalker(
        scopeEl,
        NodeFilter.SHOW_ELEMENT,
      );
      const leaves: Element[] = [];
      for (
        let n = walker.nextNode() as Element | null;
        n;
        n = walker.nextNode() as Element | null
      ) {
        if (n.childElementCount === 0 && n.textContent?.includes(probe))
          leaves.push(n);
      }
      const first = scopeEl.querySelector("[data-msg]");
      let port = first?.parentElement ?? null;
      while (port && !/(auto|scroll)/.test(getComputedStyle(port).overflowY))
        port = port.parentElement;
      if (leaves.length === 0 || !port) return null;
      const pt = port.getBoundingClientRect();
      return {
        portTop: pt.top,
        portBottom: pt.bottom,
        scrollTop: port.scrollTop,
        matches: leaves.map((l) => {
          const r = l.getBoundingClientRect();
          return {
            top: r.top,
            bottom: r.bottom,
            visible: r.bottom > pt.top + 1 && r.top < pt.bottom - 1,
          };
        }),
      };
    },
    { sel: scope, probe: text },
  );
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.skip(!isMac, "the app menu and ⌘F find-in-page are a macOS leg");
  test.setTimeout(300_000);
  stack = await bootStack("find554", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    ENGINE_FAKE_TICK: "2",
  });
  /* 60 turns » TURN_LAZY_AFTER — prompt 1 becomes the always-mounted root,
     so the probe rides turns 2 and 58, held as stubs while off-screen. */
  const grown = await growDmThread(stack, [
    "status check pass 1",
    `status check pass 2 ${PROBE}`,
    ...Array.from({ length: 56 }, (_, i) => `status check pass ${i + 3}`),
    `status check pass 59 ${PROBE}`,
    "status check pass 60",
  ]);
  app = await launchDesktop(
    `${stack.webUrl}/dm/${grown.employeeId}/${grown.conversationId}`,
  );
  win = await app.firstWindow();
  await dismissFirstRun(win);
  const panel = win.locator("[data-thread-panel]");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => panel.locator("[data-agentturn]").count(), {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(60);
  await expect(
    panel.locator("[data-agentturn]").nth(59).locator("[data-turnsettled]"),
  ).toBeAttached({ timeout: 60_000 });
  /* Going in, off-screen rows really are held: each probe turn renders its
     probe twice (user prompt + the echo in the engine reply), so a fully
     mounted thread would read 4 — the held turns keep the count under 4
     no matter where the restored scroll position lands. */
  await expect
    .poll(() => panel.locator("[data-held-stub]").count(), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await expect
    .poll(() => panel.getByText(PROBE).count(), { timeout: 30_000 })
    .toBeLessThan(4);
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  await stack?.stop();
});

test("AC-2 (#554) the Edit menu lists Find… ⌘F, Find Next ⌘G, Find Previous ⇧⌘G", async () => {
  const items = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      ?.items.find((i) => i.label === "Edit")
      ?.submenu?.items.map((i) => ({
        id: i.id,
        label: i.label,
        accelerator: i.accelerator,
      })),
  );
  expect(items).toContainEqual({
    id: "find",
    label: "Find…",
    accelerator: "CmdOrCtrl+F",
  });
  expect(items).toContainEqual({
    id: "find-next",
    accelerator: "CmdOrCtrl+G",
    label: "Find Next",
  });
  expect(items).toContainEqual({
    id: "find-prev",
    accelerator: "Shift+CmdOrCtrl+G",
    label: "Find Previous",
  });
});

test("AC-1/AC-3 (#554) ⌘F highlights + scrolls to a held early turn; ⌘G/⇧⌘G walk; Esc closes — Thread panel and Focus", async () => {
  test.setTimeout(180_000);
  const panel = win.locator("[data-thread-panel]");
  const bar = win.locator("[data-find-bar]");
  const input = win.locator("[data-find-input]");
  const count = win.locator("[data-find-count]");

  /* The Edit menu's Find… — the only ⌘F delivery on macOS — opens the bar
     over the thread and focuses its field. */
  await clickMenuItem("find");
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await expect(input).toBeFocused();

  /* The find session pins the un-stub window: every held row mounts, so
     the probe — text nowhere in the DOM a moment ago — is findable. */
  await expect
    .poll(() => panel.locator("[data-held-stub]").count(), {
      timeout: 30_000,
    })
    .toBe(0);
  await expect(panel.getByText(PROBE).first()).toBeAttached({
    timeout: 15_000,
  });

  /* Typing drives webContents.findInPage; found-in-page feeds the readout. */
  await input.fill(PROBE);
  await expect(count).toHaveText(/^1 of [2-9]/, { timeout: 15_000 });

  /* AC-3 — the first match is the held turn-2 row: it is highlighted AND
     scrolled into view — the scroll can land a beat after the result
     (the un-stub mount's top-edge hold has to release), so poll for the
     leaf's rect settling inside the port's clip. (probeMatch's DOM order
     matches Chromium's match order: matches[0] = early turn.) */
  await expect
    .poll(
      async () => {
        const m = await probeMatch("[data-thread-panel]", PROBE);
        return m?.matches[0]?.visible === true;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await win.screenshot({ path: `${SHOTS}/ac-3-find-highlight.png` });

  /* ⌘G walks the active ordinal forward: the port scrolls down to a later
     match. ⇧⌘G walks it back up to the first. */
  await clickMenuItem("find-next");
  await expect(count).toHaveText(/^2 of /, { timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const m = await probeMatch("[data-thread-panel]", PROBE);
        return m?.matches.some((x, i) => i > 0 && x.visible) === true;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  await clickMenuItem("find-prev");
  await expect(count).toHaveText(/^1 of /, { timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const m = await probeMatch("[data-thread-panel]", PROBE);
        return m?.matches[0]?.visible === true;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  /* Esc is the find bar's own ui-layer (#576 stack): it closes the bar —
     and stops the find (highlights cleared) — without ever reaching the
     panel's Esc-close layer. */
  await win.keyboard.press("Escape");
  await expect(bar).toHaveCount(0, { timeout: 15_000 });
  await expect(win.locator("[data-thread-panel]")).toBeVisible();

  /* Focus — the same bar over the focus column. The URL's /focus route
     renders the same conversation full-width. */
  await win.goto(
    win.url().endsWith("/focus") ? win.url() : `${win.url()}/focus`,
  );
  await expect(win.locator("[data-find-bar]")).toHaveCount(0);
  const focusScope = "[data-thread]";
  await clickMenuItem("find");
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await expect(input).toBeFocused();
  await input.fill(PROBE);
  await expect(count).toHaveText(/of [2-9]/, { timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const m = await probeMatch(focusScope, PROBE);
        return m?.matches.some((x) => x.visible) === true;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await win.screenshot({ path: `${SHOTS}/ac-1-focus-find.png` });
  await win.keyboard.press("Escape");
  await expect(bar).toHaveCount(0, { timeout: 15_000 });
});
