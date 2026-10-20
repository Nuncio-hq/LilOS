import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootStack, pickPorts, skipFirstRun } from "./helpers/stack";

/**
 * Issue #85 — release builds run Hermes; engine-fake is test/dev only.
 * Boots the real `bun run dev` stack on offset ports (same pattern as
 * e2e/ac-27-dm.spec.ts):
 *
 *   AC-2: LILOS_ENGINE=hermes with a dead HERMES_BIN — the status banner and
 *         the System status dialog behind its Details button say plainly that
 *         Hermes is missing (no silent fake).
 *   AC-4: the "dev · fake engine" label sat on the old sidebar; v3's shell has
 *         no build label, so that leg (and its sidebar-width guard) is gone.
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

test.describe.configure({ mode: "serial" });

test("AC-2 (#85) a missing Hermes reads plainly — status banner + dialog", async ({
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
    // statusPollMs shortens the app's 15s poll so the test isn't timing-bound
    // (a real query param, so it rides ahead of the hash).
    await skipFirstRun(page);
    await page.goto(
      `${stack.webUrl}/?statusPollMs=500#?page=people&open=agent:${employeeId}`,
    );
    await page.screenshot({ path: `${SHOTS}/ac-2-dm.png` });

    /* v3 draws the engine's plain reason as the banner above every page; the
       old composer note went with the DM composer. */
    const banner = page.getByRole("status").filter({ hasText: /Details/ });
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await expect(banner).toContainText(
      "Hermes not found at /nonexistent/hermes-ac85",
      { timeout: 60_000 },
    );

    await banner.getByRole("button", { name: "Details" }).click();
    const dialog = page.getByRole("dialog", { name: "System status" });
    await expect(dialog.getByText(/Hermes not found at/).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-2-status.png` });
    // And it is not quietly the fake engine.
    await expect(dialog.getByText(/engine-fake/)).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});
