import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #103 — unsent drafts are kept per conversation. Each acceptance
 * criterion is a named test; legs run against the real slice (apps/relay +
 * apps/harness with engine-fake + apps/web dev) on offset ports.
 *
 * v3: the thread composer in the peek keeps the draft (one key per
 * conversation, `lilos:composer-draft:conv:<id>`) and so does the new-chat
 * box beside Threads (one key per agent, `dm:<id>`, the old home composer's):
 * AC-2 and AC-3 read both. AC-7 is dropped: the prototype's old default
 * screen is gone.
 * AC-6 archives from the thread header's ⋯ menu, which is what the pruning
 * listens to (the `conversation.updated` it broadcasts).
 *
 * Serial: later legs reuse the sessions created earlier. AC-5 kills the
 * relay child to force a send failure, so it runs last among real-app legs.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-103");
const DRAFT_PREFIX = "lilos:composer-draft:";

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("drafts", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const DEFAULT_AGENT = { id: "default", name: "Hermes" };

/* The thread's reply box in the peek. By textarea, not by placeholder: the
   placeholder follows the turn ("Message X…" idle, "Message X… it reads this…" mid-turn) and
   a draft is typed whatever the turn is doing. */
const threadComposer = (page: Page) =>
  v3Peek(page).locator("[data-thread-panel] textarea");
const newChatBox = (page: Page) =>
  v3Peek(page).getByPlaceholder("Message Hermes…");

/** Open a thread from its row on Threads (the page stays behind the peek).
    Earlier serial legs leave other threads, so match on the title text — the
    engine may re-case it ("session alpha" → "Session Alpha"). */
async function openFromList(page: Page, title: RegExp, convId: string) {
  await page.locator("main").getByRole("button", { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`open=thread:${convId}`));
  await expect(threadComposer(page)).toBeVisible({ timeout: 30_000 });
}

/** Start a chat with Default; resolves to its conversation id. */
async function chat(page: Page, text: string): Promise<string> {
  await skipFirstRun(page);
  return await startChat(page, stack.webUrl, DEFAULT_AGENT, text);
}

const draftKeys = (page: Page) =>
  page.evaluate(
    (prefix) =>
      Array.from({ length: localStorage.length }, (_, i) =>
        localStorage.key(i),
      ).filter((k): k is string => !!k?.startsWith(prefix)),
    DRAFT_PREFIX,
  );

test("AC-1 draft survives switching sessions; each thread keeps its own", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const convA = await chat(page, "session alpha");
  await threadComposer(page).fill("draft in alpha");

  // A second session's composer shows its own draft (empty until typed).
  const convB = await startChat(
    page,
    stack.webUrl,
    DEFAULT_AGENT,
    "session beta",
  );
  expect(convB).not.toBe(convA);
  await expect(threadComposer(page)).toHaveValue("");

  await threadComposer(page).fill("draft in beta");
  // The session rows live on Threads, beside the peek.
  await openFromList(page, /session alpha/i, convA);
  await expect(threadComposer(page)).toHaveValue("draft in alpha");
  await page.screenshot({ path: `${SHOTS}/ac-1-draft-restored.png` });
});

test("AC-2 the new-chat box keeps its own draft, separate from thread drafts", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const conv = await chat(page, "home draft");
  await threadComposer(page).fill("thread draft");

  // The new-chat box has its own key (`dm:<agent>`): it opens empty — the
  // thread's text does not leak into it — and keeps what is typed there.
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
  await expect(newChatBox(page)).toBeVisible({ timeout: 30_000 });
  await expect(newChatBox(page)).toHaveValue("");
  await newChatBox(page).fill("next top-level thought");

  // Both drafts hold their own key — reopening the thread restores its own…
  await page.goto(`${stack.webUrl}/#?page=threads&open=thread:${conv}`);
  await expect(threadComposer(page)).toHaveValue("thread draft", {
    timeout: 30_000,
  });
  // …and the new chat is as it was left.
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
  await expect(newChatBox(page)).toHaveValue("next top-level thought", {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-2-home-vs-thread.png` });
});

test("AC-3 switching employees keeps each employee's drafts", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const convDefault = await chat(page, "hello default");
  await threadComposer(page).fill("draft for default");

  // A second employee's thread starts empty and keeps its own text.
  const created = await relayRpc<{ employee: { id: string } }>(
    page,
    stack,
    "employees.create",
    { name: "Blanca" },
  );
  const convBlanca = await startChat(
    page,
    stack.webUrl,
    { id: created.employee.id, name: "Blanca" },
    "hello blanca",
  );
  await expect(threadComposer(page)).toHaveValue("");
  await threadComposer(page).fill("draft for blanca");

  // The new-chat box keeps one draft per employee: Default's text is not
  // Blanca's, and each is where it was left.
  const blancaBox = (p: Page) => v3Peek(p).getByPlaceholder("Message Blanca…");
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
  await expect(newChatBox(page)).toBeVisible({ timeout: 30_000 });
  await newChatBox(page).fill("new-chat draft for default");
  await page.goto(
    `${stack.webUrl}/#?page=threads&open=newchat:${created.employee.id}`,
  );
  await expect(blancaBox(page)).toBeVisible({ timeout: 30_000 });
  await expect(blancaBox(page)).toHaveValue("");
  await blancaBox(page).fill("new-chat draft for blanca");
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
  await expect(newChatBox(page)).toHaveValue("new-chat draft for default", {
    timeout: 30_000,
  });
  await page.goto(
    `${stack.webUrl}/#?page=threads&open=newchat:${created.employee.id}`,
  );
  await expect(blancaBox(page)).toHaveValue("new-chat draft for blanca", {
    timeout: 30_000,
  });

  // Back and forth across the two employees' threads: each text is where it
  // was left.
  await page.goto(`${stack.webUrl}/#?page=threads&open=thread:${convDefault}`);
  await expect(threadComposer(page)).toHaveValue("draft for default", {
    timeout: 30_000,
  });
  await page.goto(`${stack.webUrl}/#?page=threads&open=thread:${convBlanca}`);
  await expect(threadComposer(page)).toHaveValue("draft for blanca", {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-3-employee-drafts.png` });
});

test("AC-4 a draft survives a page reload", async ({ page }) => {
  test.setTimeout(120_000);
  await chat(page, "survives reload");
  await threadComposer(page).fill("still here after reload");
  await page.reload();
  await expect(threadComposer(page)).toHaveValue("still here after reload", {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-4-after-reload.png` });
});

test("AC-6 clearing text drops the draft; archive + remove prune theirs", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const convA = await chat(page, "session to archive");

  // Delete-all removes the stored draft (no empty entries pile up).
  await threadComposer(page).fill("wip");
  await threadComposer(page).fill("");
  await page.waitForTimeout(300);
  expect(await draftKeys(page)).toEqual([]);

  // Archiving a session drops its draft: archive it from the thread's own
  // menu; the pruning listens to the `conversation.updated` that broadcasts.
  await threadComposer(page).fill("draft to prune");
  expect((await draftKeys(page)).some((k) => k.endsWith(convA))).toBe(true);
  await page
    .locator("[data-thread-panel]")
    .getByRole("button", { name: "Thread actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Settle thread" }).click();
  await expect
    .poll(async () => (await draftKeys(page)).some((k) => k.endsWith(convA)), {
      timeout: 15_000,
    })
    .toBe(false);
  await page.screenshot({ path: `${SHOTS}/ac-6-pruned.png` });

  // Removing an employee drops its new-chat draft (`dm:<id>`) and the drafts
  // of its threads (channel.removed / employee.removed).
  const created = await relayRpc<{ employee: { id: string } }>(
    page,
    stack,
    "employees.create",
    { name: "Carmen" },
  );
  const carmenId = created.employee.id;
  const convC = await startChat(
    page,
    stack.webUrl,
    { id: carmenId, name: "Carmen" },
    "hello carmen",
  );
  await threadComposer(page).fill("carmen draft");
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:${carmenId}`);
  const carmenBox = v3Peek(page).getByPlaceholder("Message Carmen…");
  await expect(carmenBox).toBeVisible({ timeout: 30_000 });
  await carmenBox.fill("carmen home draft");
  const carmenKeys = async () =>
    (await draftKeys(page)).filter(
      (k) => k.endsWith(convC) || k.endsWith(`:${carmenId}`),
    );
  expect((await carmenKeys()).length).toBe(2);
  await relayRpc(page, stack, "employees.remove", { id: carmenId });
  await expect.poll(carmenKeys, { timeout: 15_000 }).toEqual([]);
});

test("AC-5 sending clears only that draft; a failed send keeps the text", async ({
  page,
}) => {
  test.setTimeout(150_000);
  // Two sessions, one draft each.
  const convA = await chat(page, "session one");
  await threadComposer(page).fill("alpha draft");
  await startChat(page, stack.webUrl, DEFAULT_AGENT, "session two");
  await threadComposer(page).fill("beta draft");

  // Send in B: B clears, A's draft untouched.
  await threadComposer(page).press("Enter");
  await expect(threadComposer(page)).toHaveValue("", { timeout: 30_000 });
  await openFromList(page, /session one/i, convA);
  await expect(threadComposer(page)).toHaveValue("alpha draft");

  // A failed send keeps the text: SIGKILL the relay so the client's socket
  // closes — the send rejects (`relay not connected`) and nothing can clear
  // the draft. Only a resolved send clears, so the text is safe either way.
  const pids = execSync(`lsof -ti tcp:${stack.ports.relay} -sTCP:LISTEN`)
    .toString()
    .trim();
  for (const pid of pids.split("\n").filter(Boolean))
    process.kill(Number(pid), "SIGKILL");
  await page.waitForTimeout(1_500); // let the browser's onclose land
  await threadComposer(page).press("Enter");
  await page.waitForTimeout(1_000);
  await expect(threadComposer(page)).toHaveValue("alpha draft");
  await page.screenshot({ path: `${SHOTS}/ac-5-failed-send-kept.png` });
});
