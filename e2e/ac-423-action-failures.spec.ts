import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  skipFirstRun,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #423 — a failed DM action says so instead of landing nowhere:
 *
 *   AC-1 every action that rejects shows a toast naming what failed in
 *      plain words — Stop, model pick, rename, archive/unarchive (a thread
 *      row's ⋯ menu on Threads, and the same menu in the thread's header),
 *      and the background-jobs list (which used to leave the tab quietly
 *      empty).
 *   AC-2 a failed history load shows a retryable notice in the thread —
 *      not silently missing messages.
 *   AC-3 the once-only model-catalog load survives failed `models.list`
 *      calls: a transient one is retried on its own, and while the host is
 *      fully gone the relay's hello-time `welcome.engineHost` cache still
 *      seeds the picker (#483's phone fix, same seam).
 *
 * Failures are forced at the wire: `page.routeWebSocket` proxies the app's
 * relay socket and answers chosen JSON-RPC methods with an error frame —
 * deterministic, no mid-test process kills. Screenshots (1288x900, light
 * and dark) land in test-results/ac-423/ for the CI artifact upload.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-423");

const TOAST = "[data-toast]";
const BANNER = "[data-status-banner]";
const PICKER = '[data-slot="model-picker-trigger"]';
const VIEW = { width: 1288, height: 900 };
/* The wire reason every injected rejection carries — raw relay jargon the
   toast must NOT show. What it shows instead is the plain-words mapping
   (LOST), so an assertion on the action prefix can never pass on a
   swallowed reason, and the jargon itself is asserted gone. */
const ERR = "the engine host is gone";
const LOST = "LilOS lost its connection to the agent";

let stack: Stack;
test.setTimeout(180_000);
test.beforeAll(async () => {
  stack = await bootStack("ac423", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });

interface RejectRule {
  match: (method: string, params: Record<string, unknown>) => boolean;
  message: string;
}

const method = (m: string, message = ERR): RejectRule => ({
  match: (name) => name === m,
  message,
});

/**
 * Route the page's relay socket through the spec: every request forwards
 * verbatim unless a rule matches — then it gets the error answer a dead
 * engine host produces. The rules list is mutable so a test can arm a
 * failure right before the action it wants to reject, and it lives in the
 * route's closure so it survives reloads on the same page.
 */
async function wireFailures(page: Page) {
  const rules: RejectRule[] = [];
  await page.routeWebSocket(
    new RegExp(`127\\.0\\.0\\.1:${stack.ports.relay}/`),
    (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((raw) => {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        let frame: {
          id?: unknown;
          method?: unknown;
          params?: Record<string, unknown>;
        };
        try {
          frame = JSON.parse(text);
        } catch {
          server.send(raw);
          return;
        }
        const rule =
          typeof frame.method === "string"
            ? rules.find((r) =>
                r.match(frame.method as string, frame.params ?? {}),
              )
            : undefined;
        if (!rule) {
          server.send(raw);
          return;
        }
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id ?? null,
            error: {
              code: -32000,
              message: rule.message,
              data: { code: "engine_unavailable" },
            },
          }),
        );
      });
      server.onMessage((msg) => ws.send(msg));
    },
  );
  return {
    reject: (...rs: RejectRule[]) => rules.push(...rs),
    heal: () => rules.splice(0),
  };
}

/* The seeded employee. An id that names nobody opens the new-chat draft on
   the default agent, which on this one-agent stack is Default. */
const DEFAULT_AGENT_ID = "default";
/* `statusPollMs=500` shortens the catalog-seed poll so the AC-3 reload leg
   doesn't wait the production 15s for the heartbeat-carried fallback. The
   query rides ahead of the hash, so it survives every reload. */
const APP = (): string => `${stack.webUrl}/?statusPollMs=500`;

/** The new-chat draft beside Threads — past first run. */
async function newChat(page: Page) {
  await skipFirstRun(page);
  await page.goto(`${APP()}#?page=threads&open=newchat:${DEFAULT_AGENT_ID}`);
  await expect(v3Peek(page).getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 30_000,
  });
}

/** Send from a new chat and open the new session as the session view (a
   widened thread): a send lands on the thread in the side peek (#577), so
   step in through its widen button. */
const openSession = async (page: Page, text: string) => {
  await newChat(page);
  await v3Peek(page)
    .getByPlaceholder(/^Message /)
    .fill(text);
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await panelIntoFocus(page);
};

/** The issue's screenshot shape: one PNG per theme at the spec's viewport. */
async function shot(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });
  }
}

