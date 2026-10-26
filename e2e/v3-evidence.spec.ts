import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";
import { openWorkbench } from "./helpers/workbench";

/**
 * Screenshot evidence for the v3 shell (replaces the old chrome's
 * group-c-shots): first run, Home, Needs you, Threads, a thread's session
 * view, People, Hire and Settings, light and dark, at 1288x900. PNGs land in
 * test-results/evidence/v3/<theme>/ for the PR body.
 *
 * Every shot follows an assertion that the surface it names is really on
 * screen with the data it should show (a running company, not a blank page),
 * so the evidence cannot go stale silently. The flow is one company's first
 * day: it is also a smoke run of the whole shell on the real stack.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const OUT = path.join(repo, "test-results", "evidence", "v3");
const SIZE = { width: 1288, height: 900 };

/** Shots per theme: the surfaces the PR names, in the order the flow reaches
 *  them. */
const SHOTS = [
  "first-run-you",
  "first-run-engine",
  "home",
  "needs-you",
  "threads-board",
  "thread-session",
  "people",
  "hire",
  "settings-general",
  "settings-engine",
] as const;

test.describe.configure({ mode: "serial" });

for (const theme of ["light", "dark"] as const) {
  test(`v3 surfaces on a first day — ${theme}`, async ({ page }) => {
    test.setTimeout(420_000);
    const dir = path.join(OUT, theme);
    mkdirSync(dir, { recursive: true });
    /* Each shot is checked the moment it is written: Playwright wipes
       test-results/ at the start of every run, so a later directory listing
       would also fail when another run starts beside this one. */
    const taken = new Set<string>();
    const shot = async (name: (typeof SHOTS)[number]) => {
      /* The page fades in (0.25s) and Playwright counts a half-faded element
         as visible: wait for every finite animation to end, and for the
         "All set" notice to go, so the picture is the settled surface. (A
         spinner repeats forever and is left running.) */
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter(
              (a) =>
                a.effect?.getComputedTiming().iterations !==
                Number.POSITIVE_INFINITY,
            )
            .map((a) => a.finished.catch(() => {})),
        ),
      );
      await expect(page.locator("[data-toast]")).toHaveCount(0, {
        timeout: 10_000,
      });
      const file = path.join(dir, `${name}.png`);
      await page.screenshot({ path: file });
      expect(
        statSync(file).size,
        `${name}.png is a real picture`,
      ).toBeGreaterThan(10_000);
      taken.add(name);
    };
    const main = (p: Page) => p.locator("#v3-main");
    const stack = await bootStack(`v3shot-${theme[0]}`, await pickPorts(), {
      LILOS_USER_NAME: "Test User",
    });
    try {
      await page.setViewportSize(SIZE);
      await page.addInitScript(
        (t) => localStorage.setItem("lilos-theme", t),
        theme,
      );

      /* First run: a fresh home shows Welcome alone, in the theme asked for. */
      await page.goto(`${stack.webUrl}/`);
      await expect(
        page.getByRole("heading", { name: "Welcome to LilOS" }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("html")).toHaveClass(
        theme === "dark" ? /dark/ : /^(?!.*dark)/,
      );
      await expect(page.getByLabel("Your name")).toHaveValue("Test User");
      await shot("first-run-you");
      await page.getByRole("button", { name: "Next" }).click();
      const legs = page.locator("[data-first-run-step]");
      await expect(legs.nth(0)).toHaveAttribute("data-state", "ok", {
        timeout: 30_000,
      });
      await expect(legs.nth(1)).toHaveAttribute("data-state", "ok", {
        timeout: 60_000,
      });
      await expect(legs.nth(1)).toContainText("Engine-fake", {
        timeout: 30_000,
      });
      await shot("first-run-engine");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByLabel("Name", { exact: true }).fill("Ada");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Open my company" }).click();

      /* Home: the first agent, idle, nothing waiting. */
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Good afternoon, Test User",
        { timeout: 30_000 },
      );
      await expect(main(page)).toContainText("Nothing needs you.");
      await expect(
        main(page).getByRole("button", { name: /Ada/ }),
      ).toContainText("Idle");
      await shot("home");

      /* A chat whose first edit asks: Needs you has one ask, Threads one card. */
      const first = v3Sidebar(page).getByRole("button", { name: /Ada/ });
      await first.click();
      const id = decodeURIComponent(
        /open=agent:([^&,]+)/.exec(page.url())?.[1] ?? "",
      );
      expect(id).not.toBe("");
      const convId = await startChat(
        page,
        stack.webUrl,
        { id, name: "Ada" },
        "Add a footer to the page",
      );
      await expect(
        v3Sidebar(page).getByRole("button", { name: /^Needs you\s*1$/ }),
      ).toBeVisible({ timeout: 60_000 });
      await v3Sidebar(page)
        .getByRole("button", { name: /^Needs you/ })
        .click();
      await expect(main(page).getByText("1 waiting on you")).toBeVisible();
      await expect(main(page)).toContainText("patch wants to run");
      await shot("needs-you");

      await v3Sidebar(page)
        .getByRole("button", { name: /^Threads/ })
        .click();
      const asking = main(page)
        .getByRole("button")
        .filter({ hasText: /add a footer to the page/i })
        .first();
      await expect(asking).toContainText("Needs you");
      /* The merged list's row carries the pill; the ask card with its
         answers lives inside the thread (#862). */
      await asking.click();
      await expect(
        v3Peek(page)
          .locator("[data-ask-id]")
          .first()
          .getByRole("button", { name: "Deny" }),
      ).toBeVisible({ timeout: 30_000 });
      await v3Peek(page).getByRole("button", { name: "Close" }).click();
      await shot("threads-board");

      /* Approve until the turn finishes, then open its session view. */
      await v3Sidebar(page)
        .getByRole("button", { name: /^Needs you/ })
        .click();
      const approve = main(page).getByRole("button", {
        name: "Approve",
        exact: true,
      });
      await expect(async () => {
        if (await approve.isVisible()) await approve.click();
        await expect(
          main(page).getByText("Finished", { exact: true }),
        ).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 120_000 });
      await page.goto(`${stack.webUrl}/#?page=threads&open=thread:${convId}`);
      await panelIntoFocus(page);
      await expect(
        v3Peek(page).getByTitle("Narrow, back beside the page"),
      ).toBeVisible();
      await expect(page.locator("[data-thread-panel]")).toContainText(
        "Add a footer to the page",
      );
      await openWorkbench(page);
      await expect(page.locator("[data-wb-tab]").first()).toBeVisible({
        timeout: 30_000,
      });
      await shot("thread-session");

      /* People, Hire (a role picked, the form filled) and Settings. */
      await page.goto(`${stack.webUrl}/#?page=people`);
      await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
        "People",
      );
      await expect(
        main(page).getByRole("button", { name: /Ada/ }),
      ).toBeVisible();
      await shot("people");

      await page.goto(`${stack.webUrl}/#?page=hire`);
      await main(page)
        .getByRole("button", { name: /Researcher/ })
        .click();
      await main(page).getByPlaceholder("Name").fill("Nova");
      await expect(
        main(page).getByRole("button", { name: "Hire", exact: true }),
      ).toBeVisible();
      await shot("hire");

      await page.goto(`${stack.webUrl}/#?page=settings&view=general`);
      await expect(main(page)).toContainText("Test's Co", { timeout: 30_000 });
      await shot("settings-general");
      await page.goto(`${stack.webUrl}/#?page=settings&view=engine`);
      await expect(main(page)).toContainText("Engine-fake", {
        timeout: 30_000,
      });
      await expect(main(page)).toContainText("Connected");
      await shot("settings-engine");

      /* Every surface the PR names was captured, once. */
      expect([...taken].sort()).toEqual([...SHOTS].sort());
    } finally {
      await stack.stop();
    }
  });
}
