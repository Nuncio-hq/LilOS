import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect, type Page, test } from "@playwright/test";
import {
  electronSafeEnv,
  electronScreenshot,
  ensureDesktopPayload,
} from "./helpers/electron";
import { bootStack, pickPorts, skipFirstRun, v3Sidebar } from "./helpers/stack";

/**
 * Issue #132 — Settings (⌘,): one place for profile, editors, models,
 * status, updates. AC-1 ⌘, opens Settings and Service Status stays its own
 * menu item; AC-2 Settings renders the profile, approvals, editors, models,
 * status and About with real data; AC-3 edits apply live across open
 * windows; AC-4 About shows real versions and the update control only
 * exists on the desktop build; AC-5 the sidebar's Settings entry opens the
 * same screen.
 *
 * v3: Settings is a page, not a dialog — `#?page=settings&view=general|engine|phone`
 * with tabs General (you + company, Approvals, "Open files in", About) and
 * "Engine & models" (engine, Status, Models). So "Esc closes" has no
 * counterpart (nothing to dismiss). Approvals is LilOS's own Ask / Full
 * access switch with the engine's policy (Smart / Manual / Off) beneath it.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const desktopDir = path.join(repo, "apps", "desktop");
const FAKE_OS = path.join(here, "os-fake");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";

/* Shared stack env (#118 pins the signed-in name; os.editors sees the
   committed fake Cursor/Zed bundles for the "Open files in" choice). */
const SETTINGS_ENV = {
  LILOS_USER_NAME: "Test User",
  LILOS_APP_DIRS: path.join(FAKE_OS, "Applications"),
};

const SHOTS = path.join(repo, "test-results", "ac-132");

