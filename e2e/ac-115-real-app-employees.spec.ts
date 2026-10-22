import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  type Stack,
  skipFirstRun,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #115 — hire, edit and remove employees in the real app (apps/web,
 * relay + harness on engine-fake). Each acceptance criterion is a named test.
 * Stacks get dynamically-picked ports so parallel workers never collide.
 * Engine/relay truth is probed over the real JSON-RPC path (session.hello →
 * passthrough `agents.*`/`models.list` → harness → engine-fake).
 *
 * v3: Hire is the page `#?page=hire` (sidebar "Hire an agent"), a role grid +
 * name + model + Hire, creating a NEW engine profile named after the person
 * (AC-2/AC-3), and a second section, "Or bring in an existing profile", that
 * links an engine profile nobody is hired on, keeping the engine's own model
 * and persona (AC-2b, the old dialog's "Use profile"). "New profile"'s
 * template rows, instructions box and engine-model buttons have no v3
 * control; AC-2/AC-3 keep what a person can still do. A name equal to an
 * existing engine profile is refused by the engine ("agent X already
 * exists"), which is how AC-3's rejection reads in v3 (a toast, the form
 * stays).
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
  model: string;
  instructions: string;
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

/** Open the app past first run, on Home with the auto-hired Default in the
 *  sidebar's People. */
async function openApp(stack: Stack, page: Page) {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  await expect(
    v3Sidebar(page).getByRole("button", { name: /Default/ }),
  ).toBeVisible({ timeout: 30_000 });
}

const hireHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: "Hire an agent" });

