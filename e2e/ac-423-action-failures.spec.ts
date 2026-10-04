import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #423 — a failed DM action says so instead of landing nowhere:
 *
 *   AC-1 every action that rejects shows a toast naming what failed in
 *      plain words — Stop, model pick, rename, archive/unarchive, and the
 *      background-jobs list (which used to leave the tab quietly empty).
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

/** Open the app, land on Default's DM home (dismissing the first-run card).
    `statusPollMs=500` shortens the catalog-seed poll so the AC-3 reload leg
    doesn't wait the production 15s for the heartbeat-carried fallback. */
async function dmDefault(page: Page) {
  await page.goto(`${stack.webUrl}/?statusPollMs=500`);
  const aside = page.locator("aside").first();
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  const dmBtn = page.getByRole("button", {
    name: /open dm|set up later|message/i,
  });
  if (
    await dmBtn
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await dmBtn.first().click();
  } else {
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
}

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

/** Send from the DM home and land on the new session's Focus view. */
const openSession = async (page: Page, text: string) => {
  await send(page, text);
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/, { timeout: 30_000 });
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
  await dmDefault(page);
  await expect(page.locator(PICKER).first()).toBeVisible({ timeout: 30_000 });
  /* (b) The host fully gone for the app's fetches: every models.list
     rejects, yet the relay's host-status cache still seeds the picker —
     a hello that predates the first models-carrying report catches up on
     the next status poll (statusPollMs=500 above). */
  fail.heal();
  fail.reject(method("models.list"));
  await page.reload();
  await dmDefault(page);
  await expect(page.locator(PICKER).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "ac3-catalog-seeded");
});

test("AC-2 a failed history load shows a retryable notice", async ({
  page,
}) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  await dmDefault(page);
  await openSession(page, "history that must survive a reload");

  /* Reopen the thread with history broken: the fetch used to land nowhere
     and the thread just looked shorter. */
  fail.reject(method("messages.list"));
  await page.reload();
  const banner = page.locator(BANNER).first();
  await expect(banner).toContainText("Couldn't load this session's history", {
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

  /* The panel thread (off /focus) carries the same notice — the AC says
     "in the thread", and dm.tsx renders it on both views. A reload forces
     the remount (focus→panel is a nested route, no guaranteed refetch). */
  fail.reject(method("messages.list"));
  await page.goto(page.url().replace(/\/focus$/, ""));
  await page.reload();
  await expect(page.locator(BANNER).first()).toContainText(
    "Couldn't load this session's history",
    { timeout: 30_000 },
  );
});

test("AC-1 a failed Stop shows its reason", async ({ page }) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  await dmDefault(page);
  /* `slow:` paces the turn so the Stop button stays up across the click. */
  await openSession(page, "slow:400 a turn to stop");
  const stop = page.getByRole("button", { name: "Stop (Esc)" });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  fail.reject(method("turns.interrupt"));
  await stop.click();
  await expect(page.locator(TOAST)).toContainText("Couldn't stop the turn", {
    timeout: 15_000,
  });
  await expect(page.locator(TOAST)).toContainText(LOST);
  await expect(page.locator(TOAST)).not.toContainText("engine host");
  await shot(page, "ac1-stop-toast");
});

test("AC-1 a failed model pick shows its reason", async ({ page }) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  await dmDefault(page);
  await openSession(page, "a model to switch");
  const trigger = page.locator(PICKER).first();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  /* Drill into the model list — its row carries the trailing "Model" tag. */
  await page
    .locator('[aria-label="Model and reasoning"]')
    .getByRole("button", { name: /Model$/ })
    .click();
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

test("AC-1 failed rename, archive and unarchive show their reasons", async ({
  page,
}) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  await dmDefault(page);
  await openSession(page, "a session to rename and archive");
  /* Back on the DM home the new session is the last row's menu. */
  const home = page.url().match(/\/dm\/[^/]+/)?.[0] ?? "/dm/default";
  await page.goto(`${stack.webUrl}${home}`);
  const menu = page.getByRole("button", { name: "Session actions" }).last();
  await expect(menu).toBeVisible({ timeout: 15_000 });

  /* Rename — conversations.update {title}. */
  fail.reject({
    match: (m, p) => m === "conversations.update" && p.title !== undefined,
    message: ERR,
  });
  await menu.click();
  await page.getByRole("menuitem", { name: "Rename session" }).click();
  const title = page.getByRole("textbox", { name: "Session title" });
  await title.fill("a failed rename");
  await title.press("Enter");
  await expect(page.locator(TOAST)).toContainText(
    "Couldn't rename the session",
    { timeout: 15_000 },
  );

  /* Archive — same method, {archived} instead. */
  fail.heal();
  fail.reject({
    match: (m, p) => m === "conversations.update" && p.archived !== undefined,
    message: ERR,
  });
  await menu.click();
  await page.getByRole("menuitem", { name: "Archive session" }).click();
  await expect(page.locator(TOAST)).toContainText(
    "Couldn't archive the session",
    { timeout: 15_000 },
  );
  await shot(page, "ac1-archive-toast");

  /* Unarchive — the row moves under the collapsed Archived section first. */
  fail.heal();
  await menu.click();
  await page.getByRole("menuitem", { name: "Archive session" }).click();
  await page.getByRole("button", { name: /Archived \(\d+\)/ }).click();
  const archivedMenu = page
    .locator("[data-archived]")
    .getByRole("button", { name: "Session actions" })
    .last();
  await expect(archivedMenu).toBeVisible({ timeout: 15_000 });
  fail.reject({
    match: (m, p) => m === "conversations.update" && p.archived !== undefined,
    message: ERR,
  });
  await archivedMenu.click();
  await page.getByRole("menuitem", { name: "Unarchive session" }).click();
  await expect(page.locator(TOAST)).toContainText(
    "Couldn't unarchive the session",
    { timeout: 15_000 },
  );
});

test("AC-1 a failed background-jobs list shows its reason", async ({
  page,
}) => {
  await page.setViewportSize(VIEW);
  const fail = await wireFailures(page);
  await dmDefault(page);
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