test("AC-3 the model catalog survives failed models.list calls", async ({
  page,
}) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  /* (a) One transient failure: the old once-only load dropped it and the
     composer had no picker until a reload — now the loader re-asks on its
     own (hello-time seed and/or a retry). */
  let rejectsLeft = 1;
  fail.reject({
    match: (m) => m === "models.list" && rejectsLeft-- > 0,
    message: "engine host not ready",
  });
  await newChat(page);
  /* The draft's model picker is the engine's full picker, listing the same
     `models.list` catalog every thread's picker reads. It only renders once
     the app holds that catalog, so its presence is the proof. */
  await expect(v3Peek(page).locator(PICKER)).toBeVisible({ timeout: 30_000 });
  /* (b) The host fully gone for the app's fetches: every models.list
     rejects, yet the relay's host-status cache still seeds the picker —
     a hello that predates the first models-carrying report catches up on
     the next status poll (statusPollMs=500 above). */
  fail.heal();
  fail.reject(method("models.list"));
  await page.reload();
  await expect(v3Peek(page).locator(PICKER)).toBeVisible({ timeout: 30_000 });
  await shot(page, "ac3-catalog-seeded");
});

test("AC-2 a failed history load shows a retryable notice", async ({
  page,
}) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  await openSession(page, "history that must survive a reload");

  /* Reopen the thread with history broken: the fetch used to land nowhere
     and the thread just looked shorter. */
  fail.reject(method("messages.list"));
  await page.reload();
  const banner = page.locator(BANNER).first();
  await expect(banner).toContainText("Couldn't load this thread's history", {
    timeout: 30_000,
  });
  await expect(banner.getByRole("button", { name: "Retry" })).toBeVisible();
  await shot(page, "ac2-history-notice");

  /* Heal, then Retry: the same fetch runs again and the notice leaves. */
  fail.heal();
  await banner.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(BANNER)).toHaveCount(0, { timeout: 15_000 });
  await expect(
    page.getByText("history that must survive a reload").first(),
  ).toBeVisible({ timeout: 15_000 });

  /* The thread in the side peek (off the session view) carries the same
     notice — the AC says "in the thread", and both views render it. A
     reload forces the remount (no guaranteed refetch on narrowing). */
  fail.reject(method("messages.list"));
  await page.goto(page.url().replace(/&full=1(?=&|$)/, ""));
  await page.reload();
  await expect(page.locator(BANNER).first()).toContainText(
    "Couldn't load this thread's history",
    { timeout: 30_000 },
  );
});

test("AC-1 a failed Stop shows its reason", async ({ page }) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  /* `slow:` paces the turn so the Stop button stays up across the click. */
  await openSession(page, "slow:400 a turn to stop");
  const stop = page.getByRole("button", { name: "Stop (⌘.)" });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  fail.reject(method("turns.interrupt"));
  await stop.click();
  await expect(page.locator(TOAST)).toContainText("Couldn't stop the turn", {
    timeout: 15_000,
  });
  await expect(page.locator(TOAST)).toContainText(LOST);
  await expect(page.locator(TOAST)).not.toContainText("engine host");
  /* The review's geometry claim, pinned: the pill's bottom edge clears the
     composer's top, so it can never sit on the toolbar's controls. */
  const toastBox = await page.locator(TOAST).boundingBox();
  const composerBox = await page
    .locator("[data-composer]")
    .last()
    .boundingBox();
  expect(toastBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(
    composerBox!.y + 1,
  );
  await shot(page, "ac1-stop-toast");
});

test("AC-1 a failed model pick shows its reason", async ({ page }) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  await openSession(page, "a model to switch");
  const trigger = page.locator(PICKER).first();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  /* The trigger IS the searchable list now (#886) — no drill step. */
  fail.reject(method("conversations.setModel"));
  /* Searching expands every matching row regardless of provider groups. */
  await page.getByPlaceholder(/search models/i).fill("opus");
  await page.getByRole("option", { name: /opus/i }).first().click();
  await expect(page.locator(TOAST)).toContainText("Couldn't switch the model", {
    timeout: 15_000,
  });
  await expect(page.locator(TOAST)).toContainText(LOST);
  await shot(page, "ac1-model-toast");
});

/** A thread's row on the Threads page: the row is a button holding the
    title, so find it by the title it shows. */
const threadRow = (page: Page, title: string) =>
  page
    .locator("#v3-main")
    .locator('[role="button"]', { hasText: title })
    .first();

