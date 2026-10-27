import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect, type Page, test } from "@playwright/test";
import { allowAll, allowAllWhile, expectSettled } from "./helpers/approvals";
import {
  electronSafeEnv,
  electronScreenshot,
  ensureDesktopPayload,
} from "./helpers/electron";
import {
  bootStack,
  freePort,
  panelIntoFocus,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  v3Peek,
  v3Sidebar,
  waitForHttp,
} from "./helpers/stack";

/**
 * Issue #27 — desktop DM end to end. Each acceptance criterion is a named
 * test. The spec boots the real slice per leg: apps/relay + apps/harness
 * (engine-fake) + vite (apps/web dev; vite preview for the built app in AC-7;
 * Electron for AC-8). Ports are offset from the dev defaults so a local dev
 * stack can coexist.
 *
 * v3: a DM is a chat started from the new-chat draft beside Threads, and its
 * thread opens in the side peek (`#?page=threads&open=thread:<id>`); the
 * session view is that peek widened (`full=1`). The old "DM list shows each
 * live phase" is the Threads board's cards, whose pill carries the phase.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
// --repeat-each spreads a file's repeats across worker processes; each boots
// the stack again, so ports are offset per worker or relays race one port (#84).

const webDir = path.join(repo, "apps", "web");
const desktopDir = path.join(repo, "apps", "desktop");

const SHOTS = path.join(repo, "test-results", "ac-27");

let stackA: Stack; // engine-fake advertising every capability (incl. steer)
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stackA = await bootStack(
    "main",
    await pickPorts(),
    // #118: the signed-in name is the OS user's — pin it so the approval
    // label assertions below stay deterministic on any machine.
    { LILOS_USER_NAME: "Oscar" },
  );
});
test.afterAll(async () => {
  await stackA?.stop();
});

test.describe.configure({ mode: "serial" });

const DEFAULT_AGENT = { id: "default", name: "Default" };

/** A new chat with Default, past first run; resolves once its thread is open
    in the peek. */
async function chatDefault(stack: Stack, page: Page, text: string) {
  await skipFirstRun(page);
  return await startChat(page, stack.webUrl, DEFAULT_AGENT, text);
}

/** The thread composer in the peek (the new-chat draft's box is another
    textarea, gone once the chat started). */
const threadBox = (page: Page) =>
  v3Peek(page).locator("[data-thread-panel] textarea");

const send = async (page: Page, text: string) => {
  const box = threadBox(page);
  await box.fill(text);
  await box.press("Enter");
};

/** ■ — named by its exact label: a "stopped" thread card on the page behind
    the peek also matches /stop/i. */
const stopButton = (page: Page) =>
  v3Peek(page).getByRole("button", { name: /^stop \(⌘\.\)$/i });