/** The relay's LilOS-owned settings KV, straight from sqlite. */
function storedSetting(home: string, key: string): unknown {
  const out = spawnSync(
    BUN,
    [
      "-e",
      `const db = new (await import("bun:sqlite")).Database(${JSON.stringify(
        path.join(home, "relay.sqlite"),
      )});
       const r = db.query("SELECT value FROM settings WHERE key = ?").get(${JSON.stringify(key)});
       console.log(r ? r.value : "null");`,
    ],
    { encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error(`sqlite read failed: ${out.stderr}`);
  return JSON.parse(out.stdout.trim() || "null");
}

const main = (page: Page) => page.locator("main");
/** A Settings tab (they are plain buttons in the page's tab row). */
const tab = (page: Page, name: string) =>
  main(page).getByRole("button", { name, exact: true });
/** The row of the General pane that holds `label` ("Your name", "Company"). */
const fact = (page: Page, label: string) =>
  main(page).getByText(label, { exact: true }).locator("xpath=..");

/** Past first run, then Settings through the sidebar, the way a person does. */
async function openSettings(page: Page) {
  await v3Sidebar(page).getByRole("button", { name: "Settings" }).click();
  await expect(page).toHaveURL(/[#?&]page=settings(&|$)/);
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();
}

/** A stack opened on Home with the first-run gate skipped. */
async function openApp(page: Page, webUrl: string) {
  await skipFirstRun(page);
  await page.goto(`${webUrl}/`);
  await expect(
    v3Sidebar(page).getByRole("button", { name: /Default/ }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });

test("AC-1+AC-5 Settings opens via the sidebar and ⌘,; Approvals listed", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await bootStack("ac132a", await pickPorts(), SETTINGS_ENV);
  try {
    await openApp(page, stack.webUrl);

    // AC-5: the sidebar's entry point.
    await openSettings(page);
    await expect(tab(page, "General")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-5-sidebar-entry.png` });

    // AC-1: the ⌘, shortcut (Control+, — the handler takes meta or ctrl),
    // from another page: Threads → Settings.
    await v3Sidebar(page).getByRole("button", { name: "Threads" }).click();
    await expect(page).toHaveURL(/[#?&]page=threads(&|$)/);
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toHaveCount(0);
    await page.keyboard.press("Control+,");
    await expect(page).toHaveURL(/[#?&]page=settings(&|$)/);
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toBeVisible();

    // Every pane with real data is listed — Approvals too since #106 (the
    // fake engine declares approval_policy): General holds it, "Engine &
    // models" holds Status and Models, Phone the paired phones.
    for (const name of ["General", "Engine & models", "Phone"]) {
      await expect(tab(page, name)).toBeVisible();
    }
    for (const name of [
      "You and the company",
      "Approvals",
      "Open files in",
      "About",
    ]) {
      await expect(
        main(page).getByRole("heading", { name, level: 3 }),
      ).toBeVisible();
    }
    await expect(
      main(page).getByRole("radio", { name: "Ask before risky commands" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: `${SHOTS}/ac-1-sections.png` });
  } finally {
    await stack.stop();
  }
});

test("AC-2 every section renders real data", async ({ page }) => {
  test.setTimeout(120_000);
  const stack = await bootStack("ac132b", await pickPorts(), SETTINGS_ENV);
  try {
    await openApp(page, stack.webUrl);
    await openSettings(page);

    // General: the OS-derived identity is prefilled.
    await tab(page, "General").click();
    await expect(fact(page, "Your name")).toContainText("Test User");
    await expect(fact(page, "Company")).toContainText("Test's Co");

    // Open files in: the fake Cursor/Zed bundles are detected; the default
    // leads.
    const editorRows = main(page).getByRole("radiogroup", {
      name: "Open files in",
    });
    await expect(editorRows.getByRole("radio")).toHaveCount(2);
    await expect(editorRows).toContainText("Cursor");
    await expect(editorRows).toContainText("Zed");
    await expect(
      editorRows.getByRole("radio", { name: /Cursor/ }),
    ).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: `${SHOTS}/ac-2-editors.png` });

    // About: real versions — the relay/harness report theirs.
    await expect(main(page)).toContainText("LilOS");
    await expect(main(page)).toContainText(/relay \d+\.\d+\.\d+/);
    await page.screenshot({ path: `${SHOTS}/ac-4-about.png` });

    // Engine & models: the fake engine's catalog shows up with the count of
    // models that are on.
    await tab(page, "Engine & models").click();
    await expect(page).toHaveURL(/[#?&]view=engine(&|$)/);
    await expect(
      main(page).getByRole("heading", { name: /^Models/, level: 3 }),
    ).toContainText(/\d+ on/);
    await expect(
      main(page).getByRole("switch", { name: / on$/ }).first(),
    ).toHaveAttribute("aria-checked", "true");

    // Status: the real legs list.
    await expect(
      main(page).getByRole("heading", { name: "Status", level: 3 }),
    ).toBeVisible();
    await expect(main(page)).toContainText("Local relay");
    await expect(
      main(page).getByRole("button", { name: "Copy diagnostics" }),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-2-status.png` });
  } finally {
    await stack.stop();
  }
});

test("AC-3 edits in one window land live in another", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("ac132c", await pickPorts(), SETTINGS_ENV);
  try {
    await openApp(page, stack.webUrl);
    const page2 = await context.newPage();
    await skipFirstRun(page2);
    await page2.goto(`${stack.webUrl}/`);
    await expect(
      v3Sidebar(page2).getByRole("button", { name: /Default/ }),
    ).toBeVisible({ timeout: 30_000 });

    await openSettings(page);
    await openSettings(page2);

    // A name typed in window 1 lands in window 2's field and on its Home.
    await fact(page, "Your name")
      .getByRole("button", { name: "Rename…" })
      .click();
    await main(page).getByLabel("Your name").fill("Ada");
    await main(page).getByRole("button", { name: "Save" }).click();
    await expect(fact(page2, "Your name")).toContainText("Ada", {
      timeout: 15_000,
    });
    await v3Sidebar(page2).getByRole("button", { name: "Home" }).click();
    await expect(
      page2.getByRole("heading", { name: /Good afternoon, Ada/, level: 1 }),
    ).toBeVisible();

    // The default-editor pick lands in the relay KV and in window 2.
    await v3Sidebar(page2).getByRole("button", { name: "Settings" }).click();
    await main(page).getByRole("radio", { name: /Zed/ }).click();
    await expect
      .poll(() => storedSetting(stack.home, "defaultEditor"), {
        timeout: 10_000,
      })
      .toBe("zed");
    await expect(
      main(page2).getByRole("radio", { name: /Zed/ }),
    ).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: `${SHOTS}/ac-3-live-edit.png` });
  } finally {
    await stack.stop();
  }
});

