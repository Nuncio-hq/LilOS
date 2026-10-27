import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { allowAllWhile, expectSettled } from "./helpers/approvals";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  startChatInFolder,
  v3Peek,
} from "./helpers/stack";
import { workMenu, workStrip } from "./helpers/workbench";

/**
 * Evidence capture for #886 — the composer/access/thread-header audit fix.
 *
 * Not part of the verify suite: skipped unless `LILOS_EVIDENCE=1` is set.
 * Run locally to regenerate the PR's after screenshots (the befores live
 * beside the audit at /tmp/lilos-ux/*.png):
 *
 *   LILOS_EVIDENCE=1 bunx playwright test e2e/evidence-886.spec.ts
 *
 * Output lands in test-results/evidence/886/{wide,narrow}/{light,dark}/,
 * named after the audit shot each answers (05 home composer, 06 split
 * composers, 07 thread header + sidebar count, 10 access, 31/32 phone).
 */

test.skip(
  process.env.LILOS_EVIDENCE !== "1",
  "evidence capture only — set LILOS_EVIDENCE=1",
);

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const OUT = path.join(repo, "test-results", "evidence", "886");

/* A git folder with one uncommitted change → the header's "Changes" row. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-evid-886-"));
const repoDir = path.join(ROOT, "widgets");
mkdirSync(repoDir, { recursive: true });
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
git(["init", "-b", "trunk"]);
writeFileSync(path.join(repoDir, "readme.md"), "# widgets\n");
writeFileSync(path.join(repoDir, "notes.md"), "notes\n");
git(["add", "."]);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  /* The audit's Home is the paused-company one (the product default,
     D-#836) — the only Home with a composer, so the stack boots paused. */
  stack = await bootStack("evid-886", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    LILOS_COMPANY: "0",
  });
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});
test.describe.configure({ mode: "serial" });

const DEFAULT_AGENT = { id: "default", name: "Default" };
const shot = (page: Page, group: string, name: string) =>
  page.screenshot({
    path: path.join(OUT, group, `${name}.png`),
    fullPage: false,
  });

/** Wait for the opened thread's header + composer to be up. */
async function peekReady(page: Page) {
  const peek = v3Peek(page);
  await expect(peek.locator("[data-thread-header]")).toBeVisible({
    timeout: 45_000,
  });
  await expect(peek.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 30_000,
  });
}

/** The audit's greeting says Oscar's name — set it over the relay (the
    page must already be up for the in-page ws call), and wait for the
    greeting to redraw so the shot never catches "Me". */