test("AC-1 first run auto-hires the `default` engine profile", async ({
  page,
}) => {
  await skipFirstRun(page);
  await page.goto(`${stackA.webUrl}/`);
  const sidebar = v3Sidebar(page);
  await expect(sidebar.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  // The hire affordance is wired (issue #115); first run hired `default`
  // without Oscar touching it.
  await expect(
    sidebar.getByRole("button", { name: "Hire an agent" }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-first-employee.png` });
});

test("AC-2 sidebar shows People + status only (no channels/projects/tickets)", async ({
  page,
}) => {
  await skipFirstRun(page);
  await page.goto(`${stackA.webUrl}/`);
  const sidebar = v3Sidebar(page);
  await expect(sidebar.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(sidebar.getByText("People")).toBeVisible();
  /* Work and Goals show with tickets (D-#776). Inbox stays hidden until it
     has updates. Projects' heading always shows — its ＋ is the way in
     (#854) — but with none yet it lists no row. */
  for (const label of ["Work", "Goals"])
    await expect(sidebar.getByText(label, { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Inbox", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByText("Projects", { exact: true })).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "New project from a folder" }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-2-sidebar.png` });
});

test("AC-3 DM message opens a session; reply streams with reasoning + tool steps", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The draft's Send resolves conversations.open then swaps itself for the
  // thread — the URL change is the wire signal that the session exists, so a
  // relay that's slow under load can't race the first turn assert.
  await chatDefault(stackA, page, "Say hello then list files");
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  // The new session's live turn streams into the thread as one AgentTurn,
  // with a reasoning block and collapsed tool steps.
  const turn = page.locator("[data-agentturn]").first();
  await expect(turn).toBeVisible({ timeout: 30_000 });
  /* The work fold's one line says "thought for Ns" and its open body
     repeats it as "Thought for Ns" — either one proves the reasoning ran. */
  await expect(
    turn.getByText(/Thinking…|[Tt]hought for \d+s/).first(),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(turn.locator("[data-tasksteps]")).toBeVisible({
    timeout: 60_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-3-streaming.png` });
  // …and the reply completes with text + recorded tool steps.
  await expect(turn).toContainText(/envelope|file|Done|answer/i, {
    timeout: 60_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-3-done.png` });
});

test("AC-4 approval card answers the engine; the turn continues", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await chatDefault(stackA, page, "Add a release note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-4-approval-open.png` });
  await allowAll(page);
  // The answered card stays visible with its outcome label.
  await expect(page.getByText("Allowed once by Oscar").first()).toBeVisible({
    timeout: 15_000,
  });
  // The gated step ran and the turn completed.
  await expect(page.locator("[data-agentturn]").last()).toContainText(
    /Done on|Review it/,
    { timeout: 60_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac-4-approval-answered.png` });
});

test("AC-5 typing mid-turn steers (capability `steer`); stop interrupts", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // An edit-ask prompt holds the turn open on an approval — deterministic
  // running state for both legs.
  await chatDefault(stackA, page, "Add a release note to the readme");
  // Send the steer while the turn is parked on the approval — it is
  // provably running, so the steer lands inside it instead of racing
  // session creation and becoming a follow-up turn (which the fake's
  // scripts never echo back).
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  // The turn is running and steerable: Stop (⌘.) is on the composer (the
  // old "Enter steers" hint is gone, #886 — the steer itself is asserted
  // below by the chip that lands inside the turn).
  await expect(stopButton(page)).toBeVisible({ timeout: 30_000 });
  await send(page, "also mention bananas");
  // Keep answering while the steered turn finishes — an approval the wait
  // would out-sleep can't park it (#298).
  const steered = page.locator("[data-agentturn]").last();
  await allowAllWhile(page, expectSettled(steered));
  // The steer lands inside the turn it interrupted (turn.steered chip).
  await expect(steered).toContainText(/bananas/i, { timeout: 30_000 });
  await expect(steered).toContainText(/Done on|Review it/, {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-5-steer.png` });

  // Stop: new conversation, then ■ while the turn runs.
  await startChat(
    page,
    stackA.webUrl,
    DEFAULT_AGENT,
    "Add a docs note about steering",
  );
  await expect(stopButton(page)).toBeVisible({ timeout: 30_000 });
  await stopButton(page).click();
  // Wait the turn-ended wire condition before asserting the footer chip
  // (turn.completed -> data-turnsettled), not a wall-clock guess (#257).
  const stopped = page.locator("[data-agentturn]").last();
  await expectSettled(stopped);
  await expect(stopped.getByText(/Stopped/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-5-stopped.png` });
});

test("AC-5b without the `steer` capability, mid-turn typing queues", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stackB = await bootStack("nosteer", await pickPorts(), {
    LILOS_HIDE_CAPS: "steer",
  });
  try {
    await chatDefault(stackB, page, "Add a release note to the readme");
    // Running, with no steer capability: the mid-turn message below queues
    // (the "Enter queues" hint is gone, #886; the tray asserts it).
    await expect(stopButton(page)).toBeVisible({ timeout: 30_000 });
    await send(page, "also mention bananas");
    await expect(page.getByText("Approval needed").first()).toBeVisible({
      timeout: 60_000,
    });
    // The queued turn can ask again — keep answering until IT settles
    // (#298 AC-1).
    const queued = page.locator("[data-agentturn]").nth(1);
    await allowAllWhile(page, expectSettled(queued));
    // The queued message still runs — as the next turn in the same thread.
    await expect(page.locator("[data-agentturn]")).toHaveCount(2);
    await expect(queued).toContainText(/bananas/i, { timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/ac-5b-queue.png` });
  } finally {
    await stackB.stop();
  }
});

