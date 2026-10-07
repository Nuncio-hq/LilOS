import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
} from "./helpers/stack";

/**
 * Issue #590 — desktop polish on the DM thread surfaces:
 *
 *   AC-1 a plan's "Change…" puts the caret after the prefix in the
 *       composer; Approve/Reject clears an untouched prefix.
 *   AC-2 at 1024px the header names the employee, the composer keeps one
 *       row of controls, and icon-only tabs carry tooltips.
 *   AC-3 no internals on screen: no `lilos status --verbose`, no
 *       /private/… paths, the context meter has a real label.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-590");

/* Two fixtures:
   - homeRepoDir under ~/repos — a workbench-probe-friendly cwd: fs.tree /
     git.diff / forge.pr all answer there, so the strip carries the full
     tab set (enough to fold icons at 1024px).
   - repoDir under tmpdir resolves through /private — binding a session
     there exercises the prettyPath strip (a raw `/private/var/…` on
     screen is the internal-looking bug). */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-590-"));
const repoDir = path.join(ROOT, "lilos-repo-590");
mkdirSync(path.join(homedir(), "repos"), { recursive: true }); // ~/repos may not exist on a fresh CI runner
const HOME_ROOT = mkdtempSync(path.join(homedir(), "repos", "lilos-590-"));
const homeRepoDir = path.join(HOME_ROOT, "lilos-repo-590");
const homeRepoShown = `~/repos/${path.basename(HOME_ROOT)}/lilos-repo-590`;
mkdirSync(repoDir);
mkdirSync(homeRepoDir);
for (const d of [repoDir, homeRepoDir]) {
  execSync(
    "git init -b trunk && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
    { cwd: d },
  );
}
const realRepoDir = realpathSync(repoDir); // /private/var/folders/…

const PANEL_URL = /\/dm\/[^/]+\/conv_[^/]+$/;

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac590", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

async function dmDefault(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(stack.webUrl);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  await aside
    .getByRole("button", { name: /default/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
}

const send = async (page: Page, text: string) => {
  const box = page.locator("main textarea").first();
  await box.fill(text);
  await box.press("Enter");
};

const panel = (page: Page) => page.locator("[data-thread-panel]");
const picker = (page: Page) => page.locator('[data-ws="folder"]');

test("AC-1 plan 'Change…' focuses the composer after the prefix; Approve clears an untouched prefix", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);
  await send(page, "plan: propose — polish check");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  const card = panel(page).locator("[data-plan]").last();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toHaveAttribute("data-planstatus", "proposed");

  /* "Change…" prefills the thread composer and puts the caret AFTER the
     prefix — Oscar starts typing his change, not at its start. */
  await card.getByRole("button", { name: "Change…" }).click();
  const box = panel(page).locator("textarea").last();
  await expect(box).toHaveValue("Change the plan: ", { timeout: 15_000 });
  await expect(box).toBeFocused();
  const caret = await box.evaluate(
    (el: HTMLTextAreaElement) => el.selectionStart,
  );
  expect(caret).toBe("Change the plan: ".length);
  await page.screenshot({ path: `${SHOTS}/ac-1-change-prefill.png` });

  /* Approve while the prefix is untouched — the dead prompt clears instead
     of sitting in the composer to edit a decided plan. */
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(box).toHaveValue("", { timeout: 15_000 });
  await expect(card).toHaveAttribute("data-planstatus", "approved");
  await page.screenshot({ path: `${SHOTS}/ac-1-approve-clears.png` });
});

