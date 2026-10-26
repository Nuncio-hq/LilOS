import { expect, type Page, test } from "@playwright/test";
import { HIRE_TEMPLATES } from "../packages/ui/src/v3/hire-templates";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  relayRpc,
  skipFirstRun,
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";
import { releaseStuckClear } from "./helpers/stuck-clear";

/**
 * Issue #775 — People. One test per acceptance criterion, on the real stack.
 * Statuses come from the same derivation as Threads. Week counts are threads
 * finished or failed since Monday, plus threads whose stuckAt falls this
 * week. `stuck: clear` marks a thread and then recovers it; the week number
 * still counts that thread. The live Stuck pill does not.
 *
 * Instructions: soul is not a field of `session.start`. The next thread's
 * `session.started` names the profile, and `agents.describe` of that profile
 * is the row the engine resolved — the same check the instruction specs use.
 */

const main = (page: Page) => page.locator("#v3-main");

const RESEARCHER = HIRE_TEMPLATES.find((t) => t.role === "Researcher");
if (!RESEARCHER) throw new Error("Researcher template missing");

/** Light and dark at the moment a criterion holds. */
async function shot(page: Page, name: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: `test-results/ac-775/${name}-${colorScheme}.png`,
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("statuses and this week's counts, including a thread that recovered from stuck", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const stack = await bootStack("ac775-week", await pickPorts());
  try {
    const agent = await openDefaultAgent(page, stack.webUrl);
    await startChat(
      page,
      stack.webUrl,
      agent,
      "Say hi about the weekly digest",
    );
    await expect(v3Peek(page).locator("[data-agentturn]").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      v3Peek(page).getByRole("button", { name: /^stop/i }),
    ).toHaveCount(0);

    await startChat(page, stack.webUrl, agent, "fail the weekly digest");
    await expect(
      v3Peek(page).locator("[data-turn-failed]").first(),
    ).toBeVisible({ timeout: 60_000 });

    await startChat(
      page,
      stack.webUrl,
      agent,
      "LILOS_TURN_HOLD release note people",
    );
    await expect(
      v3Peek(page).getByRole("button", { name: /^stop/i }),
    ).toBeVisible({ timeout: 30_000 });

    await startChat(page, stack.webUrl, agent, "stuck: clear");
    await expect(page.locator("[data-stuck]")).toContainText(
      "Same web search 6 times",
      { timeout: 20_000 },
    );
    /* The different step clears the mark. The stamp stays, so the week
       still counts this thread once the card is gone. Connecting is what
       lets that step run. The card leaves when that step starts; the
       week's finished count includes the thread only after the answer
       lands, so read the row then. */
    await releaseStuckClear(stack.home);
    await expect(page.locator("[data-stuck]")).toBeHidden({ timeout: 20_000 });
    await expect(v3Peek(page)).toContainText("A different page this time.", {
      timeout: 20_000,
    });
    await expect(
      v3Peek(page).getByRole("button", { name: /^stop/i }),
    ).toHaveCount(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${stack.webUrl}/#?page=people`);
    const row = main(page).getByRole("button", {
      name: new RegExp(agent.name, "i"),
    });
    /* The hold thread is the live one, so the row wears Working. The week
       word is the lowercase count, not that pill. */
    await expect(row).toContainText("Working");
    /* "1 finished" already matches the first thread. This stack has
       exactly two, so the row is readable only at 2. */
    await expect(row).toContainText(/2 finished/, { timeout: 20_000 });
    await expect(row).toContainText(/[1-9]\d* failed/);
    await expect(row).toContainText(/[1-9]\d* stuck/);
    const text = await row.innerText();
    const finished = Number(/(\d+) finished/.exec(text)?.[1]);
    const failed = Number(/(\d+) failed/.exec(text)?.[1]);
    const stuck = Number(/(\d+) stuck/.exec(text)?.[1]);
    await shot(page, "01-week");

    await row.click();
    /* The agent's page opens in the side peek, beside People. */
    const stat = (label: string) =>
      v3Peek(page).getByText(label, { exact: true }).locator("..").locator("b");
    await expect(stat("threads stuck")).toHaveText(String(stuck));
    await expect(stat("threads stuck")).toHaveClass(/text-red-600/);
    await expect(stat("threads failed")).toHaveClass(/text-red-600/);

    /* The same list grouped by agent (#862's "Group by" switch): this
       agent's fold holds its threads, statuses as dots. Match the fold by
       its agent marker, not its text — the avatar's letter chip leads the
       name, so a starts-with match would miss. */
    await page.goto(`${stack.webUrl}/#?page=threads`);
    await main(page).getByRole("radio", { name: "Agent", exact: true }).click();
    const block = main(page).locator(`[data-fold="agent:${agent.id}"]`);
    await expect(
      block.locator('[data-thread-row]:has([data-v3-status="done"])'),
    ).toHaveCount(finished);
    await expect(
      block.locator('[data-thread-row]:has([data-v3-status="failed"])'),
    ).toHaveCount(failed);
    await expect(
      block
        .locator('[data-thread-row]:has([data-v3-status="working"])')
        .filter({ hasText: /release note/i }),
    ).toHaveCount(1);
    /* The live tally is 0. The recovered thread's title is "Stuck" and its
       dot says done, so a title named Stuck is not a stuck thread.
       The week number above is the stamp. */
    await expect(
      main(page).getByText("0 stuck", { exact: true }),
    ).toBeVisible();
    await expect(
      block.locator('[data-thread-row]:has([data-v3-status="stuck"])'),
    ).toHaveCount(0);
    const stuckTitled = block
      .locator("[data-thread-row]")
      .filter({ hasText: /^Stuck/ });
    await expect(stuckTitled).toHaveCount(1);
    await expect(stuckTitled.locator('[data-v3-status="done"]')).toHaveCount(1);
  } finally {
    await stack.stop();
  }
});

test("editing instructions persists, and the next thread's session starts on that profile", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("ac775-soul", await pickPorts());
  try {
    const sentence = "You answer the people page in one short sentence.";
    const agent = await openDefaultAgent(page, stack.webUrl);
    const peek = v3Peek(page);
    await peek.getByRole("button", { name: "Edit" }).click();
    await peek.getByRole("textbox", { name: "Instructions" }).fill(sentence);
    await peek.getByRole("button", { name: "Save" }).click();
    await expect(peek.getByRole("button", { name: "Edit" })).toBeVisible();

    await page.reload();
    await expect(v3Peek(page)).toContainText(sentence);
    await shot(page, "02-instructions");

    const listed = await relayRpc<{
      employees: { id: string; profile: string; instructions: string }[];
    }>(page, stack, "employees.list", {});
    const row = listed.employees.find((e) => e.id === agent.id);
    expect(row?.instructions).toBe(sentence);
    const described = await relayRpc<{ agent: { soul?: string } }>(
      page,
      stack,
      "agents.describe",
      { id: row?.profile ?? "" },
    );
    expect(described.agent.soul).toBe(sentence);

    await v3Peek(page).getByRole("button", { name: "Message" }).click();
    await v3Peek(page)
      .getByPlaceholder(`Message ${agent.name}…`)
      .fill("Say hi");
    await v3Peek(page).getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/thread:[^&,]+/, { timeout: 30_000 });
    const conversationId = decodeURIComponent(
      /thread:([^&,]+)/.exec(page.url())?.[1] ?? "",
    );
    expect(conversationId).not.toBe("");
    await expect(v3Peek(page).locator("[data-agentturn]").first()).toBeVisible({
      timeout: 60_000,
    });

    const events = await relayRpc<{
      events: { type: string; payload?: { agent?: string } }[];
    }>(page, stack, "session.events", { conversationId, after: 0 });
    const started = events.events.find((e) => e.type === "session.started");
    // soul is not a session.start field: the payload names the profile,
    // and that profile's soul is what the engine read.
    expect(started?.payload?.agent).toBe(row?.profile);
    const again = await relayRpc<{ agent: { soul?: string } }>(
      page,
      stack,
      "agents.describe",
      { id: started?.payload?.agent ?? "" },
    );
    expect(again.agent.soul).toBe(sentence);
  } finally {
    await stack.stop();
  }
});

