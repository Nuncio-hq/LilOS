import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";

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
  threadUrl,
  v3Main,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #771 as replaced by #854 — projects are the owner's by hand (real
 * stack: relay + harness + engine-fake). A thread in a folder no project
 * covers files as a plain Chat and keeps running there; the relay files a
 * thread under the deepest project containing its folder — never creating
 * one itself. `projects.create`/`projects.remove` are the only ways in or
 * out, and removing detaches: threads become chats, the folder is
 * untouched. The stack runs paused (LILOS_COMPANY=0, D-#836) — Oscar's
 * daily view; the new-project dialog's key field is company-only there.
 *
 *   AC-1 a folder-less thread is a plain chat; one opened in an uncovered
 *        folder is still a chat — its folder shows, and its badge offers
 *        "Add as project". The Projects heading and its ＋ show regardless.
 *   AC-2 Message on an agent opens the draft beside the page; sending turns
 *        that same peek into the thread (no extra step on the trail).
 *   AC-3 the sidebar's ＋ opens the folder picker with the project's name
 *        prefilled and editable — the key derives silently (no tickets in a
 *        paused app) — and creating it adopts the chats already running in
 *        that folder.
 *   AC-4 a chat's folder badge offers "Add as project" — the same dialog,
 *        pre-picked to the folder the chat already runs in.
 *   AC-5 a project row's ⋯ → Remove project detaches only the record: its
 *        threads are chats again and the folder is still on disk.
 *   AC-6 after a restart the projects and the chats are filed as before.
 *   AC-7 no "DM" anywhere on screen.
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

/* The chats the suite makes, shared across the serial tests — AC-5 and
   AC-6 reopen what AC-1 and AC-4 filed. */
let alphaChat = "";
let gammaChat = "";

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  /* Paused — Oscar's daily view (D-#836): the evidence below is the app
     the way he runs it, not the company layer the suite defaults to. */
  stack = await bootStack("ac771", await pickPorts(), {
    LILOS_COMPANY: "0",
  });
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

/** A chat opened over the relay with `cwd` — what a person starting a
    thread in that folder gets (D-#854: filing is lookup-only). */
async function chatInFolder(page: Page, folder: string, text: string) {
  /* The page must already sit on an http(s) origin: from about:blank the
     browser sends `Origin: null` and the relay refuses the upgrade. */
  if (!/^https?:/.test(page.url())) await page.goto(`${stack.webUrl}/`);
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
  const { conversation } = await relayRpc<{ conversation: { id: string } }>(
    page,
    stack,
    "conversations.open",
    { channelId: channel.id, authorId: "user", text, cwd: folder },
  );
  return conversation.id as string;
}

test("AC-1 a chat in a folder no project covers is a plain chat — folder shown, Add as project offered", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  // The Projects heading and its ＋ show even before the first project —
  // the way in is never hidden (#854).
  const side = v3Sidebar(page);
  await expect(side.getByText("Projects", { exact: true })).toBeVisible();
  await expect(
    side.getByRole("button", { name: "New project from a folder" }),
  ).toBeVisible();
  /* This is the paused app (D-#836): the company layer's nav never drew —
     no Work, Goals, Inbox, People, "Hire an agent", no company label. */
  for (const name of ["Work", "Goals", "Inbox", "People", "Hire an agent"])
    await expect(
      side.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toHaveCount(0);
  await expect(side.locator("[data-company-label]")).toHaveCount(0);
  // A chat with no folder: plain Chat, no folder badge.
  await startChat(page, stack.webUrl, DEFAULT_AGENT, "just talking");
  await expect(trail(page)).toContainText(`${DEFAULT_AGENT.name} · Chat`, {
    timeout: 30_000,
  });
  await expect(page.locator("[data-wsbadge]")).toHaveCount(0);
  await settled(page);
  await shoot(page, "ac-1-plain-chat");

  /* A thread opened in a folder is still a chat — the relay files by
     containment only, it never makes the folder's project (#854). */
  const conv = await chatInFolder(page, alpha, "hello in alpha");
  alphaChat = conv;
  await page.goto(threadUrl(stack.webUrl, conv));
  await expect(trail(page)).toContainText("Chat · lilos-alpha", {
    timeout: 30_000,
  });
  await expect(panel(page).locator("[data-wsbadge]")).toBeVisible({
    timeout: 30_000,
  });
  await settled(page);
  // No project row appeared; the Threads page files it under Chats.
  await expect(
    side.getByRole("button", { name: "lilos-alpha", exact: true }),
  ).toHaveCount(0);
  // The badge's menu offers "Add as project".
  await panel(page).locator("[data-wsbadge]").click();
  await expect(
    page.getByRole("menuitem", { name: "Add as project" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await shoot(page, "ac-1-folder-chat");
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

test("AC-3 the sidebar ＋ opens the folder picker — name and key prefilled, editable — and the project adopts the folder's chats", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  // A chat already running in beta — filed as a plain chat for now.
  const betaChat = await chatInFolder(page, beta, "beta chat, pre-project");
  await page.goto(threadUrl(stack.webUrl, betaChat));
  await expect(trail(page)).toContainText("Chat · lilos-beta", {
    timeout: 30_000,
  });

  /* The ＋ beside Projects opens the folder picker; the picked folder's
     name prefills and stays editable (D-#854). Paused, the key derives
     from the name silently — no Key field, no ticket words (D-#836). */
  await v3Sidebar(page)
    .getByRole("button", { name: "New project from a folder" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "New project from a folder",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Pick a folder for this project");
  await dialog.locator("[data-pathinput]").fill(beta);
  await expect(dialog.locator("[data-folderinfo]")).toContainText("Git repo", {
    timeout: 30_000,
  });
  const nameBox = dialog.locator("[data-projectname]");
  await expect(nameBox).toHaveValue("lilos-beta");
  // Editable — but the Key field and its ticket words never drew.
  await nameBox.fill("lilos-beta 2");
  await expect(nameBox).toHaveValue("lilos-beta 2");
  await nameBox.fill("lilos-beta");
  await expect(dialog.locator("[data-projectkey]")).toHaveCount(0);
  await expect(dialog).not.toContainText("prefixes");
  // The footer's path truncates from the left — the crumbs already name it.
  await expect(dialog.locator("[dir='rtl']").first()).toBeVisible();
  await shoot(page, "ac-3-new-project-dialog");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toHaveCount(0);

  /* The project lands in the sidebar, and the chat that ran in the folder
     before the project existed files under it now (adoption, D-#854). */
  const side = v3Sidebar(page);
  const row = side.getByRole("button", { name: "lilos-beta", exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  /* The key still got made — derived from the name, never asked for. */
  const { projects } = await relayRpc<{
    projects: { key: string; folder: string }[];
  }>(page, stack, "projects.list", {});
  expect(projects.find((p) => p.folder.endsWith("lilos-beta"))?.key).toBe(
    "LIL",
  );
  /* Creating it opened the project page (the peek closed) — reopen the
     chat; its trail now names the project it filed under (D-#854). */
  await page.goto(threadUrl(stack.webUrl, betaChat));
  await expect(trail(page)).toContainText("Default · lilos-beta", {
    timeout: 30_000,
  });
  await shoot(page, "ac-3-adopted");
  await row.click();
  const project = v3Main(page);
  await expect(project.getByText("Project", { exact: true })).toBeVisible();
  await expect(project).toContainText(shown(beta).replace(/^~/, ""), {
    timeout: 15_000,
  });
  await expect(
    project
      .locator("[data-project-live], [data-project-past]")
      .filter({ hasText: /beta chat, pre-project/i }),
  ).toHaveCount(1, { timeout: 30_000 });
  await noDm(page);
});

test("AC-4 a chat's folder badge offers Add as project — same dialog, pre-picked to its folder", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  const conv = await chatInFolder(page, gamma, "gamma chat");
  gammaChat = conv;
  await page.goto(threadUrl(stack.webUrl, conv));
  await expect(trail(page)).toContainText("Chat · lilos-gamma", {
    timeout: 30_000,
  });
  await expect(panel(page).locator("[data-wsbadge]")).toBeVisible({
    timeout: 30_000,
  });
  await settled(page);

  /* The badge's menu row opens the project dialog already picked to the
     chat's own folder (D-#854) — name prefilled, one Add. Paused: the key
     stays off this dialog too (D-#836). */
  await panel(page).locator("[data-wsbadge]").click();
  await page.getByRole("menuitem", { name: "Add as project" }).click();
  const dialog = page.getByRole("dialog", {
    name: "New project from a folder",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Pick a folder for this project");
  await expect(dialog.locator("[data-pathinput]")).not.toHaveValue("");
  await expect(dialog.locator("[data-folderinfo]")).toContainText("Git repo", {
    timeout: 30_000,
  });
  await expect(dialog.locator("[data-projectname]")).toHaveValue("lilos-gamma");
  await expect(dialog.locator("[data-projectkey]")).toHaveCount(0);
  await shoot(page, "ac-4-add-as-project-dialog");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toHaveCount(0);

  /* The thread files under the project it made: the trail names it and
     the sidebar lists the row. */
  await expect(trail(page)).toContainText("Default · lilos-gamma", {
    timeout: 30_000,
  });
  const side = v3Sidebar(page);
  await expect(
    side.getByRole("button", { name: "lilos-gamma", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  // The offer is gone — the folder is a project now.
  await panel(page).locator("[data-wsbadge]").click();
  await expect(
    page.getByRole("menuitem", { name: "Add as project" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await shoot(page, "ac-4-added");
  await noDm(page);
});

test("AC-5 Remove project detaches only the record — threads are chats again, the folder stays", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  const side = v3Sidebar(page);
  /* The row's ⋯ → Remove project… arms the one-line confirm inside the
     same popup (D-#854). */
  await side
    .getByRole("button", { name: "lilos-gamma — project menu" })
    .click();
  await page.getByRole("menuitem", { name: "Remove project…" }).click();
  await expect(
    page.getByText("Threads stay as chats; the folder isn't touched."),
  ).toBeVisible();
  await shoot(page, "ac-5-remove-confirm");
  await page.getByRole("menuitem", { name: /Remove lilos-gamma/ }).click();

  /* The record is gone; its threads became chats again; the folder itself
     is still on disk. */
  await expect(
    side.getByRole("button", { name: "lilos-gamma", exact: true }),
  ).toHaveCount(0, { timeout: 30_000 });
  /* Reopened, the chat that filed under lilos-gamma is a Chat in its folder
     again — "Chat · lilos-gamma" where the trail named the project. */
  await page.goto(threadUrl(stack.webUrl, gammaChat));
  await expect(trail(page)).toContainText("Chat · lilos-gamma", {
    timeout: 30_000,
  });
  await expect(panel(page).locator("[data-wsbadge]")).toBeVisible({
    timeout: 30_000,
  });
  expect(existsSync(gamma)).toBe(true);
  await shoot(page, "ac-5-removed");
  await noDm(page);
});

test("AC-6 after a restart the projects and the chats are filed as before; nothing is lost", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  const { home } = stack;
  /* keepHome: the restart boots on this LILOS_HOME — the owning stack's
     stop must leave it (r10 scratch-HOME cleanup). */
  await stack.stop({ keepHome: true });
  // Fresh ports. Rebinding the ports the stopped stack just released is
  // the pick-then-bind gap (#825); the page loads the new origin below.
  stack = await bootStack(
    "ac771",
    await pickPorts(),
    { LILOS_COMPANY: "0" },
    { home },
  );
  await page.goto(`${stack.webUrl}/`);
  const side = v3Sidebar(page);
  // lilos-beta survives; lilos-gamma stayed removed; nothing re-filed.
  await expect(
    side.getByRole("button", { name: "lilos-beta", exact: true }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    side.getByRole("button", { name: "lilos-gamma", exact: true }),
  ).toHaveCount(0);
  await side.getByRole("button", { name: "lilos-beta", exact: true }).click();
  await expect(
    v3Main(page)
      .locator("[data-project-live], [data-project-past]")
      .filter({ hasText: /beta chat, pre-project/i }),
  ).toHaveCount(1, { timeout: 30_000 });
  /* The alpha and gamma chats are still chats in their folders after the
     restart — the trails name Chat, not a project. */
  await page.goto(threadUrl(stack.webUrl, alphaChat));
  await expect(trail(page)).toContainText("Chat · lilos-alpha", {
    timeout: 30_000,
  });
  await page.goto(threadUrl(stack.webUrl, gammaChat));
  await expect(trail(page)).toContainText("Chat · lilos-gamma", {
    timeout: 30_000,
  });
  await shoot(page, "ac-6-after-restart");
  await noDm(page);
});
