import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, freePort, type Stack } from "./helpers/stack";

/**
 * Issue #110 — "Open in <editor>" / "Reveal in Finder" on the real stack
 * (relay + harness + vite dev, engine-fake). The spawned stack inherits
 * LILOS_APP_DIRS pointing at the committed fake Cursor.app/Zed.app bundles
 * (e2e/os-fake), a fake `open` earlier on PATH, and LILOS_OPEN_LOG where
 * every fake binary records its argv — so a menu click proves the REAL
 * `os.open` end to end, not a stub. AC-5's "no host method → no controls"
 * leg stubs `host.describe` at the network layer (page.route), exactly
 * what a harness without os.open would answer.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
/* Kernel-assigned ports: bound-and-probed free ports per stack (#484). */

const SHOTS = path.join(repo, "test-results", "ac-110");

/* Committed fakes: Cursor.app + Zed.app bundles, and a fake `open` on PATH. */
const FAKE_OS = path.join(repo, "e2e", "os-fake");
const LOG_DIR = path.join(repo, "e2e", ".os-fake");
const LOG = path.join(LOG_DIR, "open.log");
mkdirSync(LOG_DIR, { recursive: true });

/* Real fixture dirs: a git repo on `trunk` — the session's folder. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-110-"));
// realpath: /var → /private/var on macOS, and os.open logs the resolved path.
const repoDir = realpathSync(
  mkdirSync(path.join(ROOT, "lilos-repo-110"), { recursive: true })!,
);
execSync(
  "git init -b trunk && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
  { cwd: repoDir },
);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  writeFileSync(LOG, "");
  stack = await bootStack(
    "ac110",
    {
      relay: await freePort(),
      feed: await freePort(),
      web: await freePort(),
    },
    {
      // os.editors sees the fake bundles; os.open's `open` resolves to the
      // fake bin — both write argv lines to LOG.
      LILOS_APP_DIRS: path.join(FAKE_OS, "Applications"),
      LILOS_OPEN_LOG: LOG,
      PATH: `${path.join(FAKE_OS, "bin")}:${process.env.PATH}`,
    },
  );
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

async function dmDefault(page: Page) {
  await page.goto(`${stack.webUrl}/?roots=${ROOT}`);
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

/** Add the fixture repo through the web dialog, then start a session on it.
    Serial legs share recents, so pick the known row when it's already there. */
async function sessionOnRepo(page: Page) {
  const picker = page.locator('[data-ws="folder"]');
  await picker.click();
  const menu = page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
  const known = menu.locator(`[data-wsfolder="${repoDir}"]`);
  const hasKnown = await known
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (hasKnown) {
    await known.click();
  } else {
    await menu.getByText("Add a folder").click();
    const dialog = page.locator("[data-addfolder]");
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-pathinput]").fill(repoDir);
    await expect(dialog.locator("[data-folderinfo]")).toContainText(
      "Git repo",
      { timeout: 15_000 },
    );
    await dialog.locator("[data-addbtn]").click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(picker).toContainText("lilos-repo-110");
  await page.locator("textarea").first().fill("hello — give me a session");
  await page.locator("textarea").first().press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);
  const badge = page.locator("[data-wsbadge]");
  await expect(badge).toContainText("lilos-repo-110", { timeout: 15_000 });
  return badge;
}

const logLines = () => readFileSync(LOG, "utf8").split("\n").filter(Boolean);
/* Wait out the menu's fade-in so captures are fully opaque. */
const openMenuSettled = async (page: Page) => {
  const m = page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
  await expect(m).toBeVisible();
  await expect(m).toHaveCSS("opacity", "1");
  return m;
};

/* PR screenshots are reviewed at 1288x700. */
test.use({ viewport: { width: 1288, height: 700 } });

test("AC-1 + AC-5 the folder badge is a menu listing the detected editors, default first", async ({
  page,
}) => {
  await dmDefault(page);
  const badge = await sessionOnRepo(page);
  // os.open exists on this host → the badge is a button that opens the menu.
  await expect(badge).toHaveRole("button", { timeout: 15_000 });
  await badge.click();
  const menu = await openMenuSettled(page);
  const items = menu.locator("[data-openwith]");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute("data-openwith", "cursor");
  await expect(items.nth(0)).toContainText("Open in Cursor");
  await expect(items.nth(1)).toHaveAttribute("data-openwith", "zed");
  await expect(items.nth(1)).toContainText("Open in Zed");
  await expect(items.nth(2)).toHaveAttribute("data-openwith", "finder");
  await expect(items.nth(2)).toContainText("Reveal in Finder");
  await page.screenshot({ path: `${SHOTS}/ac-1-menu.png` });
  await page.keyboard.press("Escape");
});