test("Hire, then message the new agent at once", async ({ page }) => {
  test.setTimeout(180_000);
  const stack = await bootStack("ac775-hire", await pickPorts());
  try {
    await skipFirstRun(page);
    await page.goto(`${stack.webUrl}/`);
    const side = v3Sidebar(page);
    await expect(side.getByRole("button", { name: /Default/ })).toBeVisible({
      timeout: 30_000,
    });
    await side.getByRole("button", { name: "Hire an agent" }).click();
    await main(page)
      .getByRole("button", { name: /Researcher/ })
      .click();
    await main(page).getByPlaceholder("Name").fill("Pia");
    await expect(main(page).locator("form")).toContainText("engine-fake", {
      ignoreCase: true,
      timeout: 30_000,
    });
    await main(page)
      .locator("form")
      .getByRole("button", { name: "Fake Reasoning", exact: true })
      .click();
    await main(page).getByRole("button", { name: "Hire", exact: true }).click();
    await expect(page).toHaveURL(/open=agent:/, { timeout: 30_000 });
    await expect(v3Peek(page).getByRole("heading", { level: 1 })).toHaveText(
      "Pia",
    );
    await expect(v3Peek(page)).toContainText(RESEARCHER.instructions, {
      timeout: 30_000,
    });
    await shot(page, "03-hire");

    await v3Peek(page).getByRole("button", { name: "Message" }).click();
    await v3Peek(page).getByPlaceholder("Message Pia…").fill("Say hi");
    await v3Peek(page).getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/thread:[^&,]+/, { timeout: 30_000 });
    await expect(v3Peek(page).locator("[data-agentturn]").first()).toBeVisible({
      timeout: 60_000,
    });

    const listed = await relayRpc<{
      employees: {
        name: string;
        profile?: string;
        instructions: string;
        reportsTo?: string;
      }[];
    }>(page, stack, "employees.list", {});
    const pia = listed.employees.find((e) => e.name === "Pia");
    expect(pia?.reportsTo).toBeUndefined();
    expect(pia?.instructions).toBe(RESEARCHER.instructions);
    const described = await relayRpc<{ agent: { soul?: string } }>(
      page,
      stack,
      "agents.describe",
      { id: pia?.profile ?? "" },
    );
    expect(described.agent.soul).toBe(RESEARCHER.instructions);
  } finally {
    await stack.stop();
  }
});

