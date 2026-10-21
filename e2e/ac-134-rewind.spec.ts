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
 * Issue #134 — "Rewind" on every user message, updated for #578: the
 * affordance is a hover button on the row (no permanent line), the click
 * applies the rewind visually and opens a 10 s Undo toast; the relay then
 * marks the message + everything after it `rewound` (hidden, kept for
 * audit), the harness restores the session folder from its pre-turn
 * shadow-git checkpoint, and an engine declaring `rewind` drops the turns
 * from agent memory (engine-fake proves it via `recall:`). Assertions that
 * used to be instant now wait out the Undo window first.
 *
 * Two real-app stacks: stackA declares every capability (rewind on),
 * stackB hides it (`LILOS_HIDE_CAPS=rewind`) for the AC-3 files-only
 * fallback. (The old prototype leg, AC-8, is gone with the prototype's old
 * default screen; the v3 thread view is the one surface left.)
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-134");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQI12P8z/CfAQMwMCooKOgDAu2zC+h6pBe+AAAAAElFTkSuQmCC",
  "base64",
);

/* The folder the rewound sessions run in — a real git repo so the shadow
   store proves it never touches the user's `.git`. seed.txt is deleted and
   notes.md edited mid-test; the rewind must restore both. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-134-"));
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
/* Captured after the fixture commit: HEAD + clean worktree + empty stash —
   the user's git state a rewind must leave byte-identical. */
const CLEAN_GIT = gitDigest();

let stackA: Stack; // engine-fake with every capability — incl. `rewind`
let stackB: Stack; // engine-fake with `rewind` hidden (the ACP path)
test.beforeAll(async () => {
  test.setTimeout(180_000);
  stackA = await bootStack("rw-a", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
  stackB = await bootStack("rw-b", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    LILOS_HIDE_CAPS: "rewind",
  });
});
test.afterAll(async () => {
  await stackA?.stop();
  await stackB?.stop();
});

test.describe.configure({ mode: "serial" });

/* The seeded employee. An id that names nobody opens the new-chat draft on
   the default agent, which on these one-agent stacks is Default. */
const DEFAULT_AGENT = { id: "default", name: "Default" };

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

/** The conversation at the top of the peek's trail (`open=…,thread:<id>`). */
const topThread = (page: Page): string =>
  decodeURIComponent(
    /[?&]open=(?:[^&]*,)?thread:([^&,]+)/.exec(page.url())?.[1] ?? "",
  );

let convA = "";

/** Message-row text match that excludes the composer textarea — after a
    rewind the draft legitimately echoes the dropped message (AC-4), and
    getByText matches a textarea's content too. Turn-card collapsibles are
    excluded the same way: a live card's reasoning echoes the prompt
    verbatim (#266), and while it's open getByText strict-matches both —
    the #432 fast tick lands asserts inside that open window. A turn's
    reasoning now lives in its work fold (`[data-tasksteps]`), and the
    thread's own title (`[data-session-title]`, repeated in the sticky bar
    `[data-thread-bar]` once the header scrolls away) is derived from the
    first message — none of them is a message row, so all are excluded. */
