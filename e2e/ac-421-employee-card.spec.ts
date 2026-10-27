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
 * Issue #421 — one shared employee card (engine, owner, profile, model, now
 * rows + the missing-profile switch) instead of an app-local modal.
 *
 * v3: the card is the agent's page (`v3-agent.tsx`), opened from its
 * sidebar row — a jump, so the record lands as the page (D-#769). What that page shows of the old card: the engine
 * ("Runs on"), the engine profile ("Profile"), the model, the "Now" row with
 * its status, the role, the instructions, and a Message button. What it does
 * NOT have (reported, not faked): the "owned by <you>" line, the "Instructions
 * (SOUL.md)" label and its "No instructions yet" empty state (the page draws
 * an Instructions section only when there is text), the footer note, and the
 * missing-profile switch. AC-2's switch is therefore driven through the relay
 * call the old combobox made (`employees.update {profile}`) and asserted end
 * to end: the record re-points and the next session boots on the new profile.
 * The prototype side-by-side leg (old AC-3, a composite against the
 * prototype's own card on :5199) is dropped: that screen is the v3 shell now,
 * and AC-3 (#504) below keeps the real-app matrix.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");

const DIMS = [
  [1288, 700],
  [1288, 900],
  [1440, 900],
] as const;

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac421", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

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

/** Open `name`'s page from its sidebar row — a jump, so the record is the
 *  page column (D-#769), past first run.
 *  `statusPollMs` shortens the engine-name poll so the "Runs on" row reads
 *  `engine-fake` well inside the waits. AC-2/AC-504 leave extra employees on
 *  this shared stack, so always click through the named row. */
async function openAgentPage(page: Page, name: string) {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/?statusPollMs=500`);
  const row = v3Sidebar(page).getByRole("button", {
    name: new RegExp(`${name}$`),
  });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  /* A sidebar pick is a jump: the agent's page IS the page (D-#769). */
  const record = v3Main(page);
  await expect(record.getByRole("heading", { level: 1, name })).toBeVisible();
  return record;
}

/** One labelled row of the agent page's property list. */
const prop = (record: ReturnType<typeof v3Main>, label: string) =>
  record
    .locator("div.flex.min-h-9")
    .filter({ hasText: new RegExp(`^${label}`) });

test("AC-1 the agent page carries the card's rows: engine, profile, model, now; no old-modal Soul row", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const record = await openAgentPage(page, "Default");

  // The card's grid on the page: Engine → "Runs on", Model, Now (+ Idle).
  // engine.name lands on the harness's second status report (~10s); the row
  // is left out until the probe lands.
  await expect(prop(record, "Runs on")).toContainText("engine-fake", {
    timeout: 30_000,
  });
  await expect(prop(record, "Profile")).toContainText("default");
  await expect(prop(record, "Model")).toBeVisible();
  await expect(prop(record, "Now")).toContainText("Idle");
  // The Instructions are the engine profile's own persona (the page reads
  // `agents.describe`), so the stock Default shows engine-fake's soul text.
  await expect(record.getByText("Instructions", { exact: true })).toBeVisible();
  await expect(record.getByText(/You are the default agent/)).toBeVisible({
    timeout: 30_000,
  });
  // The old modal's signature: a "Soul" row — gone.
  await expect(record.getByText("Soul", { exact: true })).toHaveCount(0);
  // Message starts a chat with them — a new-chat draft beside the page
  // (a draft belongs on its agent's page, D-#769), and its visible ✕ closes
  // the peek.
  await record.getByRole("button", { name: "Message" }).click();
  await expect(v3Peek(page)).toBeVisible();
  await v3Peek(page)
    .getByRole("button", { name: /^Close/ })
    .click();
  await expect(v3Peek(page)).toHaveCount(0);
});

test("AC-2 the missing-profile switch works end to end", async ({ page }) => {
  test.setTimeout(120_000);
  // An employee whose engine profile is gone. v3's agent page has no
  // missing-profile notice or switch (reported), so the pick is the relay
  // call the old combobox made; the record must re-point and the next
  // session must start on the new profile.
  const [created] = await rpc(stack.relayWs, stack.relayToken, [
    {
      method: "employees.create",
      params: {
        name: "Switchy",
        role: "Deckhand",
        profile: "ghost",
        status: "online",
      },
    },
  ]);
  const employeeId = (created.result as { employee: { id: string } }).employee
    .id;

  const record = await openAgentPage(page, "Switchy");
  await expect(page).toHaveURL(new RegExp(`page=agent&id=${employeeId}`));
  await expect(record.getByText(/Deckhand/)).toBeVisible();

  await rpc(stack.relayWs, stack.relayToken, [
    {
      method: "employees.update",
      params: { id: employeeId, profile: "builder" },
    },
  ]);
  // Relay truth: the record re-pointed.
  const [listed] = await rpc(stack.relayWs, stack.relayToken, [
    { method: "employees.list", params: {} },
  ]);
  const employees = (
    listed.result as {
      employees: { id: string; profile: string }[];
    }
  ).employees;
  expect(employees.find((e) => e.id === employeeId)?.profile).toBe("builder");

  // The next session boots on the switched profile: Message → send, then
  // read the conversation's engine replay for session.started.agent.
  await record.getByRole("button", { name: "Message" }).click();
  const box = v3Peek(page).getByPlaceholder("Message Switchy…");
  await box.fill("switch check");
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/[?&]open=([^&]*,)?thread:[^&,]+/, {
    timeout: 15_000,
  });
  const conversationId = decodeURIComponent(
    /thread:([^&,]+)/.exec(page.url())?.[1] ?? "",
  );
  if (!conversationId) throw new Error("URL missing the thread id");
  await expect(page.locator("[data-agentturn]").first()).toBeVisible({
    timeout: 60_000,
  });

  const [events] = await rpc(stack.relayWs, stack.relayToken, [
    {
      method: "session.events",
      params: { conversationId, after: 0 },
    },
  ]);
  const frames = (
    events.result as {
      events: { type: string; payload?: { agent?: string } }[];
    }
  ).events;
  const started = frames.find((f) => f.type === "session.started");
  expect(started?.payload?.agent).toBe("builder");
});

const SHOTS_504 = path.join(repo, "test-results", "ac-504");

/* #504 AC-3: the card in the real app, one shot per instructions-state ×
   dims × scheme. "Souly" carries `instructions` (the record's copy of a
   persona) and "Bare" carries none; both name a profile the engine does not
   describe, so the page falls back to the record and the two states stay
   exactly "text" and "no text" (Default's page shows the engine profile's
   own soul now — AC-1). v3 draws an Instructions section only when there is
   text, never an empty placeholder. Both stay idle, so every shot also shows
   the muted "Idle" Now row. CI uploads test-results/ac-504/ as an artifact;
   the shots land in pr-assets/504/ from there. */
test("AC-3 (#504) shots: with + without instructions, 3 dims × light/dark", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await rpc(stack.relayWs, stack.relayToken, [
    {
      method: "employees.create",
      params: {
        name: "Souly",
        role: "Reviewer",
        status: "online",
        profile: "no-such-profile",
        model: "fake-small",
        instructions:
          "You review changes for correctness, tests and boundaries. Comment with file:line. Never push to main.",
      },
    },
    {
      method: "employees.create",
      params: {
        name: "Bare",
        role: "Deckhand",
        status: "online",
        profile: "no-such-profile",
        model: "fake-small",
      },
    },
  ]);
  const html = page.locator("html");
  const schemeIs = async (s: "light" | "dark") => {
    if (s === "dark") await expect(html).toHaveClass(/dark/);
    else await expect(html).not.toHaveClass(/dark/);
  };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of DIMS) {
      await page.setViewportSize({ width: w, height: h });
      const noSoul = await openAgentPage(page, "Bare");
      await schemeIs(scheme);
      await expect(prop(noSoul, "Runs on")).toContainText("engine-fake", {
        timeout: 30_000,
      });
      await expect(
        noSoul.getByText("Instructions", { exact: true }),
      ).toHaveCount(0);
      await expect(prop(noSoul, "Now")).toContainText("Idle");
      await page.screenshot({
        path: `${SHOTS_504}/card-nosoul-${w}x${h}-${scheme}.png`,
      });
      const soul = await openAgentPage(page, "Souly");
      await schemeIs(scheme);
      await expect(prop(soul, "Runs on")).toContainText("engine-fake", {
        timeout: 30_000,
      });
      await expect(
        soul.getByText("Instructions", { exact: true }),
      ).toBeVisible();
      await expect(soul.getByText(/You review changes/)).toBeVisible();
      await expect(prop(soul, "Now")).toContainText("Idle");
      await page.screenshot({
        path: `${SHOTS_504}/card-soul-${w}x${h}-${scheme}.png`,
      });
    }
  }
});