test("the org chart reflects reportsTo, and the owner is the profile name", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("ac775-org", await pickPorts());
  try {
    const agent = await openDefaultAgent(page, stack.webUrl);
    await relayRpc(page, stack, "profile.update", { userName: "Nia" });
    const created = await relayRpc<{ employee: { id: string } }>(
      page,
      stack,
      "employees.create",
      { name: "Quill", role: "Notes" },
    );
    await relayRpc(page, stack, "employees.update", {
      id: created.employee.id,
      reportsTo: agent.id,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${stack.webUrl}/#?page=people&view=org`);
    await page.reload();
    const ownerNode = main(page).locator("[data-reports-to='owner']");
    await expect(
      main(page).getByRole("button", { name: /Hire an agent/ }),
    ).toHaveCount(0);
    await expect(ownerNode).toHaveCount(1);
    await expect(ownerNode).toContainText(agent.name);
    const under = main(page).locator(`[data-reports-to="${agent.id}"]`);
    await expect(under).toContainText("Quill");
    await expect(
      main(page).getByText("Nia", { exact: true }).first(),
    ).toBeVisible();
    await shot(page, "04-org");

    await page.goto(
      `${stack.webUrl}/#?page=people&open=agent:${encodeURIComponent(agent.id)}`,
    );
    await expect(v3Peek(page)).toContainText("reports to Nia");
    await page.goto(
      `${stack.webUrl}/#?page=people&open=agent:${encodeURIComponent(created.employee.id)}`,
    );
    await expect(v3Peek(page)).toContainText(`reports to ${agent.name}`);
  } finally {
    await stack.stop();
  }
});