test("screenshots: the AC matrix (light + dark, 1288 / 900 / 1440)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await bootStack("ac132shots", await pickPorts(), SETTINGS_ENV);
  try {
    await page.setViewportSize({ width: 1288, height: 700 });
    await openApp(page, stack.webUrl);
    await openSettings(page);
    await expect(tab(page, "General")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/shot-1288-light.png` });

    await page.setViewportSize({ width: 900, height: 700 });
    await page.screenshot({ path: `${SHOTS}/shot-900-light.png` });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${SHOTS}/shot-1440-light.png` });

    // Dark: same screen, the theme the app actually persists.
    await page.evaluate(() => localStorage.setItem("lilos-theme", "dark"));
    await page.setViewportSize({ width: 1288, height: 700 });
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(tab(page, "General")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/shot-1288-dark.png` });
  } finally {
    await stack.stop();
  }
});

test("AC-4 on plain web the update control does not render", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await bootStack("ac132d", await pickPorts(), SETTINGS_ENV);
  try {
    await openApp(page, stack.webUrl);
    await openSettings(page);
    await expect(main(page)).toContainText("LilOS");
    await expect(
      main(page).getByRole("button", { name: "Check for updates" }),
    ).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

test("AC-1 the desktop menu opens Settings on ⌘, and Service Status stays", async () => {
  test.setTimeout(180_000);
  await ensureDesktopPayload(desktopDir);
  const stack = await bootStack("ac132e", await pickPorts(), SETTINGS_ENV);
  // A scratch state dir: the window's localStorage (first-run flag, theme)
  // must not be this Mac's real LilOS profile.
  const stateDir = path.join(tmpdir(), `lilos-ac132-${process.pid}`);
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    app = await _electron.launch({
      args:
        process.platform === "linux"
          ? [desktopDir, "--no-sandbox"]
          : [desktopDir],
      env: {
        ...electronSafeEnv(),
        LILOS_RELAY_HOME: stack.home,
        LILOS_RELAY_PORT: String(stack.ports.relay),
        LILOS_FEED_PORT: String(stack.ports.feed),
        LILOS_WEB_URL: stack.webUrl,
        LILOS_STATE_DIR: stateDir,
        // #875: the folder-access step isn't this test's subject — skip the
        // OS ask the way a granted install would.
        LILOS_SKIP_FOLDER_ASK: "1",
      },
    });
    const win = await app.firstWindow();
    // A fresh window starts on Welcome; "Set up later" is its own exit.
    await win.getByRole("button", { name: "Set up later" }).click({
      timeout: 60_000,
    });
    await expect(v3Sidebar(win)).toBeVisible({ timeout: 60_000 });

    // The menu carries Settings… on ⌘,; Service Status has none.
    const menu = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.find((i) => i.label === "LilOS")
        ?.submenu?.items.map((i) => ({
          id: i.id,
          label: i.label,
          accelerator: i.accelerator,
        })),
    );
    expect(menu).toContainEqual({
      id: "settings",
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
    });
    const status = menu?.find((i) => i.id === "service-status");
    expect(status?.label).toBe("Service Status");
    // Electron reports an unset accelerator as null over evaluate.
    expect(status?.accelerator).toBeNull();

    // Clicking Settings… opens the same screen inside the app window.
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.getMenuItemById("settings")?.click(),
    );
    await expect(win).toHaveURL(/[#?&]page=settings(&|$)/, { timeout: 15_000 });
    await expect(
      win.getByRole("heading", { name: "Settings", level: 1 }),
    ).toBeVisible({ timeout: 15_000 });
    await electronScreenshot(app, win, `${SHOTS}/ac-1-desktop-settings.png`);

    // Service Status still opens its own window.
    const secondWindow = app.waitForEvent("window", { timeout: 15_000 });
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.getMenuItemById("service-status")?.click(),
    );
    const statusWin = await secondWindow;
    await expect(statusWin.locator("body")).toBeVisible({ timeout: 15_000 });
  } finally {
    await app?.close();
    await stack.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
