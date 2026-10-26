import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  startChat,
  startChatInFolder,
  v3Main,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #771 — Projects, and no more DMs (real stack: relay + harness +
 * engine-fake). A thread is in a project or a plain chat; the relay files it
 * from the folder it opens or moves into.
 *
 *   AC-1 a thread opened in a folder appears under that folder's project
 *        (sidebar → project page, live and past); one opened with no folder
 *        is a plain chat with no project.
 *   AC-2 Message on an agent opens the draft beside the page; sending turns
 *        that same peek into the thread (no extra step on the trail).
 *   AC-3 "New project from a folder…" makes the project and picks it.
 *   AC-4 after a restart every thread is still under its project.
 *   AC-5 no "DM" anywhere on screen.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const SHOTS = path.join(here, "..", "test-results", "ac-771");
mkdirSync(SHOTS, { recursive: true });

/* Real dirs under the stack's scratch ~/repos (r10 — a folder dialog pick
   is a host read, gated to the harness's home folder, and `~` collapses
   against it; a fixture in the real ~/repos is unreachable). */
let ROOT: string;
let alpha: string;
let beta: string;
let gamma: string;
const shown = (abs: string) => `~${abs.slice(stack.home.length)}`;

const DEFAULT_AGENT = { id: "default", name: "Default" };

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac771", await pickPorts());
  mkdirSync(path.join(stack.home, "repos"), { recursive: true });
  ROOT = mkdtempSync(path.join(stack.home, "repos", "lilos-771-"));
  alpha = path.join(ROOT, "lilos-alpha");
  beta = path.join(ROOT, "lilos-beta");
  gamma = path.join(ROOT, "lilos-gamma");
  for (const dir of [alpha, beta, gamma]) {
    mkdirSync(dir);
    execSync("git init -b main", { cwd: dir });
  }
});
test.afterAll(async () => {
  const home = stack?.home;
  await stack?.stop();
  /* The restart boot rode `opts.home` (non-owning) — the suite removes
     the shared home itself. */
  if (home) rmSync(home, { recursive: true, force: true });
});
test.describe.configure({ mode: "serial" });

const trail = (page: Page) =>
  v3Peek(page).getByRole("navigation", { name: "Trail" });
const panel = (page: Page) => page.locator("[data-thread-panel]");
const noDm = async (page: Page) =>
  expect(await page.locator("body").innerText()).not.toMatch(/\bDMs?\b/);

/** One screenshot per colour scheme, named for the criterion. */
async function shoot(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // The peek fades in: finish it, so the evidence shows the record itself.
    await page.screenshot({
      path: path.join(SHOTS, `${name}-${scheme}.png`),
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const settled = (page: Page) =>
  expect(panel(page).locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 60_000,
  });

test("AC-1 a plain chat has no project; a thread opened in a folder is listed on that project's page", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  // A company with no folder yet: no Projects heading, and a chat is plain.
  await startChat(page, stack.webUrl, DEFAULT_AGENT, "just talking");
  await expect(trail(page)).toContainText(`${DEFAULT_AGENT.name} · Chat`, {
    timeout: 30_000,
  });
  await expect(page.locator("[data-wsbadge]")).toHaveCount(0);
  await expect(
    v3Sidebar(page).getByText("Projects", { exact: true }),
  ).toHaveCount(0);
  await settled(page);
  await shoot(page, "ac-1-plain-chat");

  // A thread opened with a folder: the relay makes the folder's project.
  await startChatInFolder(page, stack, DEFAULT_AGENT, alpha, "hello in alpha");
  await expect(trail(page)).toContainText("lilos-alpha", { timeout: 30_000 });
  await settled(page);
  const side = v3Sidebar(page);
  await expect(side.getByText("Projects", { exact: true })).toBeVisible();
  // A sidebar project row is a jump: the project IS the page (D-#769),
  // its threads list on it.
  await side.getByRole("button", { name: "lilos-alpha" }).click();
  const project = v3Main(page);
  await expect(project.getByText("Project", { exact: true })).toBeVisible();
  await expect(project).toContainText(shown(alpha).replace(/^~/, ""), {
    timeout: 15_000,
  });
  // Live or past, the thread is listed here, and the plain chat is not.
  const listed = project.locator("[data-project-live], [data-project-past]");
  await expect(listed.getByText(/hello in alpha/i)).toHaveCount(1);
  await expect(listed.getByText(/just talking/i)).toHaveCount(0);
  await expect(project.locator("[data-project-past]")).toContainText(
    /hello in alpha/i,
    { timeout: 30_000 },
  );
  await shoot(page, "ac-1-project-page");
  await noDm(page);
});

test("AC-2 Message on an agent opens the draft beside the page; sending turns it into the thread in place", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  const peek = v3Peek(page);
  await peek.getByRole("button", { name: "Message" }).click();
  await expect(page).toHaveURL(/open=agent:[^,&]+,newchat:/);
  const box = peek.getByPlaceholder(`Message ${agent.name}…`);
  await expect(box).toBeVisible();
  // Project and model are small chips under the box; no picker first.
  await expect(peek.getByTitle(/^Project · /)).toBeVisible();
  await shoot(page, "ac-2-draft-beside-page");
  const before = await trail(page).locator("span, button").count();
  await box.fill("hello from the draft");
  await peek.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=agent:[^,&]+,thread:[^&,]+/, {
    timeout: 30_000,
  });
  await expect(page).not.toHaveURL(/newchat/);
  await expect(trail(page)).toContainText(`${agent.name} · `);
  // The draft's place on the trail became the thread: same number of steps.
  expect(await trail(page).locator("span, button").count()).toBe(before);
  await settled(page);
  await shoot(page, "ac-2-thread-in-place");
  await noDm(page);
});