test("AC-2 + AC-4 Open in Zed runs the Zed CLI on the session folder (no shell)", async ({
  page,
}) => {
  await dmDefault(page);
  const badge = await sessionOnRepo(page);
  await expect(badge).toHaveRole("button", { timeout: 15_000 });
  await badge.click();
  await (await openMenuSettled(page)).locator('[data-openwith="zed"]').click();
  await expect
    .poll(() => logLines().join("|"), { timeout: 10_000 })
    .toContain(`arg:${repoDir}`);
  const idx = logLines().indexOf("exec:cli");
  expect(idx).toBeGreaterThanOrEqual(0);
  // Zed's cli takes the bare path (folder open — no :line here).
  expect(logLines()[idx + 1]).toBe(`arg:${repoDir}`);
  // "Open in Cursor" uses `cursor -g <folder>` (the -g syntax, no line).
  await badge.click();
  await (await openMenuSettled(page))
    .locator('[data-openwith="cursor"]')
    .click();
  await expect
    .poll(() => logLines().join("|"), { timeout: 10_000 })
    .toContain("exec:cursor");
  const ci = logLines().indexOf("exec:cursor");
  expect(logLines()[ci + 1]).toBe("arg:-g");
  expect(logLines()[ci + 2]).toBe(`arg:${repoDir}`);
  await page.screenshot({ path: `${SHOTS}/ac-2-open-zed.png` });
});

test("AC-3 Reveal in Finder runs `open -R` on the session folder", async ({
  page,
}) => {
  await dmDefault(page);
  const badge = await sessionOnRepo(page);
  await expect(badge).toHaveRole("button", { timeout: 15_000 });
  await badge.click();
  await (await openMenuSettled(page))
    .locator('[data-openwith="finder"]')
    .click();
  await expect
    .poll(() => logLines().join("|"), { timeout: 10_000 })
    .toContain("exec:open");
  const i = logLines().indexOf("exec:open");
  expect(logLines()[i + 1]).toBe("arg:-R");
  expect(logLines()[i + 2]).toBe(`arg:${repoDir}`);
  await page.screenshot({ path: `${SHOTS}/ac-3-finder.png` });
});

test("AC-5 without os.open the badge is a plain label; without editors the menu is Reveal-only", async ({
  page,
}) => {
  // Leg 1: the host answers describe without os.open → no menu at all.
  await page.route("**/host", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      id?: number;
      method?: string;
    };
    if (body.method === "host.describe")
      return route.fulfill({
        json: {
          jsonrpc: "2.0",
          id: body.id,
          result: { api: 1, methods: ["fs.list", "git.branches"] },
        },
      });
    return route.continue();
  });
  await dmDefault(page);
  const badge = await sessionOnRepo(page);
  await expect(badge).toContainText("lilos-repo-110");
  await expect(badge).not.toHaveRole("button");
  await expect(page.locator("[data-openpath]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-5-no-osopen.png` });
  await page.unroute("**/host");

  // Leg 2: os.open exists but os.editors found none → Reveal in Finder only.
  await page.route("**/host", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      id?: number;
      method?: string;
    };
    if (body.method === "os.editors")
      return route.fulfill({
        json: { jsonrpc: "2.0", id: body.id, result: { editors: [] } },
      });
    return route.continue();
  });
  await page.reload();
  const badge2 = page.locator("[data-wsbadge]");
  await expect(badge2).toContainText("lilos-repo-110", { timeout: 15_000 });
  await expect(badge2).toHaveRole("button");
  await badge2.click();
  const menu2 = await openMenuSettled(page);
  const items = menu2.locator("[data-openwith]");
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toHaveAttribute("data-openwith", "finder");
  await page.screenshot({ path: `${SHOTS}/ac-5-no-editors.png` });
});
