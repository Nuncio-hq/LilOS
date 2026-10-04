import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #193 — an employee with no DM channel hung the DM page on the
 * session skeleton forever (`!channel` read as "loading"). Now the harness
 * opens the DM channel at first-run hire, and the DM page opens it itself
 * (idempotent `channels.openDm`) when a settled directory says it's really
 * absent. Covers #189 too: an unknown employee id lands on a not-found
 * state instead of "Loading…".
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-193");

/** One JSON-RPC call on the relay from inside the page (hello + request). */
async function relayRpc<T>(
  page: Page,
  stack: Stack,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  return (await page.evaluate(
    async ({ ws, token, method, params }) => {
      const sock = new WebSocket(ws);
      const rpc = (id: number, m: string, p: Record<string, unknown>) =>
        sock.send(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }));
      return await new Promise((resolve, reject) => {
        const fail = (e: unknown) => {
          sock.close();
          reject(e instanceof Error ? e : new Error(String(e)));
        };
        sock.onerror = () => fail(new Error("ws error"));
        sock.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.error) return fail(new Error(msg.error.message));
          if (msg.id === 1) rpc(2, method, params);
          else if (msg.id === 2) {
            sock.close();
            resolve(msg.result);
          }
        };
        sock.onopen = () =>
          rpc(1, "session.hello", {
            protocolVersion: 1,
            token,
            client: { name: "e2e-193" },
          });
      });
    },
    {
      ws: stack.relayWs,
      token: stack.relayToken,
      method,
      params,
    },
  )) as Promise<T>;
}

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac193", await pickPorts(), {
    // #118: pin the signed-in name so the first-run card's Open-DM
    // button is enabled deterministically.
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const skeletons = (page: Page) => page.locator("[data-session-skeleton]");

test("AC-1 first-run hire's DM settles on the empty state, never an endless skeleton", async ({
  page,
}) => {
  await page.goto(`${stack.webUrl}/`);
  // The first-run card's Open-DM button enables once the harness hire lands.
  const openDm = page.getByRole("button", { name: /open dm with/i });
  await expect(openDm).toBeEnabled({ timeout: 30_000 });
  await openDm.click();
  await expect(page).toHaveURL(/\/dm\//);
  // The harness opened the DM channel at hire, so after the directory lands
  // the page shows the empty state — the skeleton, if it flashes, is bounded.
  await expect(page.getByText(/Start a session with/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(skeletons(page)).toHaveCount(0);
  await expect(page.locator("textarea").last()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-empty-state.png` });
});

test("AC-4 a relay-created employee with no DM channel settles on the empty state and sends", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto(`${stack.webUrl}/`);
  const { employee } = await relayRpc<{ employee: { id: string } }>(
    page,
    stack,
    "employees.create",
    { name: "Ghost", role: "engineer", profile: "builder" },
  );
  await page.goto(`${stack.webUrl}/dm/${employee.id}`);
  // No skeleton loop: the page opens the missing DM channel itself and the
  // empty state settles.
  await expect(page.getByText("Start a session with Ghost")).toBeVisible({
    timeout: 15_000,
  });
  await expect(skeletons(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-4-empty-state.png` });

  // The first message still works — sendDm opens a conversation on the
  // freshly created channel and the session lands in Focus (#114).
  const box = page.locator("textarea").last();
  await box.fill("hello from the void");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-first-send.png` });
});

test("AC-5 (#189) an unknown employee id lands on a not-found state", async ({
  page,
}) => {
  await page.goto(`${stack.webUrl}/dm/emp-does-not-exist`);
  await expect(page.locator("[data-employee-not-found]")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Employee not found")).toBeVisible();
  await expect(page.getByText("Loading…")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-5-not-found.png` });
});