test("#315 AC-1/AC-2 a mid-turn send waits in the tray, then lands once inside the turn", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await chatDefault(stackA, page, "Add a release note to the readme");
  // The turn is parked on its approval — provably running, so the next send
  // is accepted as a steer but can't land until a step boundary.
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  await send(page, "also mention bananas");
  // It waits in the tray above the composer — never as a bubble.
  const tray = page.locator("[data-queued]");
  await expect(tray).toBeVisible({ timeout: 30_000 });
  await expect(tray).toHaveAttribute("data-queued-mode", "steer");
  await expect(tray).toContainText(/also mention bananas/);
  await expect(
    page.locator("[data-userturn]", { hasText: /bananas/i }),
  ).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-315-waiting-steer.png` });

  // Once the approval resolves the steer lands at the next boundary: the
  // tray empties and the message shows exactly once — as "Oscar steered …"
  // inside the turn, with no separate bubble for it.
  const steered = page.locator("[data-agentturn]").last();
  await allowAllWhile(page, expectSettled(steered));
  await expect(page.locator("[data-queued]")).toHaveCount(0);
  await expect(
    steered.locator('[data-steerstate="landed"]', { hasText: /bananas/i }),
  ).toHaveCount(1);
  await expect(
    page.locator("[data-userturn]", { hasText: /bananas/i }),
  ).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-315-steered-once.png` });
});

test("#315 AC-5 Stop parks waiting sends in the not-sent tray; Send runs it later", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await chatDefault(stackA, page, "Add a release note to the readme");
  /* #577: a send lands on the thread in the peek — the queued-send tray and
     the data-userturn markers this AC reads live in the session view. */
  await panelIntoFocus(page);
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  await send(page, "first nudge");
  const tray = page.locator("[data-queued]");
  // Wait for each item to land in the tray before sending the next — a
  // send that outpaces the in-flight post can be swallowed by the composer.
  await expect(tray.getByText(/first nudge/)).toBeVisible({ timeout: 30_000 });
  await send(page, "second nudge");
  await expect(tray.getByText(/second nudge/)).toBeVisible();

  await stopButton(page).click();

  // Everything still waiting parks: nothing auto-runs after a stop.
  const parked = page.locator("[data-notsent]");
  await expect(parked).toBeVisible({ timeout: 30_000 });
  await expect(parked).toContainText(/2 not sent/);
  await expect(parked.getByText(/first nudge/)).toBeVisible();
  await expect(parked.getByText(/second nudge/)).toBeVisible();
  await expect(page.locator("[data-queued]")).toHaveCount(0);
  await expect(
    page.locator("[data-userturn]", { hasText: /nudge/i }),
  ).toHaveCount(0);
  // No new turn appeared on its own.
  await expect(page.locator("[data-agentturn]")).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/ac-315-not-sent.png` });

  /* AC-6: the not-sent tray is relay state too — a reload (the hash keeps
     the session view open) shows the same parked sends, in order, ready to
     Send. */
  await page.reload();
  const reparked = page.locator("[data-notsent]");
  await expect(reparked.getByText(/first nudge/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(reparked.locator("li").nth(0)).toContainText(/first nudge/);
  await expect(reparked.locator("li").nth(1)).toContainText(/second nudge/);
  await page.screenshot({ path: `${SHOTS}/ac-315-not-sent-reload.png` });

  // Send runs the first parked item as a normal prompt — bubble + new turn.
  await page.locator('[data-notsent-send="0"]').click();
  const resent = page.locator("[data-agentturn]").nth(1);
  await allowAllWhile(page, expectSettled(resent));
  await expect(
    page.locator("[data-userturn]", { hasText: /first nudge/i }),
  ).toHaveCount(1);
  await expect(parked.getByText(/first nudge/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-315-not-sent-sent.png` });
});

