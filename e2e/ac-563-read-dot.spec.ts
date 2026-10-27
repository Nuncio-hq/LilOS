import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #563 — a turn that finishes (or fails) while its thread is unopened
 * dots its thread card AND the agent's sidebar row; opening the thread stamps
 * the relay's read watermark, clearing both dots on every client at once (the
 * watermark is server-side — a second browser clears live off
 * `conversation.updated`).
 *
 * Serial legs on one stack: the dot is created on client A, seen on client
 * B, cleared by A's open.
 *
 * v3 shows the unseen mark on the thread's card on the Threads board (the
 * sky dot, `data-thread-unseen`) and on the person: the agent's sidebar dot
 * follows its most urgent thread (needs > working > failed > unseen > idle),
 * so a finish nobody has looked at reads `done` — its own status colour —
 * until the thread is opened and the dot falls back to `idle`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-563");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("read-dot", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const THREADS = (webUrl: string) => `${webUrl}/#?page=threads`;

/** Every unseen thread's card dot on the Threads board. */
const cardDot = (page: Page) => page.locator("[data-thread-unseen]");

/** The Default agent's sidebar row, and its dot in status `status`. */
const agentDot = (page: Page, status: string) =>
  v3Sidebar(page)
    .getByRole("button", { name: /hermes/i })
    .locator(`[data-v3-status="${status}"]`);

test("finish while unopened dots the card and the agent; opening clears both on both clients", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await browser.newPage();
  /* A second browser = the other device: it must see the dot appear and
     clear live, without touching the thread itself. */
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();

  /* Client A: send, then immediately leave the thread — the turn finishes
     while the Threads board (not the thread) is on screen. `slow:` paces the
     turn so the hop out of the thread always beats the finish. */
  const agent = await openDefaultAgent(page, stack.webUrl);
  await startChat(
    page,
    stack.webUrl,
    agent,
    "slow:500 Say hello then list files",
  );
  await page.goto(THREADS(stack.webUrl));
  await expect(page).toHaveURL(/page=threads$/);

  /* The finish lands unopened: the dot shows on the thread's card on BOTH
     clients — its appearance is the completion signal. Client B stays on the
     board, never touching the thread: its dot must arrive over the
     boot-wide conversation updates, not an open thread feed. */
  await skipFirstRun(pageB);
  await pageB.goto(THREADS(stack.webUrl));
  await expect(cardDot(page)).toBeVisible({ timeout: 90_000 });
  await expect(cardDot(pageB)).toBeVisible({ timeout: 90_000 });
  // The same finish dots the agent's sidebar row on both clients: the one
  // thread is finished and unseen, so the agent wears `done`, not `idle`.
  await expect(agentDot(page, "done")).toBeVisible({ timeout: 30_000 });
  await expect(agentDot(pageB, "done")).toBeVisible({ timeout: 30_000 });
  await expect(agentDot(page, "idle")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/dot-card.png` });

  /* Opening the thread stamps the watermark: the dots clear on A's board and
     sidebar AND on B's — no reload, no second mark. */
  await cardDot(page).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  await expect(cardDot(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(cardDot(pageB)).toHaveCount(0, { timeout: 30_000 });
  await expect(agentDot(page, "done")).toHaveCount(0, { timeout: 30_000 });
  await expect(agentDot(pageB, "done")).toHaveCount(0, { timeout: 30_000 });
  await expect(agentDot(pageB, "idle")).toBeVisible();

  /* …and the clear is the stored watermark, not a UI state: back on the
     board the card reads clean, and a reload keeps it that way — the agent
     too. */
  await page.goto(THREADS(stack.webUrl));
  await expect(cardDot(page)).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Threads", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(cardDot(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(agentDot(page, "done")).toHaveCount(0);
  await expect(agentDot(page, "idle")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/cleared.png` });

  await ctxB.close();
  await page.close();
});
