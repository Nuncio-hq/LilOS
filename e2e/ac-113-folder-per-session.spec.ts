import { type ChildProcess, execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { wport } from "./ports";

/**
 * Issue #113 — pick a folder per DM session, end to end on the real stack
 * (relay + harness + vite dev, engine-fake). The folders are real dirs under
 * a tmp root; repoDir is a git repo on branch `trunk` so the header badge
 * and the engine-fake `I'm in <cwd>` echo are both real assertions.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");

const webDir = path.join(repo, "apps", "web");

interface Stack {
  home: string;
  webUrl: string;
  relayWs: string;
  feedWs: string;
  relayToken: string;
  stop: () => Promise<void>;
}

async function waitForHttp(url: string, ms = 90_000): Promise<void> {
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
      feedWs: `ws://127.0.0.1:${ports.feed}/ws`,
      relayToken,
      stop: async () => {
        await killProc(proc);
        await expectNoEngineLeak(leakTag);
      },
    };
  } catch (e) {
    // Group kill: `bun run dev` spawns detached — killing only the shim
    // orphans stack.ts + relay + harness + vite and poisons the next boot.
    await killProc(proc);
    throw e;
  }
}

const SHOTS = path.join(repo, "test-results", "ac-113");

/* Real fixture dirs, made once for the whole file. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-113-"));
const repoDir = path.join(ROOT, "lilos-repo-a");
const plainDir = path.join(ROOT, "lilos-plain-b");
const goneDir = path.join(ROOT, "lilos-gone-c");
/* Never added to recents before the #208 AC-3 test — the dialog must say
   "Not a git repo" for a dir it hasn't seen. */
const freshDir = path.join(ROOT, "lilos-fresh-d");
mkdirSync(repoDir);
mkdirSync(plainDir);
mkdirSync(goneDir);
mkdirSync(freshDir);
execSync(
  "git init -b trunk && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
  { cwd: repoDir },
);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac113", {
    relay: wport(4680),
    feed: wport(4681),
    web: wport(5280),
  });
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

/* `?roots=` makes git.discoverRepos find repoDir for the "Found" chips. */
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

const send = async (page: Page, text: string, which: "first" | "last") => {
  const box =
    which === "first"
      ? page.locator("textarea").first()
      : page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const pickerButton = (page: Page) => page.locator('[data-ws="folder"]');

/** Open the folder menu; returns the menu container. */
async function openPicker(page: Page) {
  await pickerButton(page).click();
  return page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
}

test("AC-2 + #208 AC-1 the composer shows the folder picker; Add folder opens the in-app dialog even on the desktop bridge", async ({
  page,
}) => {
  /* #208 AC-1/AC-5: a live `window.lilos.pickFolder` must never fire — Add a
     folder is LilOS's own dialog on every surface. The spy returns a real
     dir so the removed code path would add it straight to the chip (red
     before the fix), never opening the dialog. */
  await page.addInitScript((bait) => {
    const w = window as Window & {
      lilos?: { pickFolder?: () => Promise<string | null> };
      __pickFolderCalls?: number;
    };
    w.lilos = {
      pickFolder: () => {
        w.__pickFolderCalls = (w.__pickFolderCalls ?? 0) + 1;
        return Promise.resolve(bait);
      },
    };
  }, plainDir);
  await dmDefault(page);
  await expect(pickerButton(page)).toBeVisible();
  const menu = await openPicker(page);
  await expect(menu.getByText("Run this session in")).toBeVisible();
  await expect(menu.getByText("No folder · just chat")).toBeVisible();
  await expect(menu.getByText("Add a folder")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-2-picker-empty.png` });
  await menu.getByText("Add a folder").click();

  // The in-app dialog (fs.list / git.discoverRepos): repoDir is a
  // discovered chip; pick it, see the repo card, add it.
  const dialog = page.locator("[data-addfolder]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(`[data-discovered="${repoDir}"]`)).toBeVisible({
    timeout: 15_000,
  });
  await dialog.locator(`[data-discovered="${repoDir}"]`).click();
  await expect(dialog.locator("[data-folderinfo]")).toContainText("Git repo", {
    timeout: 15_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-addfolder.png` });
  await dialog.locator("[data-addbtn]").click();
  await expect(dialog).toHaveCount(0);
  await expect(pickerButton(page)).toContainText("lilos-repo-a");
  // The OS-panel bridge was never consulted (#208 AC-5).
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __pickFolderCalls?: number }).__pickFolderCalls ??
        0,
    ),
  ).toBe(0);
});