test("#315 AC-6 a reload keeps the waiting tray and its order", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await chatDefault(stackA, page, "Add a release note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  await send(page, "first in line");
  const tray = page.locator("[data-queued]");
  await expect(tray.getByText(/first in line/)).toBeVisible({
    timeout: 30_000,
  });
  await send(page, "second in line");
  await expect(tray.getByText(/second in line/)).toBeVisible({
    timeout: 30_000,
  });
  await page.reload();
  // The tray is relay truth, not component state — same items, same order.
  const reloaded = page.locator("[data-queued]");
  await expect(reloaded.getByText(/second in line/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(reloaded.locator("li").nth(0)).toContainText(/first in line/);
  await expect(reloaded.locator("li").nth(1)).toContainText(/second in line/);
  await page.screenshot({ path: `${SHOTS}/ac-315-reload.png` });
  // Leave shared stackA clean for AC-6's parallel-sessions count — land the
  // waiting steers and let the turn settle instead of abandoning it live.
  await allowAllWhile(
    page,
    expectSettled(page.locator("[data-agentturn]").last()),
  );
});

test("#315 AC-3/AC-4 without `steer`: a queued send runs next, Remove drops it", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const stackB = await bootStack("nosteer-315", await pickPorts(), {
    LILOS_HIDE_CAPS: "steer",
    /* #459: hold the conversation bind well past the seq1→seq2 send gap —
       the window the loaded run measured (~910ms seq→`surface session
       created`) was about as long as the UI takes to post the next send.
       3s puts BOTH sends pre-bind (the `early` path the flake hit), and the
       `release note` guard below proves the hold is really open. */
    LILOS_BIND_DELAY_MS: "3000",
  });
  try {
    // Remove first: the queued send leaves the tray and never reaches the
    // conversation or the engine.
    await chatDefault(stackB, page, "Add a release note to the readme");
    await expect(stopButton(page)).toBeVisible({ timeout: 30_000 });
    /* #577: sends land on the thread in the peek — data-userturn markers
       exist only on the session view this AC asserts against. */
    await panelIntoFocus(page);
    await send(page, "never mind that");
    const tray = page.locator("[data-queued]");
    await expect(tray).toHaveAttribute("data-queued-mode", "next");
    await expect(tray.getByText(/never mind that/)).toBeVisible({
      timeout: 30_000,
    });
    /* #459 guard: the bind hold is really open — seq1's own send is still
       an unclaimed tray row (a bind that outran the hold would have claimed
       it into the first turn and hidden it). The window this test means to
       exercise can't silently shrink to nothing. */
    await expect(tray.getByText(/release note/i)).toBeVisible();
    await expect(
      page.locator("[data-userturn]", { hasText: /never mind/i }),
    ).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-315-waiting-next.png` });
    /* Remove by row, not index: a send that lands pre-bind renders queued
       too, and index 0 may be that straggler (#459). */
    await tray
      .locator("li", { hasText: /never mind that/ })
      .locator("[data-queued-remove]")
      .click();
    await expect(page.locator("[data-queued]")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-315-removed.png` });

    /* Edit moves a waiting send back into the composer (text returns, the
       row is removed) — AC-4. Must run while the first turn is still parked
       on its approval, or the "queued" send is really a fresh prompt that
       only flashes through the tray. */
    await send(page, "bananas are yellow");
    await expect(tray.getByText(/bananas are yellow/)).toBeVisible({
      timeout: 30_000,
    });
    await tray
      .locator("li", { hasText: /bananas are yellow/ })
      .locator("[data-queued-edit]")
      .click();
    await expect(page.locator("[data-queued]")).toHaveCount(0);
    const box = threadBox(page);
    await expect(box).toHaveValue(/bananas are yellow/);
    await box.fill("also mention bananas");
    await box.press("Enter");
    // The edited send queues again behind the same parked turn.
    await expect(tray.getByText(/also mention bananas/)).toBeVisible({
      timeout: 30_000,
    });

    const firstTurn = page.locator("[data-agentturn]").first();
    await allowAllWhile(page, expectSettled(firstTurn));
    // The removed message never became a turn or a bubble.
    await expect(
      page.locator("[data-userturn]", { hasText: /never mind/i }),
    ).toHaveCount(0);
    // Queue-then-run: a second wait leaves the tray when the turn ends and
    // bubbles below the previous answer, its own turn under it.
    const queuedTurn = page.locator("[data-agentturn]").nth(1);
    await allowAllWhile(page, expectSettled(queuedTurn));
    await expect(page.locator("[data-queued]")).toHaveCount(0);
    await expect(page.locator("[data-agentturn]")).toHaveCount(2);
    await expect(
      page.locator("[data-userturn]", { hasText: /bananas/i }),
    ).toHaveCount(1);
    await expect(queuedTurn).toContainText(/bananas/i, { timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/ac-315-queued-bubble.png` });
  } finally {
    await stackB.stop();
  }
});

test("AC-6 two sessions run in parallel; Threads shows each live phase", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Edit-ask prompts hold each turn on an approval — both stay live long
  // enough to observe them running in parallel on the Threads board. Each
  // chat's start (the draft swapping for its thread) proves messages.post
  // resolved before the next page change can abort it.
  await chatDefault(stackA, page, "Add a parallel-work note to the readme");
  await startChat(
    page,
    stackA.webUrl,
    DEFAULT_AGENT,
    "Add a second note about parallel work",
  );
  await page.goto(`${stackA.webUrl}/#?page=threads`);
  await expect(v3Peek(page)).toHaveCount(0);
  /* A live thread's row carries its phase signal: the status dot while it
     runs, the Needs-you pill while it waits on an approval (#224 badge
     design, #71 AC-4). Running threads sit folded under Working (#862) —
     open that shelf first. */
  const workingFold = page.locator(
    '#v3-main [data-fold="working"] > button[aria-expanded="false"]',
  );
  if (await workingFold.count()) await workingFold.click();
  const live = page.locator(
    '#v3-main [data-thread-row]:has([data-v3-status="working"]), ' +
      '#v3-main [data-thread-row]:has([data-v3-status="needs"])',
  );
  await expect(live).toHaveCount(2, { timeout: 60_000 });
  // The Working shelf titles the count (the sidebar's Threads row carries
  // none any more, #886).
  await expect(
    page.locator('#v3-main [data-fold="working"] > button'),
  ).toContainText(/Working \(\d+\)/);
  await expect(
    v3Sidebar(page).getByRole("button", { name: "Threads", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-6-parallel.png` });
});

test("AC-7 real-app build: every visible control has a working handler", async ({
  page,
}) => {
  test.setTimeout(300_000);
  // vite build + preview — the shipped bundle, not the dev server. Build
  // into a per-run tmpdir: parallel workers sharing apps/web/dist race each
  // other's emptyDir (ENOTEMPTY under --repeat-each/--workers).
  const outDir = mkdtempSync(path.join(tmpdir(), "lilos-e2e-dist-"));
  const vite = path.join(webDir, "node_modules", ".bin", "vite");
  const build = spawn(vite, ["build", "--outDir", outDir], {
    cwd: webDir,
    env: { ...process.env },
    stdio: "inherit",
  });
  await new Promise<void>((resolve, reject) => {
    build.once("exit", (c) =>
      c === 0 ? resolve() : reject(new Error(`vite build exit ${c}`)),
    );
  });
  const port = await freePort();
  const preview = spawn(
    vite,
    [
      "preview",
      "--outDir",
      outDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: webDir,
      env: {
        ...process.env,
        LILOS_RELAY_WS: stackA.relayWs,
        LILOS_RELAY_TOKEN: stackA.relayToken,
        LILOS_ENGINE_WS: stackA.feedWs,
        LILOS_WEB_PORT: String(port),
        // D-#836: the sweep clicks the sidebar's agent row — company layer.
        LILOS_COMPANY: "1",
      },
      stdio: "inherit",
    },
  );
  try {
    await waitForHttp(`http://127.0.0.1:${port}`);
    await skipFirstRun(page);
    await page.goto(`http://127.0.0.1:${port}/`);
    const sidebar = v3Sidebar(page);
    await expect(sidebar.getByRole("button", { name: /default/i })).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    // Click every control on the surfaces a user can reach: sidebar buttons,
    // the page, the opened person. A control that throws or dead-ends fails
    // the run via the page's console error listener.
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const clickAll = async (scope: string) => {
      const buttons = page.locator(`${scope} button:visible`);
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        const b = buttons.nth(i);
        if (!(await b.isVisible().catch(() => false))) continue;
        // Bounded click: a modal that swallowed an earlier Escape must not
        // stall the whole sweep on actionability.
        await b.click({ timeout: 2_000 }).catch(() => {});
        // Close whatever opened (dialog/menu) — Escape, then a backdrop
        // click as fallback for non-modal overlays.
        await page.keyboard.press("Escape");
        const dialog = page.getByRole("dialog");
        if (await dialog.isVisible().catch(() => false)) {
          await page.mouse.click(5, 5);
          await page.keyboard.press("Escape");
        }
        // The sidebar's own "Hide sidebar" is one of the controls swept: it
        // hides the sidebar (inert, so every control after it would be
        // skipped and the Default row unreachable). The top bar's toggle
        // docks it again and the sweep carries on through the rest.
        const dock = page
          .locator("[data-v3-topbar]")
          .getByRole("button", { name: "Show sidebar" });
        if (await dock.isVisible().catch(() => false)) await dock.click();
        await page.waitForTimeout(60);
      }
    };
    await clickAll("aside:not([aria-label])");
    // Open Default (the sweep may have left any page up) and sweep what it
    // shows: a sidebar pick is a jump — the person IS the page now (D-#769).
    await sidebar
      .getByRole("button", { name: /default/i })
      .click({ timeout: 10_000 });
    await expect(page).toHaveURL(/[#?&]page=agent&id=/);
    await clickAll("main");
    await clickAll('aside[aria-label="Opened record"]');
    // The app still works: a new chat accepts a message and the agent
    // answers it. (The sweep's clicks moved the hash around, so start from
    // the new-chat route itself.)
    await startChat(
      page,
      `http://127.0.0.1:${port}`,
      DEFAULT_AGENT,
      "health check after control sweep",
    );
    await expect(page.locator("[data-agentturn]").first()).toBeVisible({
      timeout: 60_000,
    });
    expect(errors.filter((e) => !e.includes("favicon"))).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/ac-7-controls.png` });
  } finally {
    preview.kill("SIGKILL");
  }
});

test("AC-8 `_electron` shell renders the same DM app", async () => {
  test.setTimeout(180_000);
  // D-#3: the desktop shell is Electron so Playwright can drive it like the
  // web tab (same Chromium) — the parity this test proves.
  // Build the Electron payload (main + preload + status page), then launch
  // against stackA — the shell points its app window at the dev server.
  await ensureDesktopPayload(desktopDir);
  const portOf = (ws: string) => new URL(ws).port;
  /* A scratch state dir: the window's localStorage (the first-run flag) must
     not be this Mac's real LilOS profile — a fresh one starts on Welcome, and
     "Set up later" is that screen's own exit into the app. */
  const stateDir = mkdtempSync(path.join(tmpdir(), "lilos-ac27-"));
  const app = await _electron.launch({
    // Linux CI has no suid chrome-sandbox helper; disable it there only.
    args:
      process.platform === "linux"
        ? [desktopDir, "--no-sandbox"]
        : [desktopDir],
    env: {
      ...electronSafeEnv(),
      LILOS_RELAY_HOME: stackA.home,
      LILOS_RELAY_PORT: portOf(stackA.relayWs),
      LILOS_FEED_PORT: portOf(stackA.feedWs),
      /* D-#836: `?company=1` rides the URL (the env knob's config endpoint is
         the web server's; the desktop window's config is the preload's). */
      LILOS_WEB_URL: `${stackA.webUrl}/?company=1`,
      LILOS_STATE_DIR: stateDir,
      // #875: the folder-access step isn't this test's subject — skip the
      // OS ask the way a granted install would.
      LILOS_SKIP_FOLDER_ASK: "1",
    },
  });
  try {
    const win = await app.firstWindow();
    await win.getByRole("button", { name: "Set up later" }).click({
      timeout: 60_000,
    });
    await expect(
      v3Sidebar(win).getByRole("button", { name: /default/i }),
    ).toBeVisible({ timeout: 60_000 });
    // Page.captureScreenshot intermittently fails on Electron under load
    // (CI: "Unable to capture screenshot") — wait for visible+painted and
    // retry. The assertion above already proved the AC; this is the evidence.
    await electronScreenshot(app, win, `${SHOTS}/ac-8-electron.png`);
  } finally {
    await app.close();
  }
});