async function nameOscar(page: Page) {
  await relayRpc(page, stack, "profile.update", { userName: "Oscar" });
  await expect(page.getByRole("heading", { name: /, Oscar/ })).toBeVisible({
    timeout: 15_000,
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`wide ${theme}: composer one row, one composer, access menu+confirm, header ⋯`, async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({
      viewport: { width: 1288, height: 800 },
      colorScheme: theme,
    });
    const page = await ctx.newPage();
    await page.addInitScript(
      (t) => localStorage.setItem("lilos-theme", t),
      theme,
    );
    const group = `wide-${theme}`;

    /* 05-home-first-composer-wraps → one row of controls, no git chip,
       no key hint. */
    await skipFirstRun(page);
    await page.goto(`${stack.webUrl}/#?page=home`);
    await nameOscar(page);
    await expect(page.locator("[data-composer]").first()).toBeVisible({
      timeout: 45_000,
    });
    await page
      .locator("[data-composer]")
      .getByRole("textbox")
      .waitFor({ timeout: 30_000 });
    await shot(page, group, "05-home-composer-one-row");

    /* A thread with a real change — start it, let the turn settle, and
       leave it open beside Threads. */
    writeFileSync(path.join(repoDir, "notes.md"), "notes\nchanged\n");
    const convId = await startChatInFolder(
      page,
      stack,
      DEFAULT_AGENT,
      repoDir,
      "Hi! What can you do for me today?",
    );
    await peekReady(page);
    const turn = page.locator("[data-agentturn]").last();
    await expect(turn).toBeVisible({ timeout: 60_000 });
    await allowAllWhile(page, expectSettled(turn, 120_000));

    /* 17-title-cut → first full sentence as the row/header title. */
    await shot(page, group, "07-thread-peek-title-header");

    /* 06-split-home-composer-stacked + 07-two-composers → Home beside the
       thread shows ONE composer (the thread's). */
    await page.goto(`${stack.webUrl}/#?page=home&open=thread:${convId}`);
    await peekReady(page);
    await expect(page.locator("[data-composer]")).toHaveCount(1);
    await shot(page, group, "06-split-home-one-composer");

    /* 10-access-one-click → a real menu: click opens it, nothing flips. */
    const pill = v3Peek(page).locator('[data-slot="access-pill"]');
    await pill.click();
    await expect(page.locator('[data-access-option="ask"]')).toBeVisible();
    await shot(page, group, "10a-access-menu");
    /* Full asks once, with the exact line Oscar approved. */
    await page.locator('[data-access-option="full"]').click();
    await expect(
      page.getByText("Agents run tools without asking in this thread"),
    ).toBeVisible();
    await shot(page, group, "10b-access-full-confirm");
    await page.locator("[data-access-confirm]").click();
    await expect(pill).toHaveAttribute("data-access", "full");

    /* 16-header-icons-meter → send an edit (access is already Full, so
       no ask waits); the header then names "Changes" and the ⋯ holds the
       rest. The peek's header is where they always show. */
    const peek = v3Peek(page);
    await peek
      .getByPlaceholder(/^Message /)
      .fill("Add a notes section to the readme");
    await peek.getByRole("button", { name: "Send" }).click();
    const editTurn = page.locator("[data-agentturn]").last();
    await allowAllWhile(page, expectSettled(editTurn, 120_000));
    /* Changes lives in the header or, scrolled away, the sticky bar — the
       peek scope sees whichever is live. */
    await expect(peek.locator('[data-work-tab="changes"]')).toBeVisible({
      timeout: 30_000,
    });
    await shot(page, group, "07-header-changes-inline");
    await workMenu(page).click();
    await expect(workStrip(page)).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: /Context used:/ }),
    ).toBeVisible();
    await shot(page, group, "07-workmenu-meter");
    await page.keyboard.press("Escape");

    /* The session view: the Workbench's own tab row carries the surfaces
       while it is open — the header does not repeat them. */
    await panelIntoFocus(page);
    await shot(page, group, "07-session-workbench-open");

    /* Sidebar: no Threads count (Needs you keeps its badge). */
    await shot(page, group, "07-sidebar-no-threads-count");
    await ctx.close();
  });

  test(`narrow ${theme}: sidebar behind ☰, greeting clean, composer icons`, async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: theme,
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.addInitScript(
      (t) => localStorage.setItem("lilos-theme", t),
      theme,
    );
    const group = `narrow-${theme}`;

    /* 31-phone-home → sidebar auto-hidden, greeting unclipped, the
       composer still usable with icon-only chips. */
    await skipFirstRun(page);
    await page.goto(`${stack.webUrl}/#?page=home`);
    await nameOscar(page);
    await expect(page.locator("[data-composer]").first()).toBeVisible({
      timeout: 45_000,
    });
    await shot(page, group, "31-phone-home");

    /* The ☰ pops the sidebar over the page — the hidden sidebar keeps its
       own (off-screen) toggle mounted, so aim at the toolbar's copy. */
    await page
      .locator('[data-sidebar-shortcuts] [aria-label="Show sidebar"]')
      .click();
    await shot(page, group, "31b-phone-sidebar-overlay");
    await page.keyboard.press("Escape");

    /* 32-phone-thread → a thread at 390: one-line header, icon chips. */
    await startChatInFolder(
      page,
      stack,
      DEFAULT_AGENT,
      repoDir,
      "Summarize this folder for me",
    );
    await peekReady(page);
    const turn = page.locator("[data-agentturn]").last();
    await expect(turn).toBeVisible({ timeout: 60_000 });
    await allowAllWhile(page, expectSettled(turn, 120_000));
    await shot(page, group, "32-phone-thread");
    await ctx.close();
  });
}