const rowText = (scope: Locator, text: string | RegExp) =>
  scope
    .getByText(text)
    .and(
      scope.locator(
        ":not(textarea):not([data-slot='collapsible-content'] *):not([data-tasksteps] *):not([data-session-title]):not([data-thread-bar] *)",
      ),
    );

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("[dbg]")) console.log("PAGE:", m.text());
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("AC-2/4 + AC-1 files: rewind drops the tail, restores the folder, refills the composer", async ({
  page,
}) => {
  test.setTimeout(180_000);
  watchConsole(page);
  /* The new-chat draft's folder chip picks the fixture repo (it is added to
     the app's recents first), then the send lands on the thread in the peek. */
  convA = await startChatInFolder(
    page,
    stackA,
    DEFAULT_AGENT,
    repoDir,
    "alpha marker one",
  );
  /* #577: a send lands on the peek; the session view opens via its widen. */
  await panelIntoFocus(page);
  await expect(
    page.locator("[data-thread]").getByText("If you want me to change code"),
  ).toBeVisible({ timeout: 60_000 });

  /* beta carries an image so AC-4 asserts the attachment chip comes back. */
  await page.locator('input[type="file"]').last().setInputFiles({
    name: "beta-proof.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await send(page, "beta marker two");
  await expect(
    page.locator("[data-thread]").getByText("Got your image"),
  ).toBeVisible({ timeout: 60_000 });
  await send(page, "recall:");
  await expect(
    page.locator("[data-thread]").getByText("I remember 2 earlier turns"),
  ).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-before.png` });

  /* The "agent's writes", faked locally since engine-fake never touches fs:
     a file created, one deleted, one edited — all after beta's checkpoint.
     The user's git state must be byte-identical afterwards. */
  writeFileSync(path.join(repoDir, "marker.txt"), "made after turn 2\n");
  writeFileSync(path.join(repoDir, "notes.md"), "notes v2 EDITED\n");
  unlinkSync(path.join(repoDir, "seed.txt"));

  /* Three user messages => three checkpoints; rewind at "beta marker two".
     #578: the click applies visually + opens the 10 s Undo toast — the
     commit (relay rows, files, engine memory) lands when it closes. */
  const triggers = page.locator("[data-rewind]");
  await expect(triggers).toHaveCount(3);
  await triggers.nth(1).locator("..").hover();
  await triggers.nth(1).click();

  /* The message and everything after (its reply, the recall turn) drop out
     of the thread at once — before any commit. */
  const thread = page.locator("[data-thread]");
  await expect(rowText(thread, "beta marker two")).toHaveCount(0);
  await expect(rowText(thread, "Noted. Plan for this session")).toHaveCount(0);
  await expect(rowText(thread, "I remember 2 earlier turns")).toHaveCount(0);
  await expect(rowText(thread, "alpha marker one")).toBeVisible();
  await expect(page.locator("[data-toast-action]")).toHaveText("Undo");
  await expect(page.locator("textarea").last()).toHaveValue("beta marker two");
  await expect(
    page.locator("form").last().getByText("beta-proof.png"),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-4-undo-window.png` });

  /* Let the Undo window close — the commit RPC lands, then the in-thread
     system note and the file restore. */
  await page.waitForTimeout(10_500);
  await expect(
    thread.getByText(/Rewound to before your message — \d+ messages dropped/),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-4-after.png` });

  /* AC-1 end to end: created file gone, deleted file back, edit reverted;
     the user's own git state is untouched. */
  await expect
    .poll(() => existsSync(path.join(repoDir, "marker.txt")), {
      timeout: 30_000,
    })
    .toBe(false);
  expect(readFileSync(path.join(repoDir, "seed.txt"), "utf8")).toBe(SEED_TEXT);
  expect(readFileSync(path.join(repoDir, "notes.md"), "utf8")).toBe(NOTES_TEXT);
  /* `git status`+HEAD+stash byte-identical to the pre-session state — the
     shadow store never touched the user's `.git`. */
  expect(gitDigest()).toBe(CLEAN_GIT);

  /* AC-2 continued: the engine forgot the rewound turns — a new recall
     hears only "alpha marker one". */
  await send(page, "recall:");
  await expect(
    page.locator("[data-thread]").getByText("I remember 1 earlier turn"),
  ).toBeVisible({ timeout: 60_000 });
  /* The alpha message row + the recall's list item; beta stays gone (the
     composer was cleared by sending "recall:"). */
  await expect(rowText(thread, "alpha marker one")).toHaveCount(2);
  await expect(rowText(thread, "beta marker two")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-2-memory.png` });
});

test("AC-5 rewind triggers are disabled while a turn runs", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await skipFirstRun(page);
  await page.goto(threadUrl(stackA.webUrl, convA, true));
  await expect(page.locator("[data-rewind]").first()).toBeVisible({
    timeout: 30_000,
  });
  /* #432: `slow:50` paces only this turn (~3 s) — enough running window for
     the disabled assertion, without slowing the stack's other prompts. */
  await send(page, "slow:50 a slow-running turn for the disabled check");
  await expect(page.locator("[data-rewind]").first()).toBeDisabled({
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-5-disabled.png` });
  await expect(
    page.locator("[data-thread]").getByText("Noted. Plan for this session"),
  ).toBeVisible({ timeout: 60_000 });
  /* `running` clears on the turn-done frame — the fake keeps streaming
     steps after the reply text lands, so give it real headroom. */
  await expect(page.locator("[data-rewind]").first()).toBeEnabled({
    timeout: 45_000,
  });
});

test("AC-5 a folder shared with another session warns + names it before rewinding", async ({
  page,
}) => {
  test.setTimeout(120_000);
  /* Session B: same employee, same folder, second conversation. */
  const convB = await startChatInFolder(
    page,
    stackA,
    DEFAULT_AGENT,
    repoDir,
    "session B alpha",
  );
  expect(convB).not.toBe(convA);
  /* #577: a send lands on the peek; the session view opens via its widen. */
  await panelIntoFocus(page);
  await expect(
    page.locator("[data-thread]").getByText("If you want me to change code"),
  ).toBeVisible({ timeout: 60_000 });

  /* Back on session A: #578 removed the confirm dialog — the shared-folder
     warning lives on the trigger's tooltip and the click applies at once
     (the 10 s Undo toast is the safeguard). */
  await skipFirstRun(page);
  await page.goto(threadUrl(stackA.webUrl, convA, true));
  const thread = page.locator("[data-thread]");
  const sharedTrigger = thread.locator("[data-rewind]").first();
  await expect(sharedTrigger).toBeEnabled({ timeout: 30_000 });
  /* The name renders the sharer's title or root text — the fake's llm
     stage Title-Cases it ("Session B Alpha"), so match case-blind. */
  await expect(sharedTrigger).toHaveAttribute("title", /shared with/i);
  await expect(sharedTrigger).toHaveAttribute("title", /session b alpha/i);
  await sharedTrigger.locator("..").hover();
  await page.screenshot({ path: `${SHOTS}/ac-5-shared-tooltip.png` });
  await sharedTrigger.click();
  /* Rewound to the root: the whole thread drops at once, the Undo toast
     offers the out, and the opener is back in the composer. */
  await expect(page.locator("textarea").last()).toHaveValue("alpha marker one");
  await expect(rowText(thread, "alpha marker one")).toHaveCount(0);
  await expect(page.locator("[data-toast-action]")).toHaveText("Undo");
  /* The commit lands when the window closes — the note shows at the top. */
  await page.waitForTimeout(10_500);
  await expect(rowText(thread, /Rewound to before your message/)).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-5-root.png` });
});

