import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  v3Main,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #193 — an employee with no DM channel hung the DM page on the
 * session skeleton forever (`!channel` read as "loading"). The harness now
 * opens the DM channel at first-run hire, and a send opens it itself
 * (idempotent `channels.openDm`) when it is really absent. Covers #189 too:
 * an unknown employee id lands on a not-found state instead of "Loading…".
 *
 * v3: the DM page and its skeleton are gone. A person's chat is the new-chat
 * draft in the side peek (`#?page=threads&open=newchat:<id>`), which has no
 * loading skeleton to get stuck on, so the legs assert what is still true:
 * the DM channel exists on the relay right after the first-run hire (AC-1),
 * a relay-created employee without one gets it opened by the first send
 * (AC-4), and an unknown agent id lands on the agent page's own "no longer on
 * the team" state (AC-5).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-193");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac193", await pickPorts(), {
    // #118: pin the signed-in name so the Welcome's first step (a name is
    // required to go on) is filled deterministically. #885: no company
    // field anymore — the name is all it asks.
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

/** The DM channels the relay holds for `employeeId`. */
async function dmChannels(page: Page, employeeId: string) {
  const { channels } = await relayRpc<{
    channels: { id: string; kind: string; employeeId?: string }[];
  }>(page, stack, "channels.list", {});
  return channels.filter((c) => c.kind === "dm" && c.employeeId === employeeId);
}

test("AC-1 first-run hire's DM channel exists, and the new chat with it is ready to type", async ({
  page,
}) => {
  // No skipFirstRun: this is the first run.
  await page.goto(`${stack.webUrl}/`);
  await expect(page.getByLabel("Your name")).toHaveValue("Oscar", {
    timeout: 30_000,
  });
  const next = page.getByRole("button", { name: "Next", exact: true });
  await next.click(); // → Your first agent
  await next.click(); // → First project
  await page.getByRole("button", { name: "Start" }).click();

  // The harness opened the DM channel at hire — it is on the relay already.
  const sidebar = v3Sidebar(page);
  await expect(sidebar.getByRole("button", { name: /Default/ })).toBeVisible({
    timeout: 30_000,
  });
  const { employees } = await relayRpc<{
    employees: { id: string; name: string }[];
  }>(page, stack, "employees.list", {});
  const first = employees.find((e) => e.name === "Default");
  if (!first) throw new Error("no Default employee on the relay");
  expect((await dmChannels(page, first.id)).length).toBe(1);

  // Their page → Message: the draft's composer is up and usable. The
  // sidebar pick jumped to the person's page (D-#769); Message peeks beside it.
  await sidebar.getByRole("button", { name: /Default/ }).click();
  await v3Main(page).getByRole("button", { name: "Message" }).click();
  const box = v3Peek(page).getByPlaceholder("Message Default…");
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(box).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/ac-1-empty-state.png` });
});

test("AC-4 a relay-created employee with no DM channel gets one opened by the first send", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  const { employee } = await relayRpc<{ employee: { id: string } }>(
    page,
    stack,
    "employees.create",
    { name: "Ghost", role: "engineer", profile: "builder" },
  );
  // Nothing opened a DM for it: the relay holds no channel yet.
  expect((await dmChannels(page, employee.id)).length).toBe(0);
  // The directory carries it live (no reload): it is in the sidebar.
  await expect(
    v3Sidebar(page).getByRole("button", { name: /Ghost/ }),
  ).toBeVisible({ timeout: 15_000 });

  // The draft settles at once — no endless wait on a channel that isn't there.
  await page.goto(
    `${stack.webUrl}/#?page=threads&open=newchat:${encodeURIComponent(employee.id)}`,
  );
  const box = v3Peek(page).getByPlaceholder("Message Ghost…");
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(v3Peek(page).getByText("Talk to Ghost directly.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-4-empty-state.png` });

  // The first message still works — the send opens the channel and a
  // conversation on it, and the thread takes the draft's place.
  await box.fill("hello from the void");
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 15_000 });
  await expect(
    page
      .locator("[data-thread-panel] [data-msg]")
      .filter({ hasText: "hello from the void" }),
  ).toBeVisible({ timeout: 15_000 });
  expect((await dmChannels(page, employee.id)).length).toBe(1);
  await page.screenshot({ path: `${SHOTS}/ac-4-first-send.png` });
});

test("AC-5 (#189) an unknown agent id lands on a not-found state", async ({
  page,
}) => {
  await skipFirstRun(page);
  await page.goto(
    `${stack.webUrl}/#?page=people&open=agent:emp-does-not-exist`,
  );
  await expect(
    v3Peek(page).getByText("This agent is no longer on the team."),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Loading…")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-5-not-found.png` });
});