/** Sidebar "Hire an agent" → the Hire page. */
async function openHire(page: Page) {
  await v3Sidebar(page).getByRole("button", { name: "Hire an agent" }).click();
  await expect(hireHeading(page)).toBeVisible();
  await expect(page).toHaveURL(/[#&?]page=hire/);
}

/** A role card on the Hire page (its accessible name starts with the role). */
const roleCard = (page: Page, role: string) =>
  page.getByRole("button", { name: new RegExp(`^${role} `) });

/** The Hire form's name field and its segmented model buttons. */
const nameField = (page: Page) => page.getByPlaceholder("Name");
const modelButton = (page: Page, label: string) =>
  page.getByRole("button", { name: label, exact: true });

test("AC-1 the sidebar offers Hire, and opens the Hire page, only when the engine declares `agents`", async ({
  page,
}) => {
  await openApp(stackA, page);
  const sidebar = v3Sidebar(page);
  await expect(
    sidebar.getByRole("button", { name: "Hire an agent" }),
  ).toBeVisible();
  /* The page header and the org chart do not repeat it (D-#769). */
  await page.goto(`${stackA.webUrl}/#?page=people`);
  await expect(
    page.locator("#v3-main").getByRole("button", { name: /Hire an agent/ }),
  ).toHaveCount(0);
  await page.goto(`${stackA.webUrl}/#?page=people&view=org`);
  await expect(
    page.locator("#v3-main").getByRole("button", { name: /Hire an agent/ }),
  ).toHaveCount(0);
  await openHire(page);
  // The role grid is the page's way in (it replaced "Use profile" / "New
  // profile"): every role is a card, the form appears once one is picked.
  for (const role of [
    "Researcher",
    "Engineer",
    "Designer",
    "Growth",
    "QA",
    "Support",
  ])
    await expect(roleCard(page, role)).toBeVisible();
  await expect(nameField(page)).toHaveCount(0);
  await roleCard(page, "Engineer").click();
  await expect(nameField(page)).toHaveValue("Engineer");
  await expect(
    page.getByRole("button", { name: "Hire", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-hire-dialog.png` });

  // D-#19: no `agents` capability advertised → no hire affordance at all.
  const stackB = await bootStack("noagents", await pickPorts(), {
    LILOS_HIDE_CAPS: "agents",
  });
  try {
    await openApp(stackB, page);
    /* Hire is absent both before describe and when the engine declares no
       agents. The attribute is describe landing; the count is that state. */
    await expect(page.locator("[data-engine-described]")).toBeAttached();
    await expect(
      v3Sidebar(page).getByRole("button", { name: "Hire an agent" }),
    ).toHaveCount(0);
    // A link to the Hire page says plainly that it can't be used.
    await page.goto(`${stackB.webUrl}/#?page=hire`);
    await expect(page.locator("[data-engine-described]")).toBeAttached();
    await expect(
      page.getByText(
        /Hiring is not available while the engine cannot create agents/,
      ),
    ).toBeVisible();
    await expect(roleCard(page, "Engineer")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-1-no-agents-capability.png` });
  } finally {
    await stackB.stop();
  }
});

test("AC-2 hire a QA agent: the engine profile is created, the employee links it, a second click hires no duplicate", async ({
  page,
}) => {
  await openApp(stackA, page);
  // Engine truth through the real path: relay -> harness -> engine-fake.
  const before = await agentIds(stackA);
  for (const id of ["default", "builder", "marketer", "reviewer"])
    expect(before).toContain(id);

  await openHire(page);
  await roleCard(page, "QA").click();
  await nameField(page).fill("Tester");
  await expect(modelButton(page, "Fake Small")).toBeVisible();
  await modelButton(page, "Fake Small").click();
  await page.screenshot({ path: `${SHOTS}/ac-2-use-profile.png` });
  /* Two clicks in one synchronous task: the second always lands while the
     first hire is in flight, so the pending guard — not timing — is what
     keeps it from hiring a duplicate. (Two separate dispatches race the
     hire finishing and the page moving on, leaving no button for the
     second.) */
  const hireBtn = page.getByRole("button", { name: "Hire", exact: true });
  await hireBtn.evaluate((b: HTMLElement) => {
    b.click();
    b.click();
  });

  await expect(
    v3Sidebar(page).getByRole("button", { name: "Tester" }),
  ).toBeVisible();
  // A second attempt would have been refused by the engine ("already
  // exists") and toasted; the guard means there is no second attempt.
  await expect(page.getByText(/already exists/i)).toHaveCount(0);
  const employees = await employeeRows(stackA);
  const hired = employees.filter((e) => e.profile === "tester");
  expect(hired.length).toBe(1);
  expect(hired[0]?.name).toBe("Tester");
  expect(hired[0]?.role).toBe("QA");
  expect(hired[0]?.model).toBe("fake-small");
  expect(await agentIds(stackA)).toContain("tester");
});

/** The Hire page's second section: engine profiles nobody is hired on. */
const existingProfiles = (page: Page) =>
  page.getByRole("region", { name: "Existing engine profiles" });

test("AC-2b hire from an existing engine profile: it is linked, not created again, and keeps the engine's own model and persona", async ({
  page,
}) => {
  await openApp(stackA, page);
  const before = await agentIds(stackA);
  await openHire(page);

  // The quiet second section lists what the engine already has. `default` is
  // an agent already, so it is not offered a second time.
  const section = existingProfiles(page);
  await expect(
    section.getByRole("heading", { name: /Or bring in an existing profile/ }),
  ).toBeVisible();
  await expect(section.getByRole("button", { name: /^Builder/ })).toBeVisible();
  await expect(section.getByRole("button", { name: /^Default/ })).toHaveCount(
    0,
  );
  const reviewer = section.getByRole("button", { name: /^Reviewer/ });
  await expect(reviewer).toContainText("6 skills");
  await reviewer.click();

  // The picked profile's form: a name and a role to edit, and what the
  // engine keeps owning (model, persona) shown, not asked for.
  await expect(nameField(page)).toHaveValue("Reviewer");
  await expect(section.getByText("Fake Small")).toBeVisible();
  await expect(section.getByText(/Read the diff first/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-2b-existing-profile.png` });

  // Two clicks in one synchronous task: the second lands while the request
  // is in flight and hires no duplicate.
  const hireBtn = page.getByRole("button", { name: "Hire", exact: true });
  await hireBtn.evaluate((b: HTMLElement) => {
    b.click();
    b.click();
  });

  await expect(page).toHaveURL(/[#&?]page=people&open=agent:/, {
    timeout: 30_000,
  });
  const peek = v3Peek(page);
  await expect(
    peek.getByRole("heading", { level: 1, name: "Reviewer" }),
  ).toBeVisible();
  await expect(
    v3Sidebar(page).getByRole("button", { name: "Reviewer" }),
  ).toBeVisible();
  await expect(page.getByText(/already exists/i)).toHaveCount(0);
  // The agent's page says which engine profile it runs.
  await expect(peek.getByText("Profile", { exact: true })).toBeVisible();
  await expect(peek.getByText("reviewer", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-2b-hired-profile.png` });

  // The engine side: no new profile was made (agents.create never ran), and
  // the employee points at the existing one with its model and persona.
  expect(await agentIds(stackA)).toEqual(before);
  const hired = (await employeeRows(stackA)).filter(
    (e) => e.profile === "reviewer",
  );
  expect(hired.length).toBe(1);
  expect(hired[0]?.name).toBe("Reviewer");
  expect(hired[0]?.model).toBe("fake-small");
  expect(hired[0]?.instructions).toMatch(/Read the diff first/);

  // Now an agent runs on it, so the Hire page no longer offers it.
  await openHire(page);
  await expect(section.getByRole("button", { name: /^Builder/ })).toBeVisible();
  await expect(section.getByRole("button", { name: /^Reviewer/ })).toHaveCount(
    0,
  );
});

test("AC-3 hire an Engineer with a model: agents.create with the slug then the employee; a rejection reads plainly", async ({
  page,
}) => {
  await openApp(stackA, page);
  await openHire(page);
  await roleCard(page, "Engineer").click();
  // Display names are what Oscar types — the app derives the engine profile
  // slug ("senior-engineer"); the employee keeps the display name.
  await nameField(page).fill("Senior Engineer");
  await modelButton(page, "Fake Reasoning").click();
  await page.screenshot({ path: `${SHOTS}/ac-3-new-profile.png` });
  await page.getByRole("button", { name: "Hire", exact: true }).click();

  // Hiring lands on the new agent's page, opened beside People.
  await expect(page).toHaveURL(/[#&?]page=people&open=agent:/);
  const peek = v3Peek(page);
  await expect(
    peek.getByRole("heading", { level: 1, name: "Senior Engineer" }),
  ).toBeVisible();
  await expect(
    v3Sidebar(page).getByRole("button", { name: "Senior Engineer" }),
  ).toBeVisible();
  // agents.create ran for real with the slug, not the display name.
  expect(await agentIds(stackA)).toContain("senior-engineer");
  const employees = await employeeRows(stackA);
  const hired = employees.find((e) => e.name === "Senior Engineer");
  expect(hired?.profile).toBe("senior-engineer");
  expect(hired?.role).toBe("Engineer");
  expect(hired?.model).toBe("fake-reasoning");
  // The Engineer role's starter instructions are what the engine profile
  // (soul) and the employee carry — and the agent page shows them.
  expect(hired?.instructions).toMatch(/full-stack engineer/);
  await expect(peek.getByText(/full-stack engineer/)).toBeVisible();
  await expect(peek.getByText("Fake Reasoning", { exact: true })).toBeVisible();

  // Engine rejection: a name the engine already has reads plainly, nothing is
  // created (no employee, no agent — the form stays with the reason).
  await openHire(page);
  await roleCard(page, "Support").click();
  await nameField(page).fill("default");
  const rows = await employeeRows(stackA);
  const agentsBefore = await agentIds(stackA);
  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await expect(page.getByText(/agent default already exists/i)).toBeVisible();
  await expect(hireHeading(page)).toBeVisible();
  await expect(nameField(page)).toHaveValue("default");
  await page.screenshot({ path: `${SHOTS}/ac-3-engine-rejection.png` });
  expect((await employeeRows(stackA)).length).toBe(rows.length);
  expect(await agentIds(stackA)).toEqual(agentsBefore);

  // Same slug again: retyping the display name hits the duplicate check too.
  await nameField(page).fill("Senior Engineer");
  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await expect(
    page.getByText(/agent senior-engineer already exists/i),
  ).toBeVisible();
  await expect(hireHeading(page)).toBeVisible();
  expect((await employeeRows(stackA)).length).toBe(rows.length);
});

test("AC-4 the model list on the Hire page comes from models.list", async ({
  page,
}) => {
  await openApp(stackA, page);
  const [res] = await rpc(stackA.relayWs, stackA.relayToken, [
    { method: "models.list", params: {} },
  ]);
  const models = (res.result as { models: { id: string; name?: string }[] })
    .models;

  await openHire(page);
  await roleCard(page, "Engineer").click();
  // Every catalog entry renders — nothing hardcoded (D-#85).
  for (const m of models)
    await expect(modelButton(page, m.name ?? m.id)).toBeVisible();
  // The prototype's mock-only model names are absent.
  await expect(page.getByText(/GPT-6 Astra|Qwen 3\.8/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-4-model-list.png` });
});

test("AC-5 after hiring, the sidebar + new chat appear live and the app navigates to the agent", async ({
  page,
}) => {
  await openApp(stackA, page);
  await openHire(page);
  await roleCard(page, "Growth").click();
  await nameField(page).fill("Growth Lead");
  await page.getByRole("button", { name: "Hire", exact: true }).click();

  // No reload: SPA navigation lands on the new agent's page beside People.
  await expect(page).toHaveURL(/[#&?]page=people&open=agent:emp_[^&,]+/);
  await expect(
    v3Sidebar(page).getByRole("button", { name: "Growth Lead" }),
  ).toBeVisible();
  const peek = v3Peek(page);
  await expect(
    peek.getByRole("heading", { level: 1, name: "Growth Lead" }),
  ).toBeVisible();
  // The DM channel already exists — a chat with them is ready to type, not a
  // skeleton.
  await peek.getByRole("button", { name: "Message" }).click();
  await expect(peek.getByPlaceholder("Message Growth Lead…")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-5-live-dm.png` });

  const employeeId = decodeURIComponent(
    /open=agent:([^&,]+)/.exec(page.url())?.[1] ?? "",
  );
  const employees = await employeeRows(stackA);
  const emp = employees.find((e) => e.id === employeeId);
  expect(emp?.name).toBe("Growth Lead");
  expect(emp?.profile).toBe("growth-lead");
  expect((await dmChannelIds(stackA, employeeId)).length).toBe(1);
});

test("AC-8 the channel-assignment part of the Hire page does not render in the real app", async ({
  page,
}) => {
  await openApp(stackA, page);
  await openHire(page);
  await expect(page.getByText("Join channels")).toHaveCount(0);
  await expect(page.getByText("engineering")).toHaveCount(0);
  await roleCard(page, "Engineer").click();
  await expect(page.getByText("Join channels")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-8-no-channels.png` });
});

/** An agent's page in the side peek, opened from its sidebar row. */
async function openAgent(page: Page, name: string) {
  await v3Sidebar(page).getByRole("button", { name, exact: true }).click();
  const peek = v3Peek(page);
  await expect(peek.getByRole("heading", { level: 1, name })).toBeVisible();
  return peek;
}

test("AC-6 Edit saves display name + role via employees.update; surfaces update live", async ({
  page,
}) => {
  await openApp(stackA, page);
  const peek = await openAgent(page, "Senior Engineer");
  await peek.getByRole("button", { name: "Edit" }).click();

  await peek.getByRole("textbox", { name: "Name" }).fill("Engineer Prime");
  await peek.getByRole("textbox", { name: "Role" }).fill("Records lead");
  await page.screenshot({ path: `${SHOTS}/ac-6-edit-dialog.png` });
  await peek.getByRole("button", { name: "Save" }).click();
  // "Save" reads "Saving…" while in flight: Edit is back once it has landed.
  await expect(peek.getByRole("button", { name: "Edit" })).toBeVisible();

  // The sidebar row and the agent page read the updated record without a
  // reload; the role is the page's kicker line.
  await expect(
    v3Sidebar(page).getByRole("button", { name: "Engineer Prime" }),
  ).toBeVisible();
  await expect(
    peek.getByRole("heading", { level: 1, name: "Engineer Prime" }),
  ).toBeVisible();
  await expect(peek.getByText(/^Records lead/)).toBeVisible();
  await expect(
    v3Sidebar(page).getByRole("button", { name: "Senior Engineer" }),
  ).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-6-updated.png` });
  const employees = await employeeRows(stackA);
  expect(
    employees.some(
      (e) => e.name === "Engineer Prime" && e.role === "Records lead",
    ),
  ).toBe(true);
});

test("AC-7 Remove deletes the LilOS record + DM, never the engine profile", async ({
  page,
}) => {
  await openApp(stackA, page);
  const peek = await openAgent(page, "Tester");
  const employeeId = decodeURIComponent(
    /open=agent:([^&,]+)/.exec(page.url())?.[1] ?? "",
  );
  expect((await dmChannelIds(stackA, employeeId)).length).toBe(1);

  await peek.getByRole("button", { name: "Remove from company" }).click();
  // #64's plain confirmation: what goes (record + DMs) vs what stays (profile).
  const confirm = peek.getByRole("group", {
    name: "Remove Tester from the company",
  });
  await expect(
    confirm.getByText("Remove Tester from the company?"),
  ).toBeVisible();
  await expect(
    confirm.getByText(
      /its engine profile, with its history, memory and skills/,
    ),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-7-remove-confirm.png` });
  await confirm.getByRole("button", { name: "Remove from company" }).click();

  // The sidebar row goes, the peek closes and the app is on People.
  await expect(
    v3Sidebar(page).getByRole("button", { name: "Tester", exact: true }),
  ).toHaveCount(0);
  await expect(v3Peek(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(employeeId));
  await expect(page).toHaveURL(/[#&?]page=people/);
  await page.screenshot({ path: `${SHOTS}/ac-7-removed.png` });

  const employees = await employeeRows(stackA);
  expect(employees.some((e) => e.id === employeeId)).toBe(false);
  expect((await dmChannelIds(stackA, employeeId)).length).toBe(0);
  // D-#29: the engine profile is untouched.
  expect(await agentIds(stackA)).toContain("tester");
  // …and it is hirable again under "Or bring in an existing profile" (the
  // old "Use profile" list): only the LilOS record went. The engine named
  // the profile by its slug, so that is what the row reads.
  await openHire(page);
  await expect(
    existingProfiles(page).getByRole("button", { name: /^tester/i }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-7-profile-back.png` });
});
