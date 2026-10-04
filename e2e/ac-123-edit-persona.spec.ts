import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #123 — edit an employee's persona (soul) and default model from the
 * Edit dialog (`agents.update`), on the real stack (apps/web → relay →
 * harness → engine-fake). Each acceptance criterion is a named test. Engine
 * truth is probed over the real JSON-RPC path.
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
  const ws = new WebSocket(relayWs);
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

/** Open the app past first-run, landed on the auto-hired Default's DM. */
async function openApp(stack: Stack, page: Page) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${stack.webUrl}/`);
  await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
  await expect(
    page.locator("aside").getByRole("button", { name: /Default/ }),
  ).toBeVisible({ timeout: 30_000 });
}

const editDialog = (page: Page) =>
  page.locator("div.fixed.inset-0", { hasText: "Edit employee" });

async function openEdit(page: Page) {
  await page.getByRole("button", { name: /Profile/ }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  const dlg = editDialog(page);
  await expect(dlg).toBeVisible();
  return dlg;
}

/** Open the session row whose root message is `text` (split-pane home list). */
async function openConvRow(page: Page, rootText: string) {
  await page
    .locator("[data-session]", { hasText: rootText })
    .getByRole("button", { name: /\d+ repl(y|ies)/ })
    .click();
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+(\/focus)?$/);
}

/** Send a top-level DM message → a new session (employee-home composer).
 *  The composer navigates into the thread on send; if that navigate is still
 *  pending (a feed re-render can swallow it), open the new row by its text. */
async function sendDm(page: Page, text: string) {
  const composer = page.getByPlaceholder(/New session with/);
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page)
    .toHaveURL(/\/dm\/[^/]+\/[^/]+(\/focus)?$/, { timeout: 4_000 })
    .catch(() => openConvRow(page, text));
}

/** Reply inside the open conversation — same session, a fresh turn. */
async function replyInSession(page: Page, text: string) {
  /* Opening a session lands in Focus (#114): its composer reads
     "Continue session … with …"; the peek panel keeps "Reply to …". */
  const box = page.getByPlaceholder(
    /Reply to .* in this session|Continue session .* with/,
  );
  await box.fill(text);
  await box.press("Enter");
}

test("AC-1 the Edit dialog shows only the fields the engine advertises", async ({
  page,
}) => {
  await openApp(stackA, page);
  const dlg = await openEdit(page);
  // engine-fake advertises description/soul/model (and name, which the
  // company record already owns) — the dialog renders exactly those.
  await expect(dlg.getByLabel("Display name")).toBeVisible();
  await expect(dlg.getByLabel("Persona")).toBeVisible();
  await expect(dlg.getByLabel("Description")).toBeVisible();
  await expect(dlg.getByText(/Applies to new chats/)).toBeVisible(); // AC-4's note
  await expect(dlg.getByRole("button", { name: "Fake Small" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-edit-dialog.png` });
  await dlg.getByRole("button", { name: "Cancel" }).click();
});

test("AC-1b the Edit dialog fits a short window — body scrolls, Save stays reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await openApp(stackA, page);
  const dlg = await openEdit(page);
  // The dialog card is capped inside the viewport; the footer with Save is
  // pinned, the field body is the part that scrolls.
  const box = await dlg.locator("div.max-w-md").boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(600);
  const save = dlg.getByRole("button", { name: "Save" });
  await expect(save).toBeVisible();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dlg).toHaveCount(0);
});

test("AC-2 saving a new persona + model writes the engine profile (agents.update → agents.describe)", async ({
  page,
}) => {
  await openApp(stackA, page);
  const dlg = await openEdit(page);
  await dlg
    .getByLabel("Persona")
    .fill("You are Default v2. Answer in exactly one word.");
  await dlg.getByLabel("Description").fill("persona updated from LilOS");
  await dlg.getByRole("button", { name: "Fake Small" }).click();
  await page.screenshot({ path: `${SHOTS}/ac-2-edited-dialog.png` });
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toHaveCount(0);

  const agent = await describeAgent(stackA, "default");
  expect(agent.soul).toBe("You are Default v2. Answer in exactly one word.");
  expect(agent.description).toBe("persona updated from LilOS");
  expect(agent.model).toBe("fake-small");

  // The still-open profile card reads the mirrored record — new soul + model.
  const card = page.getByRole("dialog", { name: /Default profile/ });
  await expect(card.getByText("You are Default v2.")).toBeVisible();
  // #194: the card shows the model's display name, not the id.
  await expect(card.getByText("Fake Small")).toBeVisible();
  // #421: the shared card's Message button is the close — no Close button.
  await card.getByRole("button", { name: "Message" }).click();
});

test("AC-4 a running session keeps its model; the next new session uses the updated default", async ({
  page,
}) => {
  await openApp(stackA, page);
  // Session 1 starts on the current default (fake-small after AC-2's edit).
  await sendDm(page, "first session");
  await expect(
    page.locator("[data-agentturn]").getByText(/Fake Small/),
  ).toBeVisible({ timeout: 30_000 });

  // Edit the default model mid-conversation (Profile lives on the DM home —
  // hop out, edit, then come back to the open session). Focus has no sidebar
  // (#246) — leave it first when the URL is a /focus one.
  const convUrl = page.url();
  if (convUrl.endsWith("/focus")) {
    await page.getByTitle("Back to DM").click();
  }
  await page
    .locator("aside")
    .getByRole("button", { name: /Default/ })
    .click();
  const dlg = await openEdit(page);
  await dlg.getByRole("button", { name: "Fake Reasoning" }).click();
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toHaveCount(0);
  const agent = await describeAgent(stackA, "default");
  expect(agent.model).toBe("fake-reasoning");
  // The profile card stays open behind the dialog — dismiss it.
  // #421: the shared card's Message button is the close — no Close button.
  await page
    .getByRole("dialog", { name: /Default profile/ })
    .getByRole("button", { name: "Message" })
    .click();

  // A reply in the SAME conversation still runs on the start-time model.
  // #195: the row opens the peek panel at /dm/e/c; its ↗ carries on to Focus.
  await openConvRow(page, "first session");
  await page
    .locator("[data-thread-panel]")
    .getByTitle("Focus", { exact: true })
    .click();
  await expect(page).toHaveURL(convUrl);
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

  // Back to the employee home → a new top-level message = a NEW session.
  // Focus has no sidebar (#246) — leave it first when the URL is a /focus one.
  if (page.url().endsWith("/focus")) {
    await page.getByTitle("Back to DM").click();
  }
  await page
    .locator("aside")
    .getByRole("button", { name: /Default/ })
    .click();
  await expect(page).toHaveURL(/\/dm\/[^/]+$/);
  // (prompt words like "edit"/"change" trigger the fake's mutating script —
  // it parks the turn on an approval card, so keep the text neutral)
  await sendDm(page, "a brand-new session");
  await expect(
    page.locator("[data-agentturn]").getByText(/Fake Reasoning/),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-new-session-model.png` });
});

test("AC-5 the per-session model picker still overrides the edited default", async ({
  page,
}) => {
  await openApp(stackA, page);
  await sendDm(page, "picker override");
  await expect(
    page.locator("[data-agentturn]").getByText(/Fake Reasoning/),
  ).toBeVisible({ timeout: 30_000 });

  // The picker on the open session shows the model it started on; picking
  // Fake Small overrides just this session.
  await page.locator('[data-slot="model-picker-trigger"]').last().click();
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
