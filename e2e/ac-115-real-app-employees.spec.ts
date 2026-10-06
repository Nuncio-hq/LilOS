import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #115 — hire, edit and remove employees in the real app (apps/web,
 * relay + harness on engine-fake). Each acceptance criterion is a named test.
 * Stacks get dynamically-picked ports so parallel workers never collide.
 * Engine/relay truth is probed over the real JSON-RPC path (session.hello →
 * passthrough `agents.*`/`models.list` → harness → engine-fake).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-115");

/** Bare JSON-RPC client — e2e runs under Node without workspace deps. */
async function rpc(
  relayWs: string,
  token: string,
  calls: { method: string; params: Record<string, unknown> }[],
): Promise<Record<string, unknown>[]> {
  const ws = new WebSocket(`${relayWs}?token=${encodeURIComponent(token)}`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  const pending = new Map<string, (r: Record<string, unknown>) => void>();
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data as string) as Record<string, unknown>;
    if (typeof f.id === "string") pending.get(f.id)?.(f);
  };
  const send = (id: string, method: string, params: object) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      pending.set(id, (f) =>
        f.error
          ? rej(new Error(`${method} -> ${JSON.stringify(f.error)}`))
          : res(f),
      );
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  await send("h", "session.hello", { protocolVersion: 1, token });
  const out: Record<string, unknown>[] = [];
  for (const [i, c] of calls.entries())
    out.push(await send(String(i), c.method, c.params));
  ws.close();
  return out;
}

async function agentIds(stack: Stack): Promise<string[]> {
  const [res] = await rpc(stack.relayWs, stack.relayToken, [
    { method: "agents.list", params: {} },
  ]);
  const agents = (res.result as { agents: { id: string }[] }).agents;
  return agents.map((a) => a.id);
}

interface EmployeeRow {
  id: string;
  name: string;
  role: string;
  profile: string;
}

async function employeeRows(stack: Stack): Promise<EmployeeRow[]> {
  const [res] = await rpc(stack.relayWs, stack.relayToken, [
    { method: "employees.list", params: {} },
  ]);
  return (res.result as { employees: EmployeeRow[] }).employees;
}

async function dmChannelIds(
  stack: Stack,
  employeeId: string,
): Promise<string[]> {
  const [res] = await rpc(stack.relayWs, stack.relayToken, [
    { method: "channels.list", params: {} },
  ]);
  const channels = (
    res.result as {
      channels: { id: string; kind: string; employeeId?: string }[];
    }
  ).channels;
  return channels
    .filter((c) => c.kind === "dm" && c.employeeId === employeeId)
    .map((c) => c.id);
}

test.describe.configure({ mode: "serial" });

let stackA: Stack; // engine-fake advertising every capability
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stackA = await bootStack("main", await pickPorts());
});
test.afterAll(async () => {
  await stackA?.stop();
});

/** Open the app past first-run, landed on the auto-hired Default's DM. */
async function openApp(stack: Stack, page: Page) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${stack.webUrl}/`);
  await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
  await expect(
    page.locator("aside").getByRole("button", { name: /Default/ }),
  ).toBeVisible({ timeout: 30_000 });
}

const hireDialog = (page: Page) =>
  page.locator("div.fixed.inset-0", { hasText: "Hire an employee" });
const editDialog = (page: Page) =>
  page.locator("div.fixed.inset-0", { hasText: "Edit employee" });

async function openHire(page: Page) {
  await page
    .locator("aside")
    .getByRole("button", { name: "Hire employee" })
    .click();
  await expect(page.getByText("Hire an employee")).toBeVisible();
}

test("AC-1 sidebar + opens HireDialog only when the engine declares `agents`", async ({
  page,
}) => {
  await openApp(stackA, page);
  const aside = page.locator("aside");
  await expect(
    aside.getByRole("button", { name: "Add Employees" }),
  ).toBeVisible();
  await aside.getByRole("button", { name: "Add Employees" }).click();
  const dlg = hireDialog(page);
  await expect(dlg.getByText("Hire an employee")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Use profile" })).toBeVisible();
  await expect(dlg.getByRole("button", { name: "New profile" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-hire-dialog.png` });
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);

  // D-#19: no `agents` capability advertised → no hire affordance at all.
  const stackB = await bootStack("noagents", await pickPorts(), {
    LILOS_HIDE_CAPS: "agents",
  });
  try {
    await openApp(stackB, page);
    await expect(
      aside.getByRole("button", { name: "Hire employee" }),
    ).toHaveCount(0);
    await expect(
      aside.getByRole("button", { name: "Add Employees" }),
    ).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-1-no-agents-capability.png` });
  } finally {
    await stackB.stop();
  }
});

test("AC-2 Use profile lists unhired engine profiles (model, skills, soul); hire links it", async ({
  page,
}) => {
  await openApp(stackA, page);
  // Engine truth through the real path: relay -> harness -> engine-fake.
  const ids = await agentIds(stackA);
  for (const id of ["default", "builder", "marketer", "reviewer"])
    expect(ids).toContain(id);

  await openHire(page);
  const dlg = hireDialog(page);
  // `default` is already an employee → row is disabled "hired".
  await expect(dlg.getByRole("button", { name: /default/ })).toBeDisabled();
  await expect(dlg.getByRole("button", { name: /builder/ })).toBeVisible();
  const reviewer = dlg.getByRole("button", { name: /reviewer/ });
  await expect(reviewer).toBeVisible();
  await expect(reviewer).toContainText("6 skills");
  await reviewer.click();
  // Picked card: model, skills count and the soul preview (agents.describe).
  // #194: the picked card shows the model's display name, not the id.
  await expect(dlg.getByText("Fake Small")).toBeVisible();
  await expect(dlg.getByText(/Read the diff first/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-2-use-profile.png` });
  // dispatchEvent lands a second click while the request is in flight — the
  // pending guard must keep it from hiring a duplicate.
  const hireBtn = dlg.getByRole("button", { name: /Hire Reviewer/ });
  await hireBtn.dispatchEvent("click");
  await hireBtn.dispatchEvent("click");

  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: "Reviewer" })).toBeVisible();
  const employees = await employeeRows(stackA);
  const hired = employees.filter((e) => e.profile === "reviewer");
  expect(hired.length).toBe(1);
  expect(hired[0]?.name).toBe("Reviewer");
});

