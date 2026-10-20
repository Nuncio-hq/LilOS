import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectSettled } from "./helpers/approvals";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChatInFolder,
  threadUrl,
} from "./helpers/stack";

/**
 * Issue #578 — rewind is no longer one-click destructive. The affordance
 * moved off the permanent "Rewind to here" row onto a hover button on your
 * own message (no line above every message). Clicking rewinds visually at
 * once — rows drop, the composer reseeds — and a 10 s "Undo" toast is the
 * real safeguard: Undo puts messages and files back exactly; only when the
 * window closes does `conversations.rewind` commit (files + engine memory).
 * A send in the same thread settles the window early.
 *
 * Same folder fixture as ac-134: a real git repo the shadow store must
 * never touch. (The old prototype leg, AC-578-5, went with the prototype's
 * old default screen.)
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-578");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQI12P8z/CfAQMwMCooKOgDAu2zC+h6pBe+AAAAAElFTkSuQmCC",
  "base64",
);

const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-578-"));
const repoDir = path.join(ROOT, "lilos-repo");
const SEED_TEXT = "seed line\n";
const NOTES_TEXT = "notes v1\n";
mkdirSync(repoDir);
execSync(
  `git init -b trunk && git -c user.email=t@t -c user.name=t commit --allow-empty -m init`,
  { cwd: repoDir },
);
writeFileSync(path.join(repoDir, "seed.txt"), SEED_TEXT);
writeFileSync(path.join(repoDir, "notes.md"), NOTES_TEXT);
execSync("git add -A && git -c user.email=t@t -c user.name=t commit -m files", {
  cwd: repoDir,
});
const gitDigest = () =>
  execSync("git status --porcelain && git rev-parse HEAD && git stash list", {
    cwd: repoDir,
  }).toString();
const CLEAN_GIT = gitDigest();

let stackA: Stack;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  stackA = await bootStack("rwu", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stackA?.stop();
});

test.describe.configure({ mode: "serial" });

/* The seeded employee. An id that names nobody opens the new-chat draft on
   the default agent, which on this one-agent stack is Default. */
const DEFAULT_AGENT = { id: "default", name: "Default" };

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

/* Match text inside a user-turn row only — engine-fake echoes the user's
   words inside its scripted <li> reply, so a thread-wide getByText sees
   the echo as a second match after the row is restored. */
const rowText = (scope: Locator, text: string | RegExp) =>
  scope.locator("[data-userturn]").getByText(text);

const toast = (page: Page) => page.locator("[data-toast]");
const undoBtn = (page: Page) => page.locator("[data-toast-action]");
const box = (page: Page) => page.locator("textarea").last();

let convA = "";

test("AC-578-1 the affordance lives on the message, revealed on hover — no line above every message", async ({
  page,
}) => {
  test.setTimeout(180_000);
  convA = await startChatInFolder(
    page,
    stackA,
    DEFAULT_AGENT,
    repoDir,
    "alpha marker one",
  );
  await panelIntoFocus(page);
  await expect(
    page.locator("[data-thread]").getByText("If you want me to change code"),
  ).toBeVisible({ timeout: 60_000 });
  await send(page, "beta marker two");
  await expect(
    rowText(page.locator("[data-thread]"), "beta marker two"),
  ).toBeVisible({ timeout: 60_000 });

  /* One trigger per user message, each inside its own row (absolute on the
     row, opacity 0 until hover) — before: no always-visible rewind line. */
  const triggers = page.locator("[data-rewind]");
  await expect(triggers).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    const wrap = triggers.nth(i).locator("..");
    await expect(wrap).toHaveCSS("position", "absolute");
    await expect(wrap).toHaveCSS("opacity", "0");
  }
  await page.screenshot({ path: `${SHOTS}/ac-1-no-line.png` });

  /* Hover the ROW, not the trigger: the trigger re-renders when its turn
     settles (title "Stop the running turn first" → "Rewind…"), which can
     drop a hover that landed mid-swap. group-hover on the row is what
     reveals it anyway. Let beta's reply settle first: while it streams in,
     the transcript keeps growing and scrolling, so the row slides out from
     under the parked pointer and the hover is lost (opacity peaks, then
     falls back to 0). */
  await expectSettled(page.locator("[data-thread] [data-agentturn]").nth(1));
  const betaRow = triggers.nth(1).locator("..");
  /* force: the invisible (opacity-0) trigger intercepts the pointer point
     over the row — but any hover inside the group still reveals it. */
  await rowText(page.locator("[data-thread]"), "beta marker two").hover({
    force: true,
  });
  await expect(betaRow).toHaveCSS("opacity", "1", { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-hover.png` });
});

test("AC-578-2 Undo restores messages exactly — nothing committed yet", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  await page.goto(threadUrl(stackA.webUrl, convA, true));
  const thread = page.locator("[data-thread]");
  await expect(rowText(thread, "beta marker two")).toBeVisible({
    timeout: 30_000,
  });

  /* The "agent's writes", faked locally — the commit restores them, so
     Undo must leave them in place. */
  writeFileSync(path.join(repoDir, "marker.txt"), "made after turn 2\n");
  writeFileSync(path.join(repoDir, "notes.md"), "notes v2 EDITED\n");
  unlinkSync(path.join(repoDir, "seed.txt"));

  // A typed draft proves Undo restores the composer, not just the rows.
  await box(page).fill("draft before the rewind");

  await rowText(thread, "beta marker two").hover({ force: true });
  await thread.locator("[data-rewind]").nth(1).click();

  // Visual rewind at once: the tail drops, the composer takes the text.
  await expect(rowText(thread, "beta marker two")).toHaveCount(0);
  await expect(rowText(thread, "alpha marker one")).toBeVisible();
  await expect(box(page)).toHaveValue("beta marker two");
  await expect(toast(page)).toBeVisible();
  await expect(undoBtn(page)).toHaveText("Undo");
  await page.screenshot({ path: `${SHOTS}/ac-2-undo-toast.png` });

  // Nothing committed: the files are still in their edited state.
  expect(existsSync(path.join(repoDir, "marker.txt"))).toBe(true);

  await undoBtn(page).click();
  await expect(rowText(thread, "beta marker two")).toBeVisible({
    timeout: 15_000,
  });
  await expect(rowText(thread, "alpha marker one")).toBeVisible();
  await expect(box(page)).toHaveValue("draft before the rewind");
  await expect(toast(page)).toContainText("Rewind undone", {
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-restored.png` });

  // Files were never touched — marker still there, seed still gone.
  expect(existsSync(path.join(repoDir, "marker.txt"))).toBe(true);
  expect(existsSync(path.join(repoDir, "seed.txt"))).toBe(false);
});