test("AC-2 at 1024px the header names the employee, the composer stays one row, icon-only tabs have tooltips", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1024, height: 700 });
  await dmDefault(page);

  /* A home-folder repo so every workbench probe answers — the strip then
     carries enough tabs to fold at 1024px. Type the `~/x` path straight
     in: it resolves through fs.list. */
  await picker(page).click();
  const menu = page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
  await menu.getByText("Add a folder").click();
  const dialog = page.locator("[data-addfolder]");
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-pathinput]").fill(homeRepoShown);
  await expect(dialog.locator("[data-folderinfo]")).toContainText("Git repo", {
    timeout: 30_000,
  });
  await dialog.locator("[data-addbtn]").click();
  await expect(dialog).toHaveCount(0);
  await expect(picker(page)).toContainText("lilos-repo-590", {
    timeout: 15_000,
  });

  await send(page, "build the readme section");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await panelIntoFocus(page);

  /* The header names the employee — "DM · <name>" sits beside the avatar. */
  await expect(page.locator("main header")).toContainText(/DM · \w+/, {
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-header-1024.png` });

  /* Composer controls stay on one row — nothing overflows the footer's
     width (the hint truncates first instead of wrapping). */
  const footer = page
    .locator("main form")
    .locator("[data-slot='input-group-addon']")
    .last();
  await expect(footer).toBeVisible();
  const overflows = await footer.evaluate(
    (el) => el.scrollWidth - el.clientWidth,
  );
  expect(overflows).toBeLessThanOrEqual(1);

  /* Workbench tabs that fold to icons still announce themselves — a title
     tooltip per icon-only tab (the strip marks folded tabs .wb-fold). The
     panel's open state is seeded at Focus mount, which can precede the
     conversation's folder landing — open it via the header toggle when
     the strip isn't up already. */
  const wbTabs = page.locator("[data-wb-tab]");
  const wbToggle = page.locator("main header").getByTitle("Workbench");
  await expect(wbToggle).toBeVisible({ timeout: 30_000 });
  /* The seeded-open check can race the mount — a first click lands before
     wbOpen seeds and toggles it back off. Click until the strip shows. */
  for (let i = 0; i < 4 && !(await wbTabs.first().isVisible()); i++) {
    await wbToggle.click();
    await page.waitForTimeout(1500);
  }
  await expect(wbTabs.first()).toBeVisible({ timeout: 45_000 });
  const folded = page.locator("[data-wb-tab].wb-fold");
  await expect(folded.first()).toBeVisible({ timeout: 15_000 });
  const foldedCount = await folded.count();
  for (let i = 0; i < foldedCount; i++) {
    await expect(folded.nth(i)).toHaveAttribute("title", /./);
    await expect(folded.nth(i)).toHaveAttribute("aria-label", /./);
  }
  await page.screenshot({ path: `${SHOTS}/ac-2-tabs-1024.png` });
});

test("AC-3 no internals on screen: Status reads plain, no /private paths, the context meter is labelled", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);

  /* Status dialog: the legs read plain — no `lilos status --verbose`
     invocation shown to a non-terminal user. */
  await page.getByRole("button", { name: "System status" }).click();
  const dialog = page.getByRole("dialog", { name: "System status" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).not.toContainText(/lilos status/);
  await expect(dialog).not.toContainText(/--verbose/);
  await page.screenshot({ path: `${SHOTS}/ac-3-status-plain.png` });
  await dialog.getByRole("button", { name: "Close" }).click();

  /* A session bound under /private/… — its folder shows on screen pretty,
     never the raw realpath (~/… for home paths, /var/… without the
     /private prefix for system tmp). */
  await picker(page).click();
  const menu = page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
  await menu.getByText("Add a folder").click();
  const addDialog = page.locator("[data-addfolder]");
  await expect(addDialog).toBeVisible();
  /* Same trick: type the /private/… realpath — discovery's `?roots=`
     override races the boot redirect, the typed input doesn't. */
  await addDialog.locator("[data-pathinput]").fill(realRepoDir);
  await expect(addDialog.locator("[data-folderinfo]")).toContainText(
    "Git repo",
    { timeout: 30_000 },
  );
  await addDialog.locator("[data-addbtn]").click();
  await expect(addDialog).toHaveCount(0);
  await send(page, "look around");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await panelIntoFocus(page);
  // Nowhere in the session view should "/private/…" leak.
  await expect(page.locator("main")).not.toContainText("/private/", {
    timeout: 30_000,
  });

  /* The context meter reads like a person, not a raw "3.5%". */
  const meter = page.locator("[title^='Context used:']").first();
  await expect(meter).toBeVisible({ timeout: 60_000 });
  await expect(meter).toHaveAttribute(
    "title",
    /^Context used: \d+(\.\d+)?% of ~?\d/,
  );
  await page.screenshot({ path: `${SHOTS}/ac-3-no-internals.png` });
});