test("AC-3 New profile: 4 templates + Blank, agents.create then hire; a rejection reads plainly", async ({
  page,
}) => {
  await openApp(stackA, page);
  await openHire(page);
  const dlg = hireDialog(page);
  await dlg.getByRole("button", { name: "New profile" }).click();
  // Rows read "<name> <role>" — "Engineer Engineer", "Reviewer QA", ...
  for (const [name, role] of [
    ["Engineer", "Engineer"],
    ["Reviewer", "QA"],
    ["Researcher", "Research"],
    ["Marketer", "Growth"],
  ])
    await expect(
      dlg.getByRole("button", { name: new RegExp(`${name} ${role}`) }),
    ).toBeVisible();
  await expect(dlg.getByRole("button", { name: /Blank/ })).toBeVisible();

  await dlg.getByRole("button", { name: /Engineer Engineer/ }).click();
  // Display names are what Oscar types — the app derives the engine profile
  // slug ("senior-engineer"); the employee keeps the display name.
  await dlg.getByPlaceholder("Tester").fill("Senior Engineer");
  await dlg
    .locator("textarea")
    .fill("You are the Senior Engineer. Keep the record straight.");
  await dlg.getByRole("button", { name: "Fake Reasoning" }).click();
  await page.screenshot({ path: `${SHOTS}/ac-3-new-profile.png` });
  await dlg.getByRole("button", { name: /Hire Senior Engineer/ }).click();
  await expect(hireDialog(page)).toHaveCount(0);

  const aside = page.locator("aside");
  await expect(
    aside.getByRole("button", { name: "Senior Engineer" }),
  ).toBeVisible();
  // agents.create ran for real with the slug, not the display name.
  expect(await agentIds(stackA)).toContain("senior-engineer");
  const employees = await employeeRows(stackA);
  expect(
    employees.some(
      (e) => e.name === "Senior Engineer" && e.profile === "senior-engineer",
    ),
  ).toBe(true);

  // Engine rejection: a name the engine already has reads plainly, nothing is
  // created (no employee, no agent — the dialog stays open with the reason).
  await openHire(page);
  await dlg.getByRole("button", { name: "New profile" }).click();
  await dlg.getByRole("button", { name: /Blank/ }).click();
  await dlg.getByPlaceholder("Tester").fill("default");
  const before = await employeeRows(stackA);
  await dlg.getByRole("button", { name: /Hire default/ }).click();
  await expect(dlg.getByText(/agent default already exists/i)).toBeVisible();
  await expect(dlg.getByText("Hire an employee")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-3-engine-rejection.png` });
  expect((await employeeRows(stackA)).length).toBe(before.length);

  // Same slug again: retyping the display name hits the duplicate check too.
  await dlg.getByPlaceholder("Tester").fill("Senior Engineer");
  await dlg.getByRole("button", { name: /Hire Senior Engineer/ }).click();
  await expect(
    dlg.getByText(/agent senior-engineer already exists/i),
  ).toBeVisible();
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "Cancel" }).click();
});

test("AC-4 the model list in the dialog comes from models.list", async ({
  page,
}) => {
  await openApp(stackA, page);
  const [res] = await rpc(stackA.relayWs, stackA.relayToken, [
    { method: "models.list", params: {} },
  ]);
  const models = (res.result as { models: { id: string; name?: string }[] })
    .models;

  await openHire(page);
  const dlg = hireDialog(page);
  await dlg.getByRole("button", { name: "New profile" }).click();
  // Every catalog entry renders — nothing hardcoded (D-#85).
  for (const m of models)
    await expect(
      dlg.getByRole("button", { name: m.name ?? m.id, exact: true }),
    ).toBeVisible();
  // The prototype's mock-only model names are absent.
  await expect(dlg.getByText(/GPT-6 Astra|Qwen 3\.8/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-4-model-list.png` });
  await dlg.getByRole("button", { name: "Cancel" }).click();
});

