import { type ChildProcess, execSync, spawn } from "node:child_process";
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
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { wport } from "./ports";

/**
 * Issue #134 — "Rewind to here" on every user message: the relay marks the
 * message + everything after it `rewound` (hidden, kept for audit), the
 * harness restores the session folder from its pre-turn shadow-git
 * checkpoint, and an engine declaring `rewind` drops the turns from agent
 * memory (engine-fake proves it via `recall:`).
 *
 * Two real-app stacks: stackA declares every capability (rewind on),
 * stackB hides it (`LILOS_HIDE_CAPS=rewind`) for the AC-3 files-only
 * fallback. The last leg is the prototype (AC-8).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");
const SHOTS = path.join(repo, "test-results", "ac-134");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQI12P8z/CfAQMwMCooKOgDAu2zC+h6pBe+AAAAAElFTkSuQmCC",
  "base64",
);

interface Stack {
  home: string;
  webUrl: string;
  relayWs: string;
  relayToken: string;
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
  extraEnv: Record<string, string> = {},
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
      ...extraEnv,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    await waitForHttp(webUrl);
    await waitForHttp(`http://127.0.0.1:${ports.relay}/`);
    await waitForHttp(`http://127.0.0.1:${ports.feed}/`);
    const tokenPath = path.join(home, "relay-token");
    let relayToken = "";
    for (let i = 0; i < 300 && !relayToken; i++) {
      try {
        relayToken = readFileSync(tokenPath, "utf8").trim();
      } catch {}
      if (!relayToken) await new Promise((r) => setTimeout(r, 100));
    }
    if (!relayToken)
      throw new Error(`relay token never appeared at ${tokenPath}`);
    return {
      home,
      webUrl,
      relayWs: `ws://127.0.0.1:${ports.relay}/ws`,
      relayToken,
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
  stackA = await bootStack(
    "rw-a",
    { relay: wport(4643), feed: wport(4647), web: wport(5241) },
    {
      LILOS_USER_NAME: "Oscar",
      /* Slow the fake's steps so the AC-5 "disabled while running" assertion
         has a window even on a fast VM. */
      ENGINE_FAKE_TICK: "700",
    },
  );
  stackB = await bootStack(
    "rw-b",
    { relay: wport(4782), feed: wport(4783), web: wport(5385) },
    { LILOS_USER_NAME: "Oscar", LILOS_HIDE_CAPS: "rewind" },
  );
});
test.afterAll(async () => {
  await stackA?.stop();
  await stackB?.stop();
});

test.describe.configure({ mode: "serial" });

/** Open the app, land on Default's DM home composer. `roots` feeds
    `?roots=` so git.discoverRepos finds the fixture repo. */
async function dmDefault(stack: Stack, page: Page, roots = "") {
  await page.goto(`${stack.webUrl}/${roots ? `?roots=${roots}` : ""}`);
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

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const empId = (page: Page) =>
  decodeURIComponent(page.url().split("/dm/")[1].split("/")[0]);

/** Pick `dir` in the home composer's folder picker (Add folder dialog). */
async function pickFolder(page: Page, dir: string) {
  /* The pick persists on the composer — a second session in the same folder
     finds the chip already set and needs nothing at all. */
  const chip = page.locator('[data-ws="folder"]');
  const base = dir.split("/").pop() ?? dir;
  /* The remembered pick lands when folders.list arrives — poll the chip
     instead of a single read so we don't open the picker before hydration. */
  for (let i = 0; i < 40; i++) {
    if ((await chip.innerText().catch(() => "")).includes(base)) return;
    if (i >= 10) break; /* ~2s then give up — fresh stacks stay "No folder" */
    await page.waitForTimeout(200);
  }
  await chip.click();
  const menu = page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
  /* Existing folders list by id — match the row by its rendered path. A
     folder bound to a live session is filtered out of "discovered", so
     picking it again for a second session only works through this list. */
  const recent = menu.locator("[data-wsfolder]").filter({ hasText: dir });
  /* folders.list lands asynchronously — give the rows a beat to populate
     before deciding the folder isn't in the picker yet (session B re-picks
     a folder that session A already added). */
  if (
    await recent
      .first()
      .isVisible({ timeout: 8_000 })
      .catch(() => false)
  ) {
    await recent.first().click();
    return;
  }
  await menu.getByText("Add a folder").click();
  const dialog = page.locator("[data-addfolder]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(`[data-discovered="${dir}"]`)).toBeVisible({
    timeout: 15_000,
  });
  await dialog.locator(`[data-discovered="${dir}"]`).click();
  await expect(dialog.locator("[data-folderinfo]")).toContainText("Git repo", {
    timeout: 15_000,
  });
  await dialog.locator("[data-addbtn]").click();
  await expect(dialog).toHaveCount(0);
  /* The pick lands asynchronously (`addFolder().then(setPick)`) — wait for
     the chip to show the folder before sending, or the conversation binds
     the harness workdir instead of the repo. */
  await expect(chip).toContainText(base, { timeout: 10_000 });
}

