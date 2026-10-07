import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #421 — the DM header opens the prototype's shared `EmployeeCard`
 * (engine, owner, profile, model, now rows + missing-profile switch); the
 * app-local `EmployeeProfileCard` modal is gone. AC-2 runs the switch end
 * to end on engine-fake: pick `builder`, the relay record re-points, the
 * next session's `session.started` names `builder` as its agent. AC-3 is
 * the side-by-side screenshot matrix vs the prototype's own card.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-421");

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

/** Open the app past first-run, landed on `name`'s DM (defaults to the
 *  auto-hired Default). `statusPollMs` shortens the engine-name poll so the
 *  card's Engine row reads `engine-fake` well inside the waits. */
async function openApp(page: Page, name = "Default") {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${stack.webUrl}/`);
  await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
  await page.goto(`${page.url()}?statusPollMs=500`);
  /* AC-2/AC-504 leave extra employees on this shared stack, so `/` can land
     on another DM. Always click through the named sidebar row. */
  const row = page
    .locator("aside")
    .getByRole("button", { name: new RegExp(`^${name} `) });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(
    page.getByRole("textbox", { name: new RegExp(`New thread with ${name}`) }),
  ).toBeVisible();
}

/** The header's profile card — the shared card in a dialog shell. */
const card = (page: Page) =>
  page.getByRole("dialog", { name: /Default profile/i });

test("AC-1 the DM header opens the shared EmployeeCard, app-local modal gone", async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole("button", { name: /^Profile$/ }).click();
  const dlg = card(page);
  await expect(dlg).toBeVisible();

  // The shared card's shape: avatar + "role · owned by Oscar", the
  // Engine/Profile/Model/Now grid, the Instructions block, footer note —
  // none of which the old modal had (it listed Profile/Model/Soul only).
  await expect(dlg.getByText(/owned by Oscar/)).toBeVisible();
  await expect(dlg.locator("dt", { hasText: "Engine" })).toBeVisible();
  await expect(dlg.locator("dt", { hasText: "Profile" })).toBeVisible();
  await expect(dlg.locator("dt", { hasText: "Model" })).toBeVisible();
  await expect(dlg.locator("dt", { hasText: "Now" })).toBeVisible();
  // engine.name lands on the harness's second status report (~10s); the
  // card falls back to "engine" until the probe lands.
  await expect(dlg.getByText("engine-fake")).toBeVisible({ timeout: 30_000 });
  await expect(dlg.getByText("Instructions (SOUL.md)")).toBeVisible();
  await expect(
    dlg.getByText(/Persona, memory and skills live in the engine profile/),
  ).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Message" })).toBeVisible();
  // #504: two Edit affordances — the header button and the empty-state link.
  await expect(dlg.getByRole("button", { name: "Edit" })).toHaveCount(2);
  // The old modal's signature: a "Soul" row — gone. #504: the close
  // affordance is the shell's visible ✕ inside the dialog.
  expect(await dlg.locator("dt", { hasText: "Soul" }).count()).toBe(0);
  await expect(dlg.getByRole("button", { name: "Close" })).toBeVisible();
  // #504 empty states on the real stack: Default's record carries no
  // SOUL.md and she sits idle — the card says so instead of bare labels.
  await expect(dlg.getByText(/No instructions yet/)).toBeVisible();
  await expect(dlg.getByText("Idle")).toBeVisible();

  // Edit still routes into the engine-profile editor; closing it brings the
  // card back (the shell stays mounted behind the dialog). Two Edit
  // affordances exist now — the header button + the empty-state link (#504);
  // the header one is first.
  await dlg.getByRole("button", { name: "Edit" }).first().click();
  const edit = page.locator("div.fixed.inset-0", { hasText: "Edit employee" });
  await expect(edit).toBeVisible();
  await expect(dlg).toHaveCount(0);
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toBeVisible();
  // Message closes (you are already in the DM).
  await dlg.getByRole("button", { name: "Message" }).click();
  await expect(dlg).toHaveCount(0);
  // #504: the visible ✕ closes too — reopen, click it, gone.
  await page.getByRole("button", { name: /^Profile$/ }).click();
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect(dlg).toHaveCount(0);
});

test("AC-2 the missing-profile switch works end to end", async ({ page }) => {
  test.setTimeout(120_000);
  // An employee whose engine profile is gone: the card must offer the
  // switch, and the pick must re-point the relay record so the next
  // session starts on the new profile.
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

  await openApp(page);
  await page
    .locator("aside")
    .getByRole("button", { name: /Switchy/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/dm/${employeeId}`));

  await page.getByRole("button", { name: /^Profile$/ }).click();
  const dlg = page.getByRole("dialog", { name: /Switchy profile/i });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText(/Profile missing/)).toBeVisible();
  await dlg.getByRole("combobox").click();
  await page
    .getByRole("option", { name: /\bbuilder\b/ })
    .first()
    .click();
  await expect(dlg.getByText(/Profile missing/)).toHaveCount(0);

  // Relay truth: the record re-pointed — no reload needed, the dialog's
  // fresh row shows it too.
  await expect(dlg.locator("dd", { hasText: "builder" })).toBeVisible({
    timeout: 10_000,
  });
  const [listed] = await rpc(stack.relayWs, stack.relayToken, [
    { method: "employees.list", params: {} },
  ]);
  const employees = (
    listed.result as {
      employees: { id: string; profile: string }[];
    }
  ).employees;
  expect(employees.find((e) => e.id === employeeId)?.profile).toBe("builder");

  // The next session boots on the switched profile: send a DM, then read
  // the conversation's engine replay for session.started.agent.
  await page.getByRole("button", { name: "Message" }).click();
  const composer = page.getByPlaceholder(/New thread with/);
  await composer.fill("switch check");
  await composer.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/dm/${employeeId}/[^/]+`), {
    timeout: 15_000,
  });
  const conversationId = page.url().match(/\/dm\/[^/]+\/([^/]+)/)?.[1];
  if (!conversationId) throw new Error("DM URL missing conversation id");
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

test("AC-3 side-by-side vs the prototype card, 3 dims × light/dark", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const html = page.locator("html");

  const appCard = async () => {
    await openApp(page);
    await page.getByRole("button", { name: /^Profile$/ }).click();
    await expect(card(page)).toBeVisible();
    // Wait out the profiles fetch + the engine-name probe so the rows are
    // the real data (engine.name lands on the harness's ~10s report).
    await expect(card(page).getByText("engine-fake")).toBeVisible({
      timeout: 30_000,
    });
  };
  const protoCard = async () => {
    await page.goto("/"); // prototype dev server (playwright webServer :5199)
    await page
      .locator("aside")
      .first()
      .getByRole("button", { name: /Builder/ })
      .click();
    await page.getByRole("button", { name: "Profile" }).click();
    const panel = page.locator("aside").last();
    await expect(panel.getByText(/owned by/)).toBeVisible();
  };
  /** Composite: app shot left, prototype shot right, one PNG. The viewport
   * widens to both halves — an element screenshot clips to the view. */
  const composite = async (
    a: Buffer,
    b: Buffer,
    out: string,
    w: number,
    h: number,
  ) => {
    await page.setViewportSize({ width: w * 2, height: h });
    await page.setContent(`<body style="margin:0;display:flex">
      <img src="data:image/png;base64,${a.toString("base64")}">
      <img src="data:image/png;base64,${b.toString("base64")}">
    </body>`);
    await page.screenshot({ path: out });
  };

  /* The theme check runs after each load — the composite page replaces the
     document, so asserting .dark before navigation would inspect the wrong
     page. */
  const schemeIs = async (s: "light" | "dark") => {
    if (s === "dark") await expect(html).toHaveClass(/dark/);
    else await expect(html).not.toHaveClass(/dark/);
  };

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of DIMS) {
      await page.setViewportSize({ width: w, height: h });
      await appCard();
      await schemeIs(scheme);
      const appShot = await page.screenshot();
      await protoCard();
      await schemeIs(scheme);
      const protoShot = await page.screenshot();
      await composite(
        appShot,
        protoShot,
        `${SHOTS}/card-${w}x${h}-${scheme}.png`,
        w,
        h,
      );
    }
  }
});

const SHOTS_504 = path.join(repo, "test-results", "ac-504");

/* #504 AC-3: the polished card in the real app, one shot per
   SOUL.md-state × dims × scheme. "Souly" carries `instructions` (the
   hire-time mirror of a profile's soul); Default's record has none — the
   first-run hire reads the soul-less `agents.list` row. Both stay idle, so
   every shot also shows the muted "Idle" Now row and the single-frame
   dialog with its ✕. CI uploads test-results/ac-504/ as an artifact; the
   shots land in pr-assets/504/ from there. */
test("AC-3 (#504) shots: with + without SOUL.md, 3 dims × light/dark", async ({
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
        profile: "reviewer",
        model: "fake-small",
        instructions:
          "You review changes for correctness, tests and boundaries. Comment with file:line. Never push to main.",
      },
    },
  ]);
  const html = page.locator("html");
  const schemeIs = async (s: "light" | "dark") => {
    if (s === "dark") await expect(html).toHaveClass(/dark/);
    else await expect(html).not.toHaveClass(/dark/);
  };
  /** Open `name`'s card from the sidebar row (openApp already landed us on a DM). */
  const openCard = async (name: "Default" | "Souly") => {
    await page
      .locator("aside")
      .getByRole("button", { name: new RegExp(`^${name} `) })
      .click();
    await expect(
      page.getByRole("textbox", {
        name: new RegExp(`New thread with ${name}`),
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Profile$/ }).click();
    const dlg = page.getByRole("dialog", {
      name: new RegExp(`${name} profile`, "i"),
    });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText("engine-fake")).toBeVisible({
      timeout: 30_000,
    });
    return dlg;
  };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of DIMS) {
      await page.setViewportSize({ width: w, height: h });
      await openApp(page);
      const noSoul = await openCard("Default");
      await schemeIs(scheme);
      await expect(noSoul.getByText(/No instructions yet/)).toBeVisible();
      await page.screenshot({
        path: `${SHOTS_504}/card-nosoul-${w}x${h}-${scheme}.png`,
      });
      await noSoul.getByRole("button", { name: "Close" }).click();
      await expect(noSoul).toHaveCount(0);
      const soul = await openCard("Souly");
      await schemeIs(scheme);
      await expect(soul.getByText(/You review changes/)).toBeVisible();
      await page.screenshot({
        path: `${SHOTS_504}/card-soul-${w}x${h}-${scheme}.png`,
      });
      await soul.getByRole("button", { name: "Close" }).click();
      await expect(soul).toHaveCount(0);
    }
  }
});
