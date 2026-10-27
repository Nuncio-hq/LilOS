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
 * v3 (#872): there is no page-wide edit mode — each field is its own inline
 * editor that saves on Enter/blur and cancels on Esc, the model chip saves
 * the moment a pick lands, and fields the engine doesn't advertise sit
 * read-only. Persona is the Instructions block; "Default model" is the
 * menu. Esc on the page still leaves it open (D-#769).
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

/** #872: the agent page's "Default model" menu — pick `label`; the pick
    saves the moment it lands (no page-level Save exists). */
async function pickModel(record: ReturnType<typeof v3Main>, label: string) {
  await record.getByRole("button", { name: "Default model" }).click();
  await record
    .getByRole("menu", { name: "Default model" })
    .getByRole("menuitemradio", { name: label })
    .click();
}

/** Commit the Instructions block: type, then blur — the save fires on the
    way out (#872). A failed save keeps the typed text (unit-tested); the
    e2e asserts the landed engine write below. */
async function setInstructions(
  record: ReturnType<typeof v3Main>,
  text: string,
) {
  const area = record.getByRole("textbox", { name: "Instructions" });
  await area.click();
  await area.fill(text);
  /* Blur is the commit — Tab moves focus off the field. */
  await area.press("Tab");
}

/** Edit the description line: it is an inline field — click its text,
    type, Enter commits (#872). */
async function setDescription(
  record: ReturnType<typeof v3Main>,
  current: RegExp,
  text: string,
) {
  await record.getByRole("button", { name: current }).click();
  const box = record.getByRole("textbox", { name: "Description" });
  await box.fill(text);
  await box.press("Enter");
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

test("AC-1 the page offers inline editing for exactly the fields the engine advertises", async ({
  page,
}) => {
  const record = await openDefault(stackA, page);
  /* #872: no Edit mode — the advertised fields are inline affordances.
     engine-fake advertises name/description/soul/model → the name is
     click-to-rename, the description line is an inline editor, the
     Instructions block is a textarea, and Default model is a menu. No
     page-level Save/Cancel/Edit exist at all. */
  await expect(
    record.getByRole("button", { name: "Hermes", exact: true }),
  ).toBeVisible(); // the title is the rename affordance
  await expect(
    record.getByRole("button", { name: /Your everyday assistant/ }),
  ).toBeVisible(); // the description line opens its input
  await expect(
    record.getByRole("textbox", { name: "Instructions" }),
  ).toBeVisible();
  await expect(
    record.getByRole("button", { name: "Default model" }),
  ).toBeVisible();
  await expect(record.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(record.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(record.getByRole("button", { name: "Edit" })).toHaveCount(0);
  // No field named Role exists — description IS the one-line field.
  await expect(record.getByRole("textbox", { name: "Role" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-1-agent-page.png` });
});

test("AC-1b Esc cancels the inline edit without closing the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const record = await openDefault(stackA, page);
  /* Esc in the Instructions block puts the old text back and never
     navigates — the record IS the page (D-#769), so it stays; and the
     same Esc must NOT commit the typed draft (#872 — the blur the Esc
     triggers used to save it). */
  const area = record.getByRole("textbox", { name: "Instructions" });
  const before = await area.inputValue();
  await area.click();
  await area.fill("Nope — never saved.");
  await area.press("Escape");
  await expect(area).toHaveValue(before);
  await expect(page).toHaveURL(/[#?&]page=agent&id=/);
  const agent = await describeAgent(stackA, "default");
  expect(agent.soul ?? "").not.toContain("Nope");
});

test("AC-2 inline edits write the engine profile the moment each lands (agents.update → agents.describe)", async ({
  page,
}) => {
  const record = await openDefault(stackA, page);
  /* #872: each field saves itself — Instructions on blur, the description
     on Enter, the model the moment the pick lands. There is no Save. */
  await setInstructions(
    record,
    "You are Default v2. Answer in exactly one word.",
  );
  await setDescription(
    record,
    /Your everyday assistant/,
    "persona updated from LilOS",
  );
  await pickModel(record, "Fake Small");
  await page.screenshot({ path: `${SHOTS}/ac-2-edited-page.png` });

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
      employees: {
        name: string;
        model: string;
        instructions: string;
        description?: string;
      }[];
    }
  ).employees.find((e) => e.name === "Default");
  expect(record_row?.model).toBe("fake-small");
  expect(record_row?.instructions).toBe(
    "You are Default v2. Answer in exactly one word.",
  );
  /* #872: the record also mirrors the description — a memory-only engine
     re-seeds its persona from it after a restart. */
  expect(record_row?.description).toBe("persona updated from LilOS");

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

  // Edit the default model mid-conversation: the agent page's Default
  // model menu — the pick saves the moment it lands (#872) — then come
  // back to the open session.
  await v3Sidebar(page)
    .getByRole("button", { name: /Hermes/ })
    .click();
  const record = v3Main(page);
  await pickModel(record, "Fake Reasoning");
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
