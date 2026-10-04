import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootStack, pickPorts } from "./helpers/stack";

/**
 * Issue #85 — release builds run Hermes; engine-fake is test/dev only.
 * Boots the real `bun run dev` stack on offset ports (same pattern as
 * e2e/ac-27-dm.spec.ts):
 *
 *   AC-2: LILOS_ENGINE=hermes with a dead HERMES_BIN — the status dialog and
 *         the DM composer say plainly that Hermes is missing (no silent fake).
 *   AC-4: the default dev stack on engine-fake is labeled "dev · fake engine".
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-85");

/** Bare JSON-RPC seed client — e2e runs under Node without workspace deps. */
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

test.describe.configure({ mode: "serial" });

test("AC-2 (#85) a missing Hermes reads plainly — status dialog + DM composer", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await bootStack("nohermes", await pickPorts(), {
    LILOS_ENGINE: "hermes",
    HERMES_BIN: "/nonexistent/hermes-ac85",
  });
  try {
    // Engine down means no auto-hire: seed the employee + DM over the relay.
    const [created] = await rpc(stack.relayWs, stack.relayToken, [
      {
        method: "employees.create",
        params: {
          name: "Default",
          role: "Founder's engineer",
          profile: "default",
          status: "online",
        },
      },
    ]);
    const employeeId = (created.result as { employee: { id: string } }).employee
      .id;
    await rpc(stack.relayWs, stack.relayToken, [
      { method: "channels.openDm", params: { employeeId } },
    ]);

    // The engine leg needs a few supervisor retries before it lands `failed`;
    // statusPollMs shortens the app's 15s poll so the test isn't timing-bound.
    await page.goto(`${stack.webUrl}/dm/${employeeId}?statusPollMs=500`);
    await page.screenshot({ path: `${SHOTS}/ac-2-dm.png` });

    await expect(page.locator("[data-composer-note]")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator("[data-composer-note]")).toContainText(
      "Hermes not found at /nonexistent/hermes-ac85",
    );

    await page.getByRole("button", { name: "System status" }).click();
    const dialog = page.getByRole("dialog", { name: "System status" });
    await expect(dialog.getByText(/Hermes not found at/).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-2-status.png` });
    // And it is not quietly the fake engine.
    await expect(dialog.getByText(/engine-fake/)).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

test("AC-4 (#85) a dev stack on the fake engine is labeled", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await bootStack("fakelabel", await pickPorts(), {
    LILOS_ENGINE: "fake",
  });
  try {
    await page.goto(`${stack.webUrl}/?statusPollMs=500`);
    const label = page.locator("[data-build-label]");
    await expect(label).toHaveText("dev · fake engine", { timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/ac-4-dev-label.png` });

    // Sidebar regression guard (#90 review): at fixed 264px the row's role
    // text must truncate, never the employee name — a 0-width name renders
    // 'hidden' to Playwright and invisible to Oscar.
    const name = page.locator("aside").getByText(/^default$/i);
    await page.setViewportSize({ width: 1288, height: 700 });
    await expect(name).toBeVisible();
    expect((await name.boundingBox())?.width ?? 0).toBeGreaterThan(0);

    // Below lg the sidebar becomes an overlay; land on the DM and open it
    // from the header menu, then check the same invariant there.
    await page.getByRole("button", { name: "Set up later" }).click();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.locator("main header button").first().click();
    const overlayName = page.locator("aside").getByText(/^default$/i);
    await expect(overlayName).toBeVisible();
    expect((await overlayName.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  } finally {
    await stack.stop();
  }
});
