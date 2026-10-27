import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  type Stack,
  skipFirstRun,
  v3Main,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #123 — edit an employee's persona (soul) and default model from the
 * agent's page (`agents.update`), on the real stack (apps/web → relay →
 * harness → engine-fake). Each acceptance criterion is a named test. Engine
 * truth is probed over the real JSON-RPC path.
 *
 * v3: the Edit dialog is the agent page's Edit mode (Name, Role, Description,
 * Instructions and a Model menu; Save/Cancel). Persona is the Instructions
 * box; the page is not a dialog, so the short-window leg checks that Esc
 * leaves the page open and Save sits inside the window.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-123");

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

async function describeAgent(
  stack: Stack,
  id: string,
): Promise<{ soul?: string; model?: string; description?: string }> {
  const [res] = await rpc(stack.relayWs, stack.relayToken, [
    { method: "agents.describe", params: { id } },
  ]);
  return (
    res.result as {
      agent: { soul?: string; model?: string; description?: string };
    }
  ).agent;
}

test.describe.configure({ mode: "serial" });

let stackA: Stack; // engine-fake advertising every capability
test.beforeAll(async () => {
  test.setTimeout(180_000);
  stackA = await bootStack("main", await pickPorts());
});
test.afterAll(async () => {
  await stackA?.stop();
});

/** Open the app past first run and Default's page — a sidebar pick is a
 *  jump, so the record is the page column (D-#769). */
async function openDefault(stack: Stack, page: Page) {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  const row = v3Sidebar(page).getByRole("button", { name: /Hermes/ });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const record = v3Main(page);
  await expect(
    record.getByRole("heading", { level: 1, name: "Hermes" }),
  ).toBeVisible();
  return record;
}

/** Edit mode on the open agent page. */
async function openEdit(record: ReturnType<typeof v3Main>) {
  await record.getByRole("button", { name: "Edit" }).click();
  await expect(record.getByRole("button", { name: "Save" })).toBeVisible();
}

/** The Model menu in edit mode: pick `label`. */
async function pickModel(record: ReturnType<typeof v3Main>, label: string) {
  await record.getByRole("button", { name: "Model", exact: true }).click();
  await record
    .getByRole("menu", { name: "Model" })
    .getByRole("menuitemradio", { name: label })
    .click();
}

/** A new chat with Default, sent once the draft's model picker names `model`.
 *  The draft shows the engine's model picker only once the model catalog has
 *  arrived (until then it is the plain menu over bare ids), and a send before
 *  that cannot map the id to a catalog model (it falls back to the engine
 *  default) — so the wait on the picker's label is what makes "the next new
 *  session uses the updated default" deterministic. */
async function chatWithDefault(page: Page, text: string, model: string) {
  await skipFirstRun(page);
  await page.goto(`${stackA.webUrl}/#?page=threads&open=newchat:default`);
  await expect(
    v3Peek(page).locator('[data-slot="model-picker-trigger"]'),
  ).toContainText(model, { timeout: 30_000 });
  await v3Peek(page).getByPlaceholder("Message Hermes…").fill(text);
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
}

/** Reply inside the open conversation — same session, a fresh turn. */
async function replyInSession(page: Page, text: string) {
  const box = v3Peek(page)
    .locator("[data-thread-panel]")
    .getByPlaceholder(/^Message [^…]+…$/);
  await box.fill(text);
  await box.press("Enter");
}