test("DM open never scans the disk — git.discoverRepos runs only on Add folder", async ({
  page,
}) => {
  const hostCalls: string[] = [];
  page.on("request", (r) => {
    if (!r.url().endsWith("/host")) return;
    try {
      const m = (JSON.parse(r.postData() ?? "{}") as { method?: string })
        .method;
      if (m) hostCalls.push(m);
    } catch {
      /* OPTIONS preflight carries no JSON body */
    }
  });
  await dmDefault(page);
  // Recents probes (fs.list/git.branches on the stored folders) DO hit
  // /host at mount — wait for one so "no discoverRepos" isn't vacuous.
  await expect
    .poll(() => hostCalls.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(hostCalls).not.toContain("git.discoverRepos");
  // …and it does fire when the web Add-folder dialog opens.
  const menu = await openPicker(page);
  await menu.getByText("Add a folder").click();
  await expect(page.locator("[data-addfolder]")).toBeVisible();
  await expect
    .poll(() => hostCalls.includes("git.discoverRepos"), { timeout: 15_000 })
    .toBe(true);
});

test("AC-3 the picker offers direct mode only (no worktree items)", async ({
  page,
}) => {
  await dmDefault(page);
  // Pick the git repo from the recents menu, then check the branch chip.
  const folderMenu = await openPicker(page);
  await folderMenu.locator(`[data-wsfolder="${repoDir}"]`).click();
  await expect(pickerButton(page)).toContainText("lilos-repo-a");
  // Direct-only mode: the checked-out branch shows as a static label — the
  // real app never renders a branch list, since nothing checks a branch out.
  const branch = page.locator('[data-ws="branch"]');
  await expect(branch).toContainText("trunk");
  await expect(branch.locator("button")).toHaveCount(0);
  await branch.click();
  await expect(
    page.locator('[role="menu"], [data-slot="dropdown-menu-content"]'),
  ).toHaveCount(0);
  await expect(page.getByText(/Edit .* directly/)).toHaveCount(0);
  await expect(page.getByText("New workstream from")).toHaveCount(0);
  await expect(page.getByText("Continue a workstream")).toHaveCount(0);
  // The composer hint reveals once there's a draft — calm at rest (#246).
  await page.locator("textarea").first().pressSequentially("x");
  await expect(
    page.getByText("edits land on the checked-out branch", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-3-direct-only.png` });
  // Drafts persist per conversation — clear so later tests start clean.
  await page.locator("textarea").first().fill("");
});

test("AC-4 + AC-7 a session picked on the repo runs there; the header shows folder + branch", async ({
  page,
}) => {
  await dmDefault(page);
  // No session yet on the repo → pick it from the recents menu ourselves.
  const folderMenu = await openPicker(page);
  await folderMenu.locator(`[data-wsfolder="${repoDir}"]`).click();
  await expect(pickerButton(page)).toContainText("lilos-repo-a");
  await send(page, "hello — first turn", "first");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);
  // Wait for turn 1 to finish, or the next message becomes a steer inside
  // the running turn instead of the follow-up turn that echoes the cwd.
  await expect(
    page.getByText("If you want me to change code", { exact: false }).last(),
  ).toBeVisible({ timeout: 30_000 });
  // The reply text renders before the turn settles — wait for streaming to
  // end so the follow-up starts a new turn rather than steering this one.
  await expect(page.locator("[data-agentturn] [data-streaming]")).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  // engine-fake echoes its cwd on the follow-up turn (AC-4); markdown puts
  // the path in a <code> element, so match that rather than the backticks.
  await send(page, "where are you working?", "last");
  /* Scope to the last agent turn (#191): the answer's relay post and the
     still-streaming live turn overlap in the DOM for a moment, so a bare
     `code` search can resolve to both copies of the reply at once. */
  await expect(
    page
      .locator("[data-agentturn]")
      .last()
      .locator("code")
      .filter({ hasText: repoDir }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("on ⎇", { exact: false })).toBeVisible();
  // AC-7: header badge = folder name + real branch.
  const badge = page.locator("[data-wsbadge]");
  await expect(badge).toContainText("lilos-repo-a", { timeout: 15_000 });
  await expect(badge).toContainText("trunk");
  await page.screenshot({ path: `${SHOTS}/ac-4-7-header.png` });
});

test("AC-6 the employee pre-selects its last folder; a no-folder session is a plain chat (#196)", async ({
  page,
}) => {
  await dmDefault(page);
  // Last session ran in repoDir → the picker comes up pre-selected (AC-6).
  await expect(pickerButton(page)).toContainText("lilos-repo-a", {
    timeout: 15_000,
  });
  // …but a folder is never required: pick "No folder" and send.
  const menu = await openPicker(page);
  await menu.getByText("No folder · just chat").click();
  await send(page, "no folder please", "first");
  // A new session opens straight into Focus (#114 AC-1) — assert there
  // first: the turn settles (an employee turn renders) and nothing
  // announces the missing folder: no system note, no header chip, a
  // neutral hint (#196 — supersedes the #113 AC-6 notice).
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+\/focus/);
  await expect(page.locator("[data-agentturn]").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByText("No folder: working in", { exact: false }),
  ).toHaveCount(0);
  await expect(page.locator("[data-wsbadge]")).toHaveCount(0);
  await expect(page.getByText(/read-only/i)).toHaveCount(0);
  // Composer hints reveal once there's a draft — calm at rest (#246), so
  // type a character first. The composer is named "Continue session…" on
  // Focus and "Reply to … in this session" on the panel (which mounts
  // once the thread hydrates and sits outside `main`).
  const focusBox = page.getByRole("textbox", { name: /Continue session/ });
  await focusBox.pressSequentially("x");
  await expect(page.getByText(/Reply to .*…/).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-6-no-folder-focus.png` });
  // The session panel is the same: no chip, no "discussion" label,
  // neutral hint.
  const dmPath = new URL(page.url()).pathname.replace(/\/focus$/, "");
  await page.goto(`${stack.webUrl}${dmPath}`);
  const replyBox = page.getByRole("textbox", { name: /Reply to/ });
  await expect(replyBox).toBeVisible({ timeout: 30_000 });
  await replyBox.pressSequentially("x");
  await expect(page.getByText(/Reply to .*…/).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("[data-wsbadge]")).toHaveCount(0);
  await expect(page.getByText("discussion", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/read-only/i)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-6-no-folder.png` });
  // Drafts persist per conversation — clear so later tests start clean.
  await replyBox.fill("");
});

test("AC-5 recents persist across reload; a deleted folder shows missing and can't be picked", async ({
  page,
}) => {
  await dmDefault(page);
  // Add two more folders through the dialog: one kept, one deleted after.
  for (const dir of [plainDir, goneDir]) {
    await (await openPicker(page)).getByText("Add a folder").click();
    const dialog = page.locator("[data-addfolder]");
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-pathinput]").fill(dir);
    await expect(dialog.locator("[data-folderinfo]")).toContainText(
      "Not a git repo",
      { timeout: 15_000 },
    );
    await dialog.locator("[data-addbtn]").click();
    await expect(dialog).toHaveCount(0);
  }
  rmSync(goneDir, { recursive: true, force: true });

  await page.reload();
  await expect(pickerButton(page)).toBeVisible({ timeout: 30_000 });
  const menu = await openPicker(page);
  // Newest first: gone (added last) → plain → repo (touched by its session).
  await expect(menu.locator(`[data-wsfolder="${goneDir}"]`)).toBeVisible();
  await expect(menu.locator(`[data-wsfolder="${plainDir}"]`)).toBeVisible();
  await expect(menu.locator(`[data-wsfolder="${repoDir}"]`)).toBeVisible();
  const rows = await menu.locator("[data-wsfolder]").all();
  const order = await Promise.all(
    rows.map((r) => r.getAttribute("data-wsfolder")),
  );
  expect(order.indexOf(goneDir)).toBeLessThan(order.indexOf(plainDir));
  expect(order.indexOf(plainDir)).toBeLessThan(order.indexOf(repoDir));
  // Missing: marked + disabled, unpickable.
  const gone = menu.locator(`[data-wsfolder="${goneDir}"]`);
  await expect(gone).toHaveAttribute("data-missing", "");
  await expect(gone).toContainText("missing");
  await expect(gone).toHaveAttribute("aria-disabled", "true");
  await page.screenshot({ path: `${SHOTS}/ac-5-recents-missing.png` });
});

test("AC-3 (#208) a typed non-git folder says 'Not a git repo', adds, and the session runs there", async ({
  page,
}) => {
  await dmDefault(page);
  await (await openPicker(page)).getByText("Add a folder").click();
  const dialog = page.locator("[data-addfolder]");
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-pathinput]").fill(freshDir);
  await expect(dialog.locator("[data-folderinfo]")).toContainText(
    "Not a git repo",
    { timeout: 15_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac-208-3-notgit.png` });
  await dialog.locator("[data-addbtn]").click();
  await expect(dialog).toHaveCount(0);
  await expect(pickerButton(page)).toContainText("lilos-fresh-d");
  await send(page, "hello — plain folder turn", "first");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);
  // Let turn 1 settle so the follow-up is a fresh turn that echoes the cwd.
  await expect(
    page.getByText("If you want me to change code", { exact: false }).last(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-agentturn] [data-streaming]")).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  await send(page, "where are you working?", "last");
  await expect(
    page
      .locator("[data-agentturn]")
      .last()
      .locator("code")
      .filter({ hasText: freshDir }),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-208-3-pwd.png` });
});