test("AC-578-3 a send settles the window — the rewind commits for real", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  await page.goto(threadUrl(stackA.webUrl, convA, true));
  const thread = page.locator("[data-thread]");
  await expect(rowText(thread, "beta marker two")).toBeVisible({
    timeout: 30_000,
  });
  await rowText(thread, "beta marker two").hover({ force: true });
  await thread.locator("[data-rewind]").nth(1).click();
  await expect(undoBtn(page)).toBeVisible();
  await expect(box(page)).toHaveValue("beta marker two");

  /* Sending while the window is open commits the rewind first — the new
     turn lands in the post-rewind session. */
  await box(page).fill("gamma after rewind");
  await box(page).press("Enter");
  await expect(
    thread.getByText(/Rewound to before your message — \d+ messages dropped/),
  ).toBeVisible({ timeout: 30_000 });
  await expect(rowText(thread, "gamma after rewind")).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-3-committed.png` });
});

test("AC-578-4 after the window the files and the engine's memory follow", async ({
  page,
}) => {
  test.setTimeout(240_000);
  /* Fresh conversation so the trigger ordering is deterministic: alpha,
     then beta with an image — rewind lands on beta like the other legs. */
  await startChatInFolder(
    page,
    stackA,
    DEFAULT_AGENT,
    repoDir,
    "alpha in the timed session",
  );
  await panelIntoFocus(page);
  const thread = page.locator("[data-thread]");
  await expect(thread.getByText("If you want me to change code")).toBeVisible({
    timeout: 60_000,
  });
  await page.locator('input[type="file"]').last().setInputFiles({
    name: "beta-proof.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await send(page, "beta in the timed session");
  await expect(rowText(thread, "beta in the timed session")).toBeVisible({
    timeout: 60_000,
  });
  /* Wait for beta's reply — sending recall mid-turn steers it into the
     running turn instead of opening its own. */
  await expect(thread.getByText("Got your image")).toBeVisible({
    timeout: 60_000,
  });
  await send(page, "recall:");
  await expect(thread.getByText("I remember 2 earlier turns")).toBeVisible({
    timeout: 60_000,
  });

  await rowText(thread, "beta in the timed session").hover({ force: true });
  await thread.locator("[data-rewind]").nth(1).click();
  await expect(undoBtn(page)).toBeVisible();
  await expect(box(page)).toHaveValue("beta in the timed session");
  await expect(
    page.locator("form").last().getByText("beta-proof.png"),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-window.png` });

  /* More "agent writes" after beta's checkpoint — the commit restores
     these away along with the ones AC-578-2's Undo preserved. */
  writeFileSync(path.join(repoDir, "marker2.txt"), "post-beta\n");

  /* The window closes on its own clock — 10 s plus the commit RPC. */
  await page.waitForTimeout(10_500);
  await expect(undoBtn(page)).toHaveCount(0, { timeout: 15_000 });
  await expect(
    thread.getByText(/Rewound to before your message — \d+ messages dropped/),
  ).toBeVisible({ timeout: 30_000 });

  // Files restored to the pre-turn checkpoint; the user's git untouched.
  await expect
    .poll(
      () =>
        existsSync(path.join(repoDir, "marker2.txt")) ||
        existsSync(path.join(repoDir, "marker.txt")),
      { timeout: 30_000 },
    )
    .toBe(false);
  expect(readFileSync(path.join(repoDir, "seed.txt"), "utf8")).toBe(SEED_TEXT);
  expect(readFileSync(path.join(repoDir, "notes.md"), "utf8")).toBe(NOTES_TEXT);
  expect(gitDigest()).toBe(CLEAN_GIT);
  await page.screenshot({ path: `${SHOTS}/ac-4-committed.png` });

  // The engine forgot the rewound turns.
  await send(page, "recall:");
  await expect(thread.getByText("I remember 1 earlier turn")).toBeVisible({
    timeout: 60_000,
  });
});