test("AC-3 without rewind: files restore, the plain note shows, Start a new thread works", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const convC = await startChatInFolder(
    page,
    stackB,
    DEFAULT_AGENT,
    repoDir,
    "alpha in the no-rewind session",
  );
  /* #577: a send lands on the peek; the session view opens via its widen. */
  await panelIntoFocus(page);
  await expect(
    page.locator("[data-thread]").getByText("If you want me to change code"),
  ).toBeVisible({ timeout: 60_000 });
  await send(page, "beta in the no-rewind session");
  await expect(
    page.locator("[data-thread]").getByText("Noted. Plan for this session"),
  ).toBeVisible({ timeout: 60_000 });

  writeFileSync(path.join(repoDir, "stackb-marker.txt"), "post-beta\n");
  const thread = page.locator("[data-thread]");
  await expect(thread.locator("[data-rewind]").nth(1)).toBeEnabled({
    timeout: 30_000,
  });
  await thread.locator("[data-rewind]").nth(1).locator("..").hover();
  await thread.locator("[data-rewind]").nth(1).click();

  /* The tail drops visually at once, with the Undo toast; the commit
     (files + the banner) lands when the window closes. */
  await expect(rowText(thread, "beta in the no-rewind session")).toHaveCount(0);
  await expect(page.locator("[data-toast-action]")).toHaveText("Undo");
  await page.waitForTimeout(10_500);

  /* Both the relay's in-thread system note and the amber banner say the
     agent still remembers, with the escape hatch. */
  await expect(page.getByText(/still remembers/)).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect(
    page.getByRole("button", { name: "Start a new thread from here" }),
  ).toBeVisible();
  await expect
    .poll(() => existsSync(path.join(repoDir, "stackb-marker.txt")), {
      timeout: 30_000,
    })
    .toBe(false);
  await page.screenshot({ path: `${SHOTS}/ac-3-banner.png` });

  await page
    .getByRole("button", { name: "Start a new thread from here" })
    .click();
  /* Already sitting on convC's session view — wait until the trail's top
     thread is another one. */
  await expect.poll(() => topThread(page), { timeout: 30_000 }).not.toBe(convC);
  const convD = topThread(page);
  expect(convD).not.toBe(convC);
  /* The widened peek stays widened across the hop, so the fresh session is
     already the session view where [data-thread] renders. */
  await expect(page).toHaveURL(/[#&]full=1(&|$)/);
  /* The fresh session's root carries the surviving transcript as quoted
     context, then the rewound text. Pin exactly one row — the committed root
     user message: the engine reply's reasoning echoes the seeded prompt
     verbatim, and while its collapsible is open a bare getByText
     strict-matches both (#266). That echo is inside the agent's thinking
     collapsible, not a second user-visible row — test-side, not a product
     bug (#260). */
  const seeded = page
    .locator("[data-thread] [data-userturn]")
    .filter({ hasText: /Picking up mid-thread after a rewind/ })
    .first();
  await expect(seeded).toContainText(/Picking up mid-thread after a rewind/, {
    timeout: 60_000,
  });
  await expect(seeded).toContainText(/alpha in the no-rewind session/, {
    timeout: 60_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-3-new-session.png` });
});