let convA = "";
let empA = "";

/** Message-row text match that excludes the composer textarea — after a
    rewind the draft legitimately echoes the dropped message (AC-4), and
    getByText matches a textarea's content too. */
const rowText = (scope: Locator, text: string | RegExp) =>
  scope.getByText(text).and(scope.locator(":not(textarea)"));

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
  await dmDefault(stackA, page, ROOT);
  await pickFolder(page, repoDir);
  await expect(page.locator('[data-ws="folder"]')).toContainText("lilos-repo");
  await send(page, "alpha marker one");
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  convA = decodeURIComponent(page.url().split("/dm/")[1].split("/")[1]);
  empA = empId(page);
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

  /* Three user messages => three checkpoints; rewind at "beta marker two". */
  const triggers = page.locator("[data-rewind]");
  await expect(triggers).toHaveCount(3);
  await triggers.nth(1).click();

  /* The message and everything after (its reply, the recall turn) drop out
     of the thread; a system note lands where the thread was cut. */
  const thread = page.locator("[data-thread]");
  await expect(rowText(thread, "beta marker two")).toHaveCount(0);
  await expect(rowText(thread, "Noted. Plan for this session")).toHaveCount(0);
  await expect(rowText(thread, "I remember 2 earlier turns")).toHaveCount(0);
  await expect(rowText(thread, "alpha marker one")).toBeVisible();
  await expect(
    thread.getByText(/Rewound to before your message — \d+ messages dropped/),
  ).toBeVisible();
  await expect(page.locator("textarea").last()).toHaveValue("beta marker two");
  await expect(
    page.locator("form").last().getByText("beta-proof.png"),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-4-after.png` });

  /* AC-1 end to end: created file gone, deleted file back, edit reverted;
     the user's own git state is untouched. */
  expect(existsSync(path.join(repoDir, "marker.txt"))).toBe(false);
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
  await page.goto(`${stackA.webUrl}/dm/${empA}/${convA}/focus`);
  await expect(page.locator("[data-rewind]").first()).toBeVisible({
    timeout: 30_000,
  });
  /* ENGINE_FAKE_TICK=700 keeps the turn streaming for a few seconds. */
  await send(page, "a slow-running turn for the disabled check");
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
  /* Session B: same employee, same folder, second conversation. `?roots=`
     is what lets git.discoverRepos offer the fixture repo in the picker. */
  await page.goto(`${stackA.webUrl}/dm/${empA}?roots=${ROOT}`);
  await pickFolder(page, repoDir);
  await send(page, "session B alpha");
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  const convB = page.url().split("/dm/")[1].split("/")[1];
  expect(convB).not.toBe(convA);
  await expect(
    page.locator("[data-thread]").getByText("If you want me to change code"),
  ).toBeVisible({ timeout: 60_000 });

  /* Back on session A: the click asks first, naming session B; cancelling
     leaves the thread untouched. */
  await page.goto(`${stackA.webUrl}/dm/${empA}/${convA}/focus`);
  const thread = page.locator("[data-thread]");
  await expect(thread.locator("[data-rewind]").first()).toBeEnabled({
    timeout: 30_000,
  });
  await thread.locator("[data-rewind]").first().click();
  await expect(thread.getByText(/shared with/)).toBeVisible();
  await expect(thread.getByText(/session B alpha/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-5-shared.png` });
  await thread.getByRole("button", { name: "Cancel" }).click();
  /* The row plus the "I remember 1 earlier turn" list item — cancelling
     must leave the thread exactly as it was. */
  await expect(rowText(thread, "alpha marker one")).toHaveCount(2);
  await thread.locator("[data-rewind]").first().click();
  await thread.getByRole("button", { name: "Rewind anyway" }).click();
  /* Rewound to the root: the whole thread is gone, the rewind note shows
     alone at the top, and the opener is back in the composer. */
  await expect(page.locator("textarea").last()).toHaveValue("alpha marker one");
  await expect(rowText(thread, /Rewound to before your message/)).toBeVisible();
  await expect(rowText(thread, "alpha marker one")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-5-root.png` });
});

test("AC-3 without rewind: files restore, the plain note shows, Start a new session works", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackB, page, ROOT);
  await pickFolder(page, repoDir);
  await send(page, "alpha in the no-rewind session");
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  const convC = page.url().split("/dm/")[1].split("/")[1];
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
  await thread.locator("[data-rewind]").nth(1).click();

  /* Files restore and the thread still drops the tail — but the banner says
     plainly the agent still remembers, with the escape hatch. */
  /* Both the relay's in-thread system note and the amber banner say it. */
  await expect(page.getByText(/still remembers/)).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Start a new session from here" }),
  ).toBeVisible();
  await expect(rowText(thread, "beta in the no-rewind session")).toHaveCount(0);
  await expect(existsSync(path.join(repoDir, "stackb-marker.txt"))).toBe(false);
  await page.screenshot({ path: `${SHOTS}/ac-3-banner.png` });

  await page
    .getByRole("button", { name: "Start a new session from here" })
    .click();
  /* Already sitting on convC's /focus URL — wait until it changes. */
  await page.waitForURL(
    (u) =>
      /\/dm\/[^/]+\/[^/]+\/focus$/.test(u.pathname) &&
      !u.pathname.includes(convC),
    { timeout: 30_000 },
  );
  const convD = page.url().split("/dm/")[1].split("/")[1];
  expect(convD).not.toBe(convC);
  /* The fresh session's root carries the surviving transcript as quoted
     context, then the rewound text. Scope to the user turn: the engine
     reply's reasoning echoes the seeded prompt verbatim, and while its
     collapsible is open a bare getByText strict-matches both (#266). */
  const seeded = page.locator("[data-thread] [data-userturn]");
  await expect(
    seeded.getByText(/Picking up mid-session after a rewind/),
  ).toBeVisible({ timeout: 60_000 });
  await expect(seeded.getByText(/alpha in the no-rewind session/)).toBeVisible({
    timeout: 60_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-3-new-session.png` });
});

test("AC-8 prototype shows the action and the result", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  const box = page.getByPlaceholder(/New session with Builder/);
  await box.fill("prototype alpha");
  await box.press("Enter");
  /* A message sent while a turn runs is folded in as a steer — no new user
     turn, no checkpoint trigger. Wait for alpha's trigger to enable (turn
     done) before sending beta as a second turn. */
  await expect(page.locator("[data-rewind]").nth(0)).toBeEnabled({
    timeout: 60_000,
  });
  const thread = page.locator("textarea").last();
  await thread.fill("prototype beta");
  await thread.press("Enter");
  /* Same story for beta's own turn — wait for its trigger to enable. */
  await expect(page.locator("[data-rewind]").nth(1)).toBeEnabled({
    timeout: 60_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-8-action.png` });
  await page.locator("[data-rewind]").nth(1).click();
  await expect(
    page.getByText("prototype beta").and(page.locator(":not(textarea)")),
  ).toHaveCount(0);
  await expect(page.getByText(/Rewound to before your message/)).toBeVisible();
  await expect(page.locator("textarea").last()).toHaveValue("prototype beta");
  await page.screenshot({ path: `${SHOTS}/ac-8-result.png` });
});