test("AC-3 New project from a folder makes the project and picks it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
  const peek = v3Peek(page);
  const chip = peek.getByTitle(/^Project · /);
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await expect(
    peek.getByRole("menuitemradio", { name: /No project · just chat/ }),
  ).toBeVisible();
  await peek
    .getByRole("menuitem", { name: "New project from a folder…" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "New project from a folder",
  });
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-pathinput]").fill(beta);
  await expect(dialog.locator("[data-folderinfo]")).toContainText("Git repo", {
    timeout: 30_000,
  });
  await shoot(page, "ac-3-new-project-dialog");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(chip).toContainText("lilos-beta", { timeout: 30_000 });
  await expect(
    v3Sidebar(page).getByRole("button", { name: "lilos-beta" }),
  ).toBeVisible();
  await peek.getByPlaceholder("Message Default…").fill("hello in beta");
  await peek.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  await expect(trail(page)).toContainText("Default · lilos-beta", {
    timeout: 30_000,
  });
  await shoot(page, "ac-3-new-project-picked");
});

test("AC-4 after a restart every thread is still under its project; nothing is lost", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  // A thread opened over the relay in a third folder, as any client would.
  const { employees } = await relayRpc<{ employees: { id: string }[] }>(
    page,
    stack,
    "employees.list",
    {},
  );
  const { channel } = await relayRpc<{ channel: { id: string } }>(
    page,
    stack,
    "channels.openDm",
    { employeeId: employees[0].id },
  );
  await relayRpc(page, stack, "conversations.open", {
    channelId: channel.id,
    authorId: "user",
    text: "hello in gamma",
    cwd: gamma,
  });
  const { home } = stack;
  /* keepHome: the restart boots on this LILOS_HOME — the owning stack's
     stop must leave it (r10 scratch-HOME cleanup). */
  await stack.stop({ keepHome: true });
  // Fresh ports. Rebinding the ports the stopped stack just released is
  // the pick-then-bind gap (#825); the page loads the new origin below.
  stack = await bootStack("ac771b", await pickPorts(), {}, { home });
  await page.goto(`${stack.webUrl}/`);
  const side = v3Sidebar(page);
  for (const name of ["lilos-alpha", "lilos-beta", "lilos-gamma"])
    await expect(side.getByRole("button", { name })).toBeVisible({
      timeout: 60_000,
    });
  await side.getByRole("button", { name: "lilos-gamma" }).click();
  await expect(
    v3Main(page)
      .locator("[data-project-live], [data-project-past]")
      .filter({ hasText: /hello in gamma/i }),
  ).toHaveCount(1, { timeout: 30_000 });
  await shoot(page, "ac-4-after-restart");
  await noDm(page);
});
