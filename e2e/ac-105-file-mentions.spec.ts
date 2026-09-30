import { type ChildProcess, execSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { wport } from "./ports";

/**
 * Issue #105 — `@`-mention files and folders in the DM composer, end to end
 * on the real stack (relay + harness + vite dev, engine-fake). The fixture
 * repo is real git on disk: tracked + untracked + gitignored files, and
 * enough files to prove the 20-row cap. engine-fake echoes the prompt's
 * follow-up text, which is the AC-4 proof that the engine got `@path` as
 * plain text.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");

interface Stack {
  home: string;
  webUrl: string;
  /* Whether this stack's recents already hold the fixture repo — lives on
     the stack so it stays true however beforeAll/repeats are scheduled. */
  repoAdded: boolean;
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
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    await waitForHttp(webUrl);
    await waitForHttp(`http://127.0.0.1:${ports.relay}/`);
    await waitForHttp(`http://127.0.0.1:${ports.feed}/`);
    const tokenPath = path.join(home, "relay-token");
    for (let i = 0; i < 300; i++) {
      try {
        readFileSync(tokenPath, "utf8");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return {
      home,
      webUrl,
      repoAdded: false,
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

const SHOTS = path.join(repo, "test-results", "ac-105");

/* Real fixture repo: tracked + untracked + gitignored + a dir of generated
   files so an empty query exceeds the 20-row cap. */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-105-"));
const repoDir = path.join(ROOT, "lilos-105-repo");
mkdirSync(path.join(repoDir, "src", "util"), { recursive: true });
mkdirSync(path.join(repoDir, "src", "gen"), { recursive: true });
mkdirSync(path.join(repoDir, "docs"), { recursive: true });
mkdirSync(path.join(repoDir, "logs"), { recursive: true });
writeFileSync(path.join(repoDir, ".gitignore"), "secret.env\nlogs/\n");
writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
writeFileSync(path.join(repoDir, "src", "app.tsx"), "export {}\n");
writeFileSync(path.join(repoDir, "src", "util", "deep.ts"), "export {}\n");
writeFileSync(path.join(repoDir, "docs", "guide.md"), "# guide\n");
for (let i = 0; i < 25; i++) {
  writeFileSync(
    path.join(repoDir, "src", "gen", `gen${String(i).padStart(2, "0")}.ts`),
    "export {}\n",
  );
}
execSync(
  "git init -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -m init",
  { cwd: repoDir },
);
// Dirty state on top of the commit: untracked + ignored files.
writeFileSync(path.join(repoDir, "untracked.ts"), "export {}\n");
writeFileSync(path.join(repoDir, "secret.env"), "TOKEN=x\n");
writeFileSync(path.join(repoDir, "logs", "debug.log"), "log\n");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac105", {
    relay: wport(4818),
    feed: wport(4819),
    web: wport(5322),
  });
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

async function dmDefault(page: Page) {
  await page.goto(stack.webUrl);
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

const homeBox = (page: Page) => page.locator("textarea").first();
const menu = (page: Page) => page.getByRole("listbox");
const fileRows = (page: Page) => page.locator("[data-mention-file]");

/** Employees sit above the Files section; ↓ walks the flat list (wraps). */
async function arrowDownTo(
  box: ReturnType<Page["locator"]>,
  row: ReturnType<Page["locator"]>,
) {
  for (let i = 0; i < 10; i++) {
    if ((await row.getAttribute("aria-selected")) === "true") return;
    await box.press("ArrowDown");
  }
  await expect(row).toHaveAttribute("aria-selected", "true");
}

/** Pick the fixture repo for this DM: the pick survives between the serial
    tests (shared LILOS_HOME), so an earlier test may have added it already —
    then the folder menu lists it (data-wsfolder = path = id).
    The menu's folder rows render off the page's async recents refresh, so a
    raw count() can run before the row lands (#304): only "the repo was never
    added" may branch to the Add dialog; "was added" waits for the row. */
async function addAndPickRepo(page: Page) {
  const wsBtn = page.locator('[data-ws="folder"]');
  if ((await wsBtn.innerText()).includes("lilos-105-repo")) return;
  await wsBtn.click();
  const pickerMenu = page.locator('[role="menu"]').last();
  const existing = pickerMenu.locator(`[data-wsfolder="${repoDir}"]`);
  // Wait for the menu to render before choosing a branch.
  await pickerMenu.getByText("Add a folder").waitFor({ state: "visible" });
  if (stack.repoAdded || (await existing.count()) > 0) {
    // Already in recents: the row lands when the refresh resolves.
    await expect(existing).toBeVisible({ timeout: 15_000 });
    await existing.click();
    stack.repoAdded = true;
  } else {
    await pickerMenu.getByText("Add a folder").click();
    const dialog = page.locator("[data-addfolder]");
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-pathinput]").fill(repoDir);
    // folderinfo renders once the fs probe lands; the Add button's own
    // enabled state is the deterministic signal — disabled means the app
    // considers the folder attached ("Already added."), which a recents
    // refresh landing after the menu opened can still cause (#304).
    await expect(dialog.locator("[data-folderinfo]")).toBeVisible({
      timeout: 15_000,
    });
    if (await dialog.locator("[data-addbtn]").isEnabled()) {
      await dialog.locator("[data-addbtn]").click();
    } else {
      // Recover by picking the recents row instead of adding again.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await wsBtn.click();
      await expect(existing).toBeVisible({ timeout: 15_000 });
      await existing.click();
    }
    await expect(dialog).toHaveCount(0);
    stack.repoAdded = true;
  }
  await expect(wsBtn).toContainText("lilos-105-repo");
}

test("AC-2 with no folder picked the @ menu has an Employees section only (D-#19)", async ({
  page,
}) => {
  await dmDefault(page);
  const box = homeBox(page);
  await box.click();
  await box.pressSequentially("@");
  await expect(menu(page)).toBeVisible();
  await expect(
    page.locator('[data-mention-section="employees"]'),
  ).toBeVisible();
  await expect(page.locator('[data-mention-section="files"]')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-2-no-folder.png` });
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
});

test("AC-1 @ opens one menu: Employees then Files, fuzzy match, cap 20, arrows + Enter pick, Esc closes", async ({
  page,
}) => {
  await dmDefault(page);
  await addAndPickRepo(page);
  const box = homeBox(page);

  await box.click();
  await box.pressSequentially("@");
  await expect(menu(page)).toBeVisible();
  await expect(
    page.locator('[data-mention-section="employees"]'),
  ).toBeVisible();
  const files = page.locator('[data-mention-section="files"]');
  await expect(files).toBeVisible({ timeout: 15_000 });
  // Cap: the fixture has >20 candidates on an empty query; the section shows 20.
  await expect(fileRows(page)).toHaveCount(20, { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-menu-sections.png` });

  // Fuzzy match narrows it; dirs are marked with a trailing slash.
  await box.pressSequentially("app");
  const appRow = page.locator('[data-mention-file="src/app.tsx"]');
  await expect(appRow).toBeVisible({ timeout: 15_000 });
  await expect(fileRows(page)).toHaveCount(1);

  // Arrow keys move the highlight across both sections; Enter inserts the
  // token as text instead of submitting.
  await arrowDownTo(box, appRow);
  await box.press("Enter");
  await expect(box).toHaveValue("@src/app.tsx ");
  await expect(menu(page)).toHaveCount(0);

  // Reopen and Esc closes it.
  await box.pressSequentially("@ap");
  await expect(menu(page)).toBeVisible();
  await box.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(box).toHaveValue("@src/app.tsx @ap");
});

test("AC-2 files come from the session folder: gitignored out, untracked in, folders marked", async ({
  page,
}) => {
  await dmDefault(page);
  await addAndPickRepo(page);
  const box = homeBox(page);
  await box.click();
  await box.pressSequentially("@sec");
  await expect(menu(page)).toBeVisible();
  await expect(page.locator('[data-mention-file="secret.env"]')).toHaveCount(0);
  await expect(
    page.locator('[data-mention-section="files"]').getByText("No matches"),
  ).toBeVisible();
  await box.fill("@untrack");
  await expect(page.locator('[data-mention-file="untracked.ts"]')).toBeVisible({
    timeout: 15_000,
  });
  await box.fill("@sr");
  const dirRow = page.locator('[data-mention-file="src"][data-kind="dir"]');
  await expect(dirRow).toBeVisible({ timeout: 15_000 });
  await expect(dirRow).toContainText("src/");
  await page.screenshot({ path: `${SHOTS}/ac-2-files.png` });
});

test("AC-3 + AC-4 picking a file inserts a chip; Backspace removes it; it survives reload and ↑ recall; the engine gets @path as text", async ({
  page,
}) => {
  await dmDefault(page);
  await addAndPickRepo(page);
  const box = homeBox(page);

  // Pick via the menu (keyboard path — focus stays in the textarea).
  await box.click();
  await box.pressSequentially("read @app");
  const row = page.locator('[data-mention-file="src/app.tsx"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await arrowDownTo(box, row);
  await box.press("Enter");
  await expect(box).toHaveValue("read @src/app.tsx ");

  // Backspace removes the whole chip (token + trailing space).
  await box.press("Backspace");
  await expect(box).toHaveValue("read ");

  // Re-insert, verify the draft survives a reload (draft store #103).
  await box.pressSequentially("@app");
  await expect(row).toBeVisible({ timeout: 15_000 });
  await arrowDownTo(box, row);
  await box.press("Enter");
  await expect(box).toHaveValue("read @src/app.tsx ");
  await page.screenshot({ path: `${SHOTS}/ac-3-chip-draft.png` });
  await page.reload();
  await expect(homeBox(page)).toHaveValue("read @src/app.tsx ", {
    timeout: 30_000,
  });

  // Send: the message shows the mention as a chip (inline code), and the
  // session opens on the repo (cwd carried through, like #113).
  await homeBox(page).press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/);
  await expect(
    page.locator("code").filter({ hasText: "@src/app.tsx" }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(
    page.locator("code").filter({ hasText: "@src/app.tsx" }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-sent-chip.png` });

  // ↑ recall in the thread composer brings the mention text back (#104).
  const replyBox = page.locator("textarea").last();
  await replyBox.click();
  await replyBox.press("ArrowUp");
  await expect(replyBox).toHaveValue("read @src/app.tsx");

  // AC-4: a follow-up mention reaches the engine as plain text — the fake's
  // reply plan echoes it verbatim. Wait for turn 1 to settle first: a message
  // sent mid-turn is a steer (no new reply), not a follow-up.
  await expect(page.getByText("Short answer").last()).toBeVisible({
    timeout: 30_000,
  });
  await replyBox.fill("note @docs/guide.md ");
  await replyBox.press("Enter");
  await expect(
    page.getByText("Noted. Plan for this session").last(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator("code").filter({ hasText: "@docs/guide.md" }).last(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-engine-plain-text.png` });
});

test("AC-5 the first results land inside the keystroke budget and fs.search is called per query", async ({
  page,
}) => {
  const searchCalls: number[] = [];
  page.on("request", (r) => {
    if (!r.url().endsWith("/host")) return;
    try {
      const m = JSON.parse(r.postData() ?? "{}") as {
        method?: string;
        params?: { query?: string };
      };
      if (m.method === "fs.search") searchCalls.push(Date.now());
    } catch {
      /* OPTIONS preflight carries no JSON body */
    }
  });
  await dmDefault(page);
  await addAndPickRepo(page);
  const box = homeBox(page);
  await box.click();
  const t0 = Date.now();
  await box.pressSequentially("@");
  await expect(fileRows(page).first()).toBeVisible({ timeout: 15_000 });
  const firstMs = Date.now() - t0;
  expect(firstMs).toBeLessThan(2000); // e2e smoke bound; the ~200ms AC is asserted in the host vitest
  await box.pressSequentially("app");
  await expect(page.locator('[data-mention-file="src/app.tsx"]')).toBeVisible({
    timeout: 15_000,
  });
  expect(searchCalls.length).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: `${SHOTS}/ac-5-responsive.png` });
});