test("AC-5 after hiring, the sidebar + new DM appear live and the app navigates to it", async ({
  page,
}) => {
  await openApp(stackA, page);
  await openHire(page);
  const dlg = hireDialog(page);
  await dlg.getByRole("button", { name: /marketer/ }).click();
  await dlg.getByRole("button", { name: /Hire Marketer/ }).click();

  // No reload: SPA navigation lands on the new employee's DM, ready to chat.
  await expect(page).toHaveURL(/\/dm\/emp_[^/]+$/);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: "Marketer" })).toBeVisible();
  // The DM channel already exists — the home renders, not a skeleton.
  await expect(page.getByText("Start a session with Marketer")).toBeVisible();
  await expect(page.locator("textarea").last()).toHaveAttribute(
    "placeholder",
    /New session with Marketer/,
  );
  await page.screenshot({ path: `${SHOTS}/ac-5-live-dm.png` });

  const employeeId = decodeURIComponent(
    page.url().split("/dm/")[1].split("/")[0],
  );
  const employees = await employeeRows(stackA);
  const emp = employees.find((e) => e.id === employeeId);
  expect(emp?.name).toBe("Marketer");
  expect(emp?.profile).toBe("marketer");
  expect((await dmChannelIds(stackA, employeeId)).length).toBe(1);
});

test("AC-6 Edit saves display name + role via employees.update; surfaces update live", async ({
  page,
}) => {
  await openApp(stackA, page);
  const aside = page.locator("aside");
  await aside.getByRole("button", { name: "Senior Engineer" }).click();
  await expect(page).toHaveURL(/\/dm\//);
  await page.getByRole("button", { name: /Profile/ }).click();
  await page.getByRole("button", { name: "Edit" }).click();

  const dlg = editDialog(page);
  await dlg.getByLabel("Display name").fill("Engineer Prime");
  await dlg.getByLabel("Role").fill("Records lead");
  await page.screenshot({ path: `${SHOTS}/ac-6-edit-dialog.png` });
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toHaveCount(0);

  // Sidebar row and DM header read the updated record without a reload.
  const primeRow = aside.getByRole("button", { name: /Engineer Prime/ });
  await expect(primeRow).toBeVisible();
  // The restyled row shows the name only; the role lives on the title.
  await expect(primeRow).toHaveAttribute("title", "Records lead");
  await expect(page.getByText("Records lead").last()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-6-updated.png` });
  const employees = await employeeRows(stackA);
  expect(
    employees.some(
      (e) => e.name === "Engineer Prime" && e.role === "Records lead",
    ),
  ).toBe(true);
});

test("AC-7 Remove deletes the LilOS record + DM, never the engine profile; the profile is hirable again", async ({
  page,
}) => {
  await openApp(stackA, page);
  const aside = page.locator("aside");
  await aside.getByRole("button", { name: "Reviewer" }).click();
  await expect(page).toHaveURL(/\/dm\//);
  const employeeId = decodeURIComponent(
    page.url().split("/dm/")[1].split("/")[0],
  );
  expect((await dmChannelIds(stackA, employeeId)).length).toBe(1);

  await page.getByRole("button", { name: /Profile/ }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  const dlg = editDialog(page);
  await dlg.getByRole("button", { name: /Remove from company/ }).click();
  // #64's plain confirmation: what goes (record + DMs) vs what stays (profile).
  await expect(
    dlg.getByText("Remove Reviewer from the company?"),
  ).toBeVisible();
  await expect(dlg.getByText(/its sessions, memory, and skills/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-7-remove-confirm.png` });
  await dlg.getByRole("button", { name: "Remove from company" }).last().click();

  await expect(aside.getByRole("button", { name: "Reviewer" })).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(`/dm/${employeeId}`));
  await page.screenshot({ path: `${SHOTS}/ac-7-removed.png` });

  const employees = await employeeRows(stackA);
  expect(employees.some((e) => e.id === employeeId)).toBe(false);
  expect((await dmChannelIds(stackA, employeeId)).length).toBe(0);
  // D-#29: the engine profile is untouched and shows under Use profile again.
  expect(await agentIds(stackA)).toContain("reviewer");
  await openHire(page);
  const dlg2 = hireDialog(page);
  await expect(dlg2.getByRole("button", { name: /reviewer/ })).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/ac-7-profile-back.png` });
  await dlg2.getByRole("button", { name: "Cancel" }).click();
});

test("AC-8 the channel-assignment part of HireDialog does not render in the real app", async ({
  page,
}) => {
  await openApp(stackA, page);
  await openHire(page);
  const dlg = hireDialog(page);
  await expect(dlg.getByText("Join channels")).toHaveCount(0);
  await expect(dlg.getByText("engineering")).toHaveCount(0);
  await dlg.getByRole("button", { name: "New profile" }).click();
  await expect(dlg.getByText("Join channels")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-8-no-channels.png` });
  await dlg.getByRole("button", { name: "Cancel" }).click();
});