test("AC-1 failed rename, done and not done show their reasons", async ({
  page,
}) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  const TITLE = "a thread to rename and settle";
  await openSession(page, TITLE);
  /* Back to the page beside the list: the new thread is a row on Threads. */
  await page.goto(`${APP()}#?page=threads`);
  const row = threadRow(page, TITLE);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const menu = row.getByRole("button", { name: "Thread actions", exact: true });

  /* Rename — conversations.update {title}, in place on the row. */
  fail.reject({
    match: (m, p) => m === "conversations.update" && p.title !== undefined,
    message: ERR,
  });
  await row.hover();
  await menu.click();
  await page.getByRole("menuitem", { name: "Rename thread" }).click();
  const title = page.getByRole("textbox", { name: "Thread title" });
  await title.fill("a failed rename");
  await title.press("Enter");
  await expect(page.locator(TOAST)).toContainText(
    "Couldn't rename the thread",
    {
      timeout: 15_000,
    },
  );
  await expect(page.locator(TOAST)).toContainText(LOST);

  /* Done — its own method since D-#862, {settled: true}. */
  fail.heal();
  fail.reject({
    match: (m, p) => m === "conversations.settle" && p.settled === true,
    message: ERR,
  });
  await row.hover();
  await row
    .getByRole("button", { name: "Thread actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Done", exact: true }).click();
  await expect(page.locator(TOAST)).toContainText(
    "Couldn't mark the thread done",
    { timeout: 15_000 },
  );
  await expect(page.locator(TOAST)).toContainText(LOST);
  await shot(page, "ac1-done-toast");

  /* Not done — the row moves under the folded Done shelf first. */
  fail.heal();
  await row.hover();
  await row
    .getByRole("button", { name: "Thread actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Done", exact: true }).click();
  /* The sidebar renders the same fold — scope the shelf click to #v3-main. */
  await page.locator('#v3-main [data-fold="settled"] > button').click();
  const settledMenu = page
    .locator("[data-settled-list]")
    .getByRole("button", { name: "Thread actions", exact: true })
    .last();
  await expect(settledMenu).toBeAttached({ timeout: 15_000 });
  fail.reject({
    match: (m, p) => m === "conversations.settle" && p.settled === false,
    message: ERR,
  });
  await settledMenu.click();
  await page.getByRole("menuitem", { name: "Not done" }).click();
  await expect(page.locator(TOAST)).toContainText(
    "Couldn't bring the thread back",
    { timeout: 15_000 },
  );
  await expect(page.locator(TOAST)).toContainText(LOST);
});

test("AC-1 the thread's own header renames and marks done, and failures say so", async ({
  page,
}) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  await openSession(page, "a thread renamed from its header");
  const panel = page.locator("[data-thread-panel]");
  const menu = panel.getByRole("button", {
    name: "Thread actions",
    exact: true,
  });
  await expect(menu).toBeVisible({ timeout: 30_000 });

  /* A rename that fails toasts, and the title stays what it was. */
  fail.reject({
    match: (m, p) => m === "conversations.update" && p.title !== undefined,
    message: ERR,
  });
  await menu.click();
  await page.getByRole("menuitem", { name: "Rename thread" }).click();
  const input = panel.getByRole("textbox", { name: "Thread title" });
  await input.fill("renamed in the header");
  await input.press("Enter");
  await expect(page.locator(TOAST)).toContainText(
    "Couldn't rename the thread",
    {
      timeout: 15_000,
    },
  );
  await expect(page.locator(TOAST)).toContainText(LOST);

  /* Healed, the same rename lands in the header. */
  fail.heal();
  await menu.click();
  await page.getByRole("menuitem", { name: "Rename thread" }).click();
  await input.fill("renamed in the header");
  await input.press("Enter");
  await expect(panel.locator("[data-session-title]")).toHaveText(
    "renamed in the header",
    { timeout: 15_000 },
  );

  /* A failed done toasts too — `conversations.settle` since D-#862. */
  fail.reject({
    match: (m, p) => m === "conversations.settle" && p.settled === true,
    message: ERR,
  });
  await menu.click();
  await page.getByRole("menuitem", { name: "Done", exact: true }).click();
  await expect(page.locator(TOAST)).toContainText(
    "Couldn't mark the thread done",
    {
      timeout: 15_000,
    },
  );
  await expect(page.locator(TOAST)).toContainText(LOST);
});

test("AC-1 a failed background-jobs list shows its reason", async ({
  page,
}) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  await openSession(page, "a session whose jobs list fails");
  /* Arm, then remount: the jobs effect refires the moment the feed is
     synced, so the toast is fresh when the assertion starts polling. */
  fail.reject(method("jobs.list"));
  await page.reload();
  await expect(page.locator(TOAST)).toContainText(
    "Couldn't load background jobs",
    { timeout: 30_000 },
  );
  await expect(page.locator(TOAST)).toContainText(LOST);
});