test("AC-1 the Edit mode shows only the fields the engine advertises", async ({
  page,
}) => {
  const record = await openDefault(stackA, page);
  await openEdit(record);
  // engine-fake advertises description/soul/model (and name, which the
  // company record already owns) — the page renders exactly those, plus the
  // record's role.
  await expect(record.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect(record.getByRole("textbox", { name: "Role" })).toBeVisible();
  await expect(
    record.getByRole("textbox", { name: "Description" }),
  ).toBeVisible();
  await expect(record.getByText(/Applies to new threads/)).toBeVisible(); // AC-4's note
  await expect(
    record.getByRole("textbox", { name: "Instructions" }),
  ).toBeVisible();
  await expect(
    record.getByRole("button", { name: "Model", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-edit-dialog.png` });
  await record.getByRole("button", { name: "Cancel" }).click();
  await expect(record.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(record.getByRole("button", { name: "Edit" })).toBeVisible();
});

test("AC-1b Esc cancels the edit without closing the page; Save stays reachable in a short window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const record = await openDefault(stackA, page);
  await openEdit(record);
  // Esc steps out of the edit, never out of the record — the record IS the
  // page (D-#769), so it stays and no peek was ever there.
  await record.getByRole("textbox", { name: "Instructions" }).press("Escape");
  await expect(record.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(page).toHaveURL(/[#?&]page=agent&id=/);
  await expect(record.getByRole("button", { name: "Edit" })).toBeVisible();

  await openEdit(record);
  // The header's Save is inside the window; saving unchanged keeps the page.
  const save = record.getByRole("button", { name: "Save" });
  await expect(save).toBeVisible();
  await expect(save).toBeEnabled();
  const box = await save.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(600);
  await save.click();
  await expect(record.getByRole("button", { name: "Edit" })).toBeVisible();
});

test("AC-2 saving a new persona + model writes the engine profile (agents.update → agents.describe)", async ({
  page,
}) => {
  const record = await openDefault(stackA, page);
  await openEdit(record);
  await record
    .getByRole("textbox", { name: "Instructions" })
    .fill("You are Default v2. Answer in exactly one word.");
  await record
    .getByRole("textbox", { name: "Description" })
    .fill("persona updated from LilOS");
  await pickModel(record, "Fake Small");
  await page.screenshot({ path: `${SHOTS}/ac-2-edited-dialog.png` });
  await record.getByRole("button", { name: "Save" }).click();
  // "Save" reads "Saving…" while in flight: Edit is back once it has landed.
  await expect(record.getByRole("button", { name: "Edit" })).toBeVisible();

  const agent = await describeAgent(stackA, "default");
  expect(agent.soul).toBe("You are Default v2. Answer in exactly one word.");
  expect(agent.description).toBe("persona updated from LilOS");
  expect(agent.model).toBe("fake-small");

  // The company record mirrors the profile (the harness reads
  // `employee.model` when a new session starts — AC-4 depends on it).
  const [listed] = await rpc(stackA.relayWs, stackA.relayToken, [
    { method: "employees.list", params: {} },
  ]);
  const record_row = (
    listed.result as {
      employees: { name: string; model: string; instructions: string }[];
    }
  ).employees.find((e) => e.name === "Default");
  expect(record_row?.model).toBe("fake-small");
  expect(record_row?.instructions).toBe(
    "You are Default v2. Answer in exactly one word.",
  );

  // The still-open page reads the mirrored record — new soul + model.
  await expect(record.getByText("You are Default v2.")).toBeVisible();
  // #194: the page shows the model's display name, not the id.
  await expect(record.getByText("Fake Small", { exact: true })).toBeVisible();
});

test("AC-4 a running session keeps its model; the next new session uses the updated default", async ({
  page,
}) => {
  // Session 1 starts on the current default (fake-small after AC-2's edit).
  await chatWithDefault(page, "first session", "Fake Small");
  await expect(
    page.locator("[data-agentturn]").getByText(/Fake Small/),
  ).toBeVisible({ timeout: 30_000 });
  const threadHash = new URL(page.url()).hash;

  // Edit the default model mid-conversation: Default's page, Edit, pick,
  // Save — then come back to the open session.
  await v3Sidebar(page)
    .getByRole("button", { name: /Hermes/ })
    .click();
  const record = v3Main(page);
  await openEdit(record);
  await pickModel(record, "Fake Reasoning");
  await record.getByRole("button", { name: "Save" }).click();
  // "Save" reads "Saving…" while in flight: Edit is back once it has landed.
  await expect(record.getByRole("button", { name: "Edit" })).toBeVisible();
  const agent = await describeAgent(stackA, "default");
  expect(agent.model).toBe("fake-reasoning");

  // A reply in the SAME conversation still runs on the start-time model.
  await page.goto(`${stackA.webUrl}/${threadHash}`);
  await expect(
    v3Peek(page)
      .locator("[data-thread-panel]")
      .getByPlaceholder(/^Message [^…]+…$/),
  ).toBeVisible({
    timeout: 30_000,
  });
  await replyInSession(page, "still the old model");
  await expect(
    page
      .locator("[data-agentturn]")
      .getByText(/Fake Small/)
      .last(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator("[data-agentturn]").getByText(/Fake Reasoning/),
  ).toHaveCount(0);

  // A new chat with the same person = a NEW session on the updated default.
  // (prompt words like "edit"/"change" trigger the fake's mutating script —
  // it parks the turn on an approval card, so keep the text neutral)
  await chatWithDefault(page, "a brand-new session", "Fake Reasoning");
  await expect(
    page.locator("[data-agentturn]").getByText(/Fake Reasoning/),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-new-session-model.png` });
});

test("AC-5 the per-session model picker still overrides the edited default", async ({
  page,
}) => {
  await chatWithDefault(page, "picker override", "Fake Reasoning");
  await expect(
    page.locator("[data-agentturn]").getByText(/Fake Reasoning/),
  ).toBeVisible({ timeout: 30_000 });

  // The picker on the open session shows the model it started on; picking
  // Fake Small overrides just this session.
  await v3Peek(page).locator('[data-slot="model-picker-trigger"]').click();
  await page.getByRole("button", { name: /Model$/ }).click();
  await page.locator("[cmdk-item]", { hasText: /^Fake Small$/ }).click();
  await page.keyboard.press("Escape");
  await replyInSession(page, "one more on the picked model");
  await expect(
    page.locator("[data-agentturn]").getByText(/Fake Small/),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-5-picker-override.png` });

  // The profile default itself is untouched by the per-session pick.
  const agent = await describeAgent(stackA, "default");
  expect(agent.model).toBe("fake-reasoning");
});
