import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { wport } from "./ports";

/**
 * Issue #132 — Settings (⌘,): one place for profile, editors, models,
 * status, updates. AC-1 ⌘, opens Settings and Service Status stays its own
 * menu item; AC-2 the prototype's SettingsView renders General, Editors,
 * Models, Approvals, Status and About with real data (#106 landed the
 * Approvals section: Smart/Manual/Off policy + the default access).
 * #106); AC-3 edits apply live across open windows; AC-4 About shows real
 * versions and the update control only exists on the desktop build;
 * AC-5 the sidebar's gear entry point opens the same screen.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");
const desktopDir = path.join(repo, "apps", "desktop");
const FAKE_OS = path.join(here, "os-fake");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";

const SHOTS = path.join(repo, "test-results", "ac-132");

interface Stack {
  home: string;
  webUrl: string;
  relayPort: number;
  feedPort: number;
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
      LILOS_USER_NAME: "Test User",
      // os.editors sees the committed fake Cursor/Zed bundles (AC-2 Editors).
      LILOS_APP_DIRS: path.join(FAKE_OS, "Applications"),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    await waitForHttp(webUrl);
    await waitForHttp(`http://127.0.0.1:${ports.relay}`);
    return {
      home,
      webUrl,
      relayPort: ports.relay,
      feedPort: ports.feed,
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

const settingsDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Settings" });
const tab = (page: Page, name: string) =>
  settingsDialog(page).getByRole("tab", { name, exact: true });

const openSettings = async (page: Page) => {
  await page.locator("aside").getByRole("button", { name: "Settings" }).click();
  await expect(settingsDialog(page)).toBeVisible();
};

test.describe.configure({ mode: "serial" });

test("AC-1+AC-5 Settings opens via ⌘, and the sidebar gear; Approvals listed", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await bootStack("ac132a", {
    relay: wport(4690),
    feed: wport(4691),
    web: wport(5372),
  });
  try {
    await page.addInitScript(() =>
      localStorage.setItem("lilos-onboarded", "1"),
    );
    await page.goto(`${stack.webUrl}/`);
    await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });

    // AC-5: the sidebar's entry point.
    await openSettings(page);
    await expect(tab(page, "General")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-5-sidebar-entry.png` });
    // Esc closes.
    await page.keyboard.press("Escape");
    await expect(settingsDialog(page)).toHaveCount(0);

    // AC-1: the ⌘, shortcut (Control+, — the handler takes meta or ctrl).
    await page.keyboard.press("Control+,");
    await expect(settingsDialog(page)).toBeVisible();

    // Every section with real data is listed — Approvals too since #106
    // (the fake engine declares approval_policy).
    for (const name of [
      "General",
      "Approvals",
      "Editors",
      "Models",
      "Status",
      "About",
    ]) {
      await expect(tab(page, name)).toBeVisible();
    }
    await page.screenshot({ path: `${SHOTS}/ac-1-sections.png` });
  } finally {
    await stack.stop();
  }
});

test("AC-2 every section renders real data", async ({ page }) => {
  test.setTimeout(120_000);
  const stack = await bootStack("ac132b", {
    relay: wport(4692),
    feed: wport(4693),
    web: wport(5348),
  });
  try {
    await page.addInitScript(() =>
      localStorage.setItem("lilos-onboarded", "1"),
    );
    await page.goto(`${stack.webUrl}/`);
    await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
    await openSettings(page);

    // General: the OS-derived identity is prefilled.
    await tab(page, "General").click();
    const panel = settingsDialog(page).getByRole("tabpanel");
    await expect(panel.getByLabel("Your name")).toHaveValue("Test User");
    await expect(panel.getByLabel("Company name")).toHaveValue("Test's Co");

    // Editors: the fake Cursor/Zed bundles are detected; the default leads.
    await tab(page, "Editors").click();
    const editorRows = panel.getByRole("radiogroup", {
      name: "Default editor",
    });
    await expect(editorRows.getByRole("radio")).toHaveCount(2);
    await expect(editorRows).toContainText("Cursor");
    await expect(editorRows).toContainText("Zed");
    await expect(
      editorRows.getByRole("radio", { name: /Cursor/ }),
    ).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: `${SHOTS}/ac-2-editors.png` });

    // Models: the fake engine's catalog shows up with the visibility count.
    await tab(page, "Models").click();
    await expect(panel).toContainText("models visible");
    await expect(
      panel.getByRole("button", { name: "Manage models…" }),
    ).toBeVisible();

    // Status: the real legs list.
    await tab(page, "Status").click();
    await expect(panel).toContainText("Relay");
    await expect(
      panel.getByRole("button", { name: "Copy diagnostics" }),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-2-status.png` });

    // About: real versions — the relay/harness report theirs.
    await tab(page, "About").click();
    await expect(panel).toContainText("LilOS");
    await expect(panel).toContainText(/relay \d+\.\d+\.\d+/);
    await page.screenshot({ path: `${SHOTS}/ac-4-about.png` });
  } finally {
    await stack.stop();
  }
});

test("AC-3 edits in one window land live in another", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("ac132c", {
    relay: wport(4694),
    feed: wport(4695),
    web: wport(5349),
  });
  try {
    await context.addInitScript(() =>
      localStorage.setItem("lilos-onboarded", "1"),
    );
    await page.goto(`${stack.webUrl}/`);
    await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
    const page2 = await context.newPage();
    await page2.goto(`${stack.webUrl}/`);
    await expect(page2).toHaveURL(/\/dm\//, { timeout: 30_000 });

    await openSettings(page);
    await openSettings(page2);

    // A name typed in window 1 lands in window 2's field and sidebar.
    const name1 = settingsDialog(page)
      .getByRole("tabpanel")
      .getByLabel("Your name");
    await name1.fill("Ada");
    await expect(
      settingsDialog(page2).getByRole("tabpanel").getByLabel("Your name"),
    ).toHaveValue("Ada", { timeout: 15_000 });
    await expect(page2.locator("aside")).toContainText("Ada");

    // The default-editor pick lands in the relay KV and in window 2.
    await tab(page, "Editors").click();
    await settingsDialog(page)
      .getByRole("tabpanel")
      .getByRole("radio", { name: /Zed/ })
      .click();
    await expect
      .poll(() => storedSetting(stack.home, "defaultEditor"), {
        timeout: 10_000,
      })
      .toBe("zed");
    await tab(page2, "Editors").click();
    await expect(
      settingsDialog(page2)
        .getByRole("tabpanel")
        .getByRole("radio", { name: /Zed/ }),
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
  const stack = await bootStack("ac132shots", {
    relay: wport(4700),
    feed: wport(4701),
    web: wport(5359),
  });
  try {
    await page.setViewportSize({ width: 1288, height: 700 });
    await page.addInitScript(() =>
      localStorage.setItem("lilos-onboarded", "1"),
    );
    await page.goto(`${stack.webUrl}/`);
    await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
    await openSettings(page);
    await expect(tab(page, "Editors")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/shot-1288-light.png` });

    await page.setViewportSize({ width: 900, height: 700 });
    await page.screenshot({ path: `${SHOTS}/shot-900-light.png` });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${SHOTS}/shot-1440-light.png` });

    // Dark: same screen, the theme the app actually persists.
    await page.evaluate(() => localStorage.setItem("lilos-theme", "dark"));
    await page.setViewportSize({ width: 1288, height: 700 });
    await page.reload();
    await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
    await openSettings(page);
    await expect(tab(page, "Editors")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/shot-1288-dark.png` });
  } finally {
    await stack.stop();
  }
});

test("AC-4 on plain web the update control does not render", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await bootStack("ac132d", {
    relay: wport(4696),
    feed: wport(4697),
    web: wport(5350),
  });
  try {
    await page.addInitScript(() =>
      localStorage.setItem("lilos-onboarded", "1"),
    );
    await page.goto(`${stack.webUrl}/`);
    await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
    await openSettings(page);
    await tab(page, "About").click();
    const panel = settingsDialog(page).getByRole("tabpanel");
    await expect(panel).toContainText("LilOS");
    await expect(
      panel.getByRole("button", { name: "Check for updates" }),
    ).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

test("AC-1 the desktop menu opens Settings on ⌘, and Service Status stays", async () => {
  test.setTimeout(180_000);
  const stack = await bootStack("ac132e", {
    relay: wport(4698),
    feed: wport(4817),
    web: wport(5352),
  });
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
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
    app = await _electron.launch({
      args:
        process.platform === "linux"
          ? [desktopDir, "--no-sandbox"]
          : [desktopDir],
      env: {
        ...process.env,
        LILOS_RELAY_HOME: stack.home,
        LILOS_RELAY_PORT: String(stack.relayPort),
        LILOS_FEED_PORT: String(stack.feedPort),
        LILOS_WEB_URL: stack.webUrl,
      },
    });
    const win = await app.firstWindow();
    await expect(win.locator("aside")).toBeVisible({ timeout: 60_000 });

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
    await expect(win.getByRole("dialog", { name: "Settings" })).toBeVisible({
      timeout: 15_000,
    });
    await win.screenshot({ path: `${SHOTS}/ac-1-desktop-settings.png` });

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
  }
});
