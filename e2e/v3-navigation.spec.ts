import { expect, type Page, test } from "@playwright/test";
import {
  agentUrl,
  bootStack,
  openDefaultAgent,
  panelIntoFocus,
  pickPorts,
  type Stack,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Navigation in the v3 shell never loses where you were (real stack: relay +
 * harness on engine-fake). You live on a page; whatever you open from it
 * stacks in a side peek beside it, with a trail back through every step.
 * Esc, Back/Forward and a reload all land on the same place, because where
 * you are lives in the URL hash.
 */

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("v3nav", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.locator("#v3-main");
const trail = (page: Page) =>
  v3Peek(page).getByRole("navigation", { name: "Trail" });
/** The trail as a person reads it, left to right: People › Ada › Ada · Chat. */
const expectTrail = (page: Page, ...steps: string[]) =>
  expect(trail(page)).toHaveText(steps.join(" "), { useInnerText: true });
const widenButton = (page: Page) =>
  v3Peek(page).getByTitle("Widen over the page", { exact: true });
const narrowButton = (page: Page) =>
  v3Peek(page).getByTitle("Narrow, back beside the page", { exact: true });
/** Esc as pressed with the caret out of the composer (a field keeps its own
 *  Esc, and the shell leaves a typing person alone). */
const esc = async (page: Page) => {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press("Escape");
};

test("People › agent › New chat › thread: every step stays on the trail, the page stays put, Esc and Back walk it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  const THREAD_URL = /[?&]open=agent:[^&,]+,thread:conv_[^&,]+(&|$)/;
  const FULL_URL = /[?&]full=1(&|$)/;

  // Start on People and open a person: they land beside the page.
  await v3Sidebar(page)
    .getByRole("button", { name: "People", exact: true })
    .click();
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
    "People",
  );
  await main(page)
    .getByRole("button", { name: new RegExp(agent.name) })
    .click();
  await expect(page).toHaveURL(/[?&]page=people&open=agent:[^&,]+$/);
  await expectTrail(page, "People", agent.name);
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
    "People",
  );

  // New chat from their page extends the trail; the person stays on it.
  await v3Peek(page).getByRole("button", { name: "Message" }).click();
  await expectTrail(page, "People", agent.name, `New chat · ${agent.name}`);
  await v3Peek(page)
    .getByPlaceholder(`Message ${agent.name}…`)
    .fill("Say hello then list files");
  await v3Peek(page).getByRole("button", { name: "Send" }).click();

  // The sent draft becomes its thread in the same place on the trail.
  await expect(page).toHaveURL(THREAD_URL, { timeout: 30_000 });
  await expectTrail(page, "People", agent.name, `${agent.name} · Chat`);
  await expect(page.locator("[data-thread-panel]")).toBeVisible({
    timeout: 30_000,
  });
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
    "People",
  );

  // A step back on the trail shows the person's page again, with the chat
  // listed on it; opening it from there puts it back on the trail.
  await trail(page)
    .getByRole("button", { name: agent.name, exact: true })
    .click();
  await expectTrail(page, "People", agent.name);
  await expect(page).not.toHaveURL(/thread:/);
  const chat = v3Peek(page).getByRole("button", {
    name: /say hello then list files/i,
  });
  await expect(chat).toBeVisible({ timeout: 30_000 });
  await chat.click();
  await expectTrail(page, "People", agent.name, `${agent.name} · Chat`);
  await expect(page).toHaveURL(THREAD_URL);

  // Widen: the session view. Narrow is now what the same control offers.
  await panelIntoFocus(page);
  await expect(narrowButton(page)).toBeVisible();
  await expectTrail(page, "People", agent.name, `${agent.name} · Chat`);

  // A reload with a record open (and widened) restores exactly that.
  await page.reload();
  await expect(page).toHaveURL(FULL_URL);
  await expect(page.locator("[data-thread-panel]")).toBeVisible({
    timeout: 30_000,
  });
  await expect(narrowButton(page)).toBeVisible();
  await expectTrail(page, "People", agent.name, `${agent.name} · Chat`);

  // Esc steps back one layer at a time: session → thread beside People →
  // closed, with the page you started on untouched.
  await esc(page);
  await expect(page).toHaveURL(THREAD_URL);
  await expect(page).not.toHaveURL(FULL_URL);
  await expect(widenButton(page)).toBeVisible();
  await expect(page.locator("[data-thread-panel]")).toBeVisible();
  await esc(page);
  await expect(page).toHaveURL(/#\?page=people$/);
  await expect(v3Peek(page)).toHaveCount(0);
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
    "People",
  );

  // Back restores page + peek + width, step by step; Forward returns.
  await page.goBack();
  await expect(page).toHaveURL(THREAD_URL);
  await expect(page).not.toHaveURL(FULL_URL);
  await expectTrail(page, "People", agent.name, `${agent.name} · Chat`);
  await expect(widenButton(page)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(FULL_URL);
  await expect(narrowButton(page)).toBeVisible();
  await expect(page.locator("[data-thread-panel]")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(THREAD_URL);
  await expect(page).not.toHaveURL(FULL_URL);
  await expect(widenButton(page)).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/#\?page=people$/);
  await expect(v3Peek(page)).toHaveCount(0);
});

test("a link to a person or a draft chat opens beside its page, and a reload keeps it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await openDefaultAgent(page, stack.webUrl);

  // A person's page, linked straight, beside People.
  await page.goto(agentUrl(stack.webUrl, agent.id));
  await page.reload();
  await expectTrail(page, "People", agent.name);
  await expect(v3Peek(page)).toContainText(agent.name);
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
    "People",
  );

  // Esc puts you back on the page with nothing open.
  await esc(page);
  await expect(v3Peek(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#\?page=people$/);

  // A draft chat is a record too: it survives a reload with its composer.
  await page.goto(
    `${stack.webUrl}/#?page=people&open=agent:${encodeURIComponent(agent.id)},newchat:${encodeURIComponent(agent.id)}`,
  );
  await page.reload();
  await expectTrail(page, "People", agent.name, `New chat · ${agent.name}`);
  await expect(
    v3Peek(page).getByPlaceholder(`Message ${agent.name}…`),
  ).toBeVisible({ timeout: 30_000 });

  // Back one step on the trail (the header's arrow) returns to their page.
  await v3Peek(page).getByTitle("Back one step").click();
  await expectTrail(page, "People", agent.name);
  await expect(page).toHaveURL(/open=agent:[^&,]+$/);
});
