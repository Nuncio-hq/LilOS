import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  relayRpc,
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #778 — the CEO is a position. One test per acceptance criterion.
 *
 * Tools are not a field of `session.started`. The harness stamps the offer
 * onto the session's MCP spec before `session.start`; engine-fake logs
 * `session.start agent=<profile> ceo=<0|1> ceoTools=<names|->`, and the
 * launcher mirrors that line into harness.log. The gateway still filters
 * the catalog and rejects the call. Soul stays the employee's own.
 */

const main = (page: Page) => page.locator("#v3-main");
const CHIP = "[title='Holds the CEO position']";

/** Light and dark at the moment a criterion holds. */
async function shot(page: Page, name: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: `test-results/ac-778/${name}-${colorScheme}.png`,
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("Make CEO moves the chip everywhere and redraws the org chart", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("ac778-chip", await pickPorts());
  try {
    const agent = await openDefaultAgent(page, stack.webUrl);
    const created = await relayRpc<{ employee: { id: string } }>(
      page,
      stack,
      "employees.create",
      {
        name: "Quill",
        role: "Notes",
        status: "online",
        profile: "builder",
        model: "fake-large",
        instructions: "You take notes.",
      },
    );
    await relayRpc(page, stack, "channels.openDm", {
      employeeId: created.employee.id,
    });
    const quillId = created.employee.id;

    await page.goto(`${stack.webUrl}/#?page=home`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Good afternoon",
      { timeout: 30_000 },
    );
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
    await expect(page.getByText("Ask the CEO", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(CHIP)).toHaveCount(0);

    await page.goto(
      `${stack.webUrl}/#?page=people&open=agent:${encodeURIComponent(quillId)}`,
    );
    await expect(
      v3Peek(page).getByRole("button", { name: "Make CEO" }),
    ).toBeVisible({ timeout: 30_000 });
    await v3Peek(page).getByRole("button", { name: "Make CEO" }).click();
    await expect(v3Peek(page).locator(CHIP)).toBeVisible({ timeout: 15_000 });
    await expect(
      v3Peek(page).getByRole("button", { name: "Make CEO" }),
    ).toHaveCount(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${stack.webUrl}/#?page=people&view=org`);
    const ownerNode = main(page).locator("[data-reports-to='owner']");
    await expect(ownerNode).toHaveCount(1);
    await expect(ownerNode).toContainText("Quill");
    await expect(ownerNode.locator(CHIP)).toBeVisible();
    const under = main(page).locator(`[data-reports-to="${quillId}"]`);
    await expect(under).toContainText(agent.name);
    await expect(under.locator(CHIP)).toHaveCount(0);

    const side = v3Sidebar(page);
    await expect(
      side.getByRole("button", { name: /Quill/ }).locator(CHIP),
    ).toBeVisible();
    await expect(
      side.getByRole("button", { name: /default/i }).locator(CHIP),
    ).toHaveCount(0);

    await page.goto(`${stack.webUrl}/#?page=people`);
    await expect(
      main(page).getByRole("button", { name: /Quill/ }).locator(CHIP),
    ).toBeVisible();
    await expect(
      main(page)
        .getByRole("button", { name: new RegExp(agent.name, "i") })
        .locator(CHIP),
    ).toHaveCount(0);

    await page.goto(`${stack.webUrl}/#?page=home`);
    await expect(
      main(page).getByRole("button", { name: /Quill/ }).locator(CHIP),
    ).toBeVisible();
    await expect(main(page)).toContainText("The CEO will write at 15:00.");

    await page.goto(`${stack.webUrl}/#?page=people&view=org`);
    await expect(ownerNode).toContainText("Quill");
    await shot(page, "01-org");

    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Ask the CEO" });
    await expect(dialog).toBeVisible();
    const box = dialog.getByRole("textbox");
    await expect(box).toHaveAttribute(
      "placeholder",
      "Ask the CEO, or search people, threads, projects…",
    );
    await expect(
      dialog.getByRole("button", { name: "Ask the CEO", exact: true }),
    ).toHaveCount(1);
    await box.fill("Say hi from the palette");
    await box.press("Enter");
    /* Ask the CEO is openAsk: a draft with the holder, not a second send path. */
    await expect(page).toHaveURL(new RegExp(`open=newchat:${quillId}`), {
      timeout: 30_000,
    });
    await expect(v3Peek(page).getByPlaceholder("Message Quill…")).toHaveValue(
      "Say hi from the palette",
    );
    await expect(v3Peek(page).locator(CHIP)).toBeVisible();
    await expect(v3Peek(page)).toContainText("Quill");
  } finally {
    await stack.stop();
  }
});

test("the new CEO's next thread gets the CEO tools and the old one's does not", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const stack = await bootStack("ac778-tools", await pickPorts());
  try {
    const agent = await openDefaultAgent(page, stack.webUrl);
    const listed = await relayRpc<{
      employees: { id: string; profile: string }[];
    }>(page, stack, "employees.list", {});
    const holder = listed.employees.find((e) => e.id === agent.id);
    expect(holder?.profile).toBeTruthy();
    const profile = holder?.profile ?? "";

    const created = await relayRpc<{
      employee: { id: string; profile: string };
    }>(page, stack, "employees.create", {
      name: "Quill",
      role: "Notes",
      status: "online",
      profile: "builder",
      model: "fake-large",
      instructions: "You take notes.",
    });
    await relayRpc(page, stack, "channels.openDm", {
      employeeId: created.employee.id,
    });
    const quill = {
      id: created.employee.id,
      name: "Quill",
      profile: created.employee.profile,
    };
    expect(quill.profile).toBe("builder");

    const offers = (who: string) =>
      stack
        .harnessLog()
        .split("\n")
        .filter((line) => line.includes(`session.start agent=${who} `));

    await relayRpc(page, stack, "company.setCeo", { employeeId: agent.id });
    const before = offers(profile).length;
    const first = await startChat(page, stack.webUrl, agent, "Say hi");
    await expect(v3Peek(page).locator("[data-agentturn]").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect.poll(() => offers(profile).length).toBeGreaterThan(before);
    const asCeo = offers(profile).at(-1) ?? "";
    expect(asCeo).toContain("ceo=1");
    expect(asCeo).toContain("ceoTools=");
    expect(asCeo).toContain("team_set_ceo");
    expect(asCeo).toContain("ticket_assign");
    expect(asCeo).not.toContain("team_hire");

    const events = await relayRpc<{
      events: { type: string; payload?: { agent?: string } }[];
    }>(page, stack, "session.events", { conversationId: first, after: 0 });
    const started = events.events.find((e) => e.type === "session.started");
    expect(started?.payload?.agent).toBe(profile);

    await relayRpc(page, stack, "company.setCeo", { employeeId: quill.id });
    const mid = offers(profile).length;
    await startChat(page, stack.webUrl, agent, "Say hi again");
    await expect(v3Peek(page).locator("[data-agentturn]").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect.poll(() => offers(profile).length).toBeGreaterThan(mid);
    const lost = offers(profile).at(-1) ?? "";
    expect(lost).toContain("ceo=0");
    expect(lost).toContain("ceoTools=-");
    expect(lost).not.toContain("team_set_ceo");
    expect(lost).not.toContain("ticket_assign");

    const beforeQuill = offers(quill.profile).length;
    await startChat(page, stack.webUrl, quill, "Say hi");
    await expect(v3Peek(page).locator("[data-agentturn]").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(() => offers(quill.profile).length)
      .toBeGreaterThan(beforeQuill);
    const gained = offers(quill.profile).at(-1) ?? "";
    expect(gained).toContain("ceo=1");
    expect(gained).toContain("team_set_ceo");
    expect(gained).toContain("ticket_assign");
    expect(gained).not.toContain("team_hire");
    await expect(v3Peek(page).locator(CHIP)).toBeVisible();
    await shot(page, "02-tools");
  } finally {
    await stack.stop();
  }
});

test("a CEO thread's team_set_ceo moves the position only after approval", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const stack = await bootStack("ac778-set", await pickPorts());
  try {
    const agent = await openDefaultAgent(page, stack.webUrl);
    const created = await relayRpc<{ employee: { id: string } }>(
      page,
      stack,
      "employees.create",
      {
        name: "Quill",
        role: "Notes",
        status: "online",
        profile: "builder",
        model: "fake-large",
        instructions: "You take notes.",
      },
    );
    await relayRpc(page, stack, "channels.openDm", {
      employeeId: created.employee.id,
    });
    const quillId = created.employee.id;
    await relayRpc(page, stack, "company.setCeo", { employeeId: agent.id });

    await startChat(page, stack.webUrl, agent, `surfaces: set-ceo ${quillId}`);
    await page.goto(`${stack.webUrl}/#?page=needs`);
    await expect(main(page)).toContainText("Give the CEO position to Quill", {
      timeout: 60_000,
    });
    await shot(page, "03-approval");
    await main(page)
      .getByRole("button", { name: "Approve", exact: true })
      .click();

    await page.goto(`${stack.webUrl}/#?page=people`);
    await expect(
      main(page).getByRole("button", { name: /Quill/ }).locator(CHIP),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      main(page)
        .getByRole("button", { name: new RegExp(agent.name, "i") })
        .locator(CHIP),
    ).toHaveCount(0);
    const held = await relayRpc<{ value: unknown }>(
      page,
      stack,
      "settings.get",
      { key: "ceoId" },
    );
    expect(held.value).toBe(quillId);
    await shot(page, "04-moved");
  } finally {
    await stack.stop();
  }
});

test("a non-CEO thread calling a CEO-only tool is refused", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const stack = await bootStack("ac778-refuse", await pickPorts());
  try {
    const agent = await openDefaultAgent(page, stack.webUrl);
    const created = await relayRpc<{ employee: { id: string } }>(
      page,
      stack,
      "employees.create",
      {
        name: "Quill",
        role: "Notes",
        status: "online",
        profile: "builder",
        model: "fake-large",
        instructions: "You take notes.",
      },
    );
    await relayRpc(page, stack, "channels.openDm", {
      employeeId: created.employee.id,
    });
    await relayRpc(page, stack, "company.setCeo", {
      employeeId: created.employee.id,
    });

    await startChat(page, stack.webUrl, agent, `surfaces: set-ceo ${agent.id}`);
    await expect(
      v3Peek(page).getByRole("button", { name: "Copy" }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await v3Peek(page)
      .getByText(/Worked/)
      .first()
      .click();
    await expect(v3Peek(page)).toContainText("mcp__lilos__team_set_ceo");
    await expect(v3Peek(page)).toContainText("failed");
    await expect(page.getByText("Give the CEO position")).toHaveCount(0);
    const held = await relayRpc<{ value: unknown }>(
      page,
      stack,
      "settings.get",
      { key: "ceoId" },
    );
    expect(held.value).toBe(created.employee.id);
    await shot(page, "05-refused");
  } finally {
    await stack.stop();
  }
});
