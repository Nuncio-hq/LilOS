import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { allowAll, allowAllWhile, expectSettled } from "./helpers/approvals";
import { electronScreenshot, ensureDesktopPayload } from "./helpers/electron";
import { wport } from "./ports";

/**
 * Issue #27 — desktop DM end to end. Each acceptance criterion is a named
 * test. The spec boots the real slice per leg: apps/relay + apps/harness
 * (engine-fake) + vite (apps/web dev; vite preview for the built app in AC-7;
 * Electron for AC-8). Ports are offset from the dev defaults so a local dev
 * stack can coexist.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
// --repeat-each spreads a file's repeats across worker processes; each boots
// the stack again, so ports are offset per worker or relays race one port (#84).

const webDir = path.join(repo, "apps", "web");
const desktopDir = path.join(repo, "apps", "desktop");

interface Stack {
  home: string;
  webUrl: string;
  relayWs: string;
  feedWs: string;
  relayToken: string;
  stop: () => Promise<void>;
}

async function waitForHttp(url: string, ms = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const ok = await fetch(url)
      .then((r) => r.ok || r.status === 404)
      .catch(() => false);
    if (ok) return;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function killProc(proc: ChildProcess): Promise<void> {
  // `bun run dev` stacks intermediate shim layers between `proc` and the
  // real dev-stack children, and bun doesn't forward signals through them —
  // signal the whole process group (the spawn is `detached`) or the stack
  // orphans and keeps its ports bound, poisoning the next boot (#84).
  const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      if (proc.pid) process.kill(-proc.pid, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {}
    }
  };
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      killGroup("SIGKILL");
      resolve();
    }, 8_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    killGroup("SIGTERM");
  });
}

/** Boot `bun run dev` (relay + harness + vite dev) on offset ports. */
async function bootStack(
  tag: string,
  ports: { relay: number; feed: number; web: number },
  extraEnv: Record<string, string> = {},
): Promise<Stack> {
  const home = mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const leakTag = engineTag(tag);
  const proc = spawn("bun", ["run", "dev"], {
    cwd: webDir,
    detached: true,
    env: {
      ...process.env,
      LILOS_HOME: home,
      LILOS_ENGINE_TAG: leakTag,
      LILOS_RELAY_PORT: String(ports.relay),
      LILOS_FEED_PORT: String(ports.feed),
      LILOS_WEB_PORT: String(ports.web),
      ...extraEnv,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    await waitForHttp(webUrl);
    // The page connects to relay + feed the moment it loads and only retries
    // post-handshake drops — wait for them to listen so a slow boot under
    // parallel load can't strand the client on "could not start".
    await waitForHttp(`http://127.0.0.1:${ports.relay}/`);
    await waitForHttp(`http://127.0.0.1:${ports.feed}/`);
    const tokenPath = path.join(home, "relay-token");
    let relayToken = "";
    // 30s headroom: under a full-suite run several stacks boot at once and
    // the relay can take >5s to write its token — an empty token surfaces as
    // a faraway "bad auth token", so fail here instead.
    for (let i = 0; i < 300 && !relayToken; i++) {
      try {
        relayToken = readFileSync(tokenPath, "utf8").trim();
      } catch {}
      if (!relayToken) await new Promise((r) => setTimeout(r, 100));
    }
    if (!relayToken)
      throw new Error(`relay token never appeared at ${tokenPath}`);
    return {
      home,
      webUrl,
      relayWs: `ws://127.0.0.1:${ports.relay}/ws`,
      feedWs: `ws://127.0.0.1:${ports.feed}/ws`,
      relayToken,
      stop: async () => {
        await killProc(proc);
        await expectNoEngineLeak(leakTag);
      },
    };
  } catch (e) {
    // Group kill: `bun run dev` spawns detached — killing only the shim
    // orphans stack.ts + relay + harness + vite and poisons the next boot.
    await killProc(proc);
    throw e;
  }
}

const SHOTS = path.join(repo, "test-results", "ac-27");

let stackA: Stack; // engine-fake advertising every capability (incl. steer)
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stackA = await bootStack(
    "main",
    {
      relay: wport(4643),
      feed: wport(4647),
      web: wport(5241),
    },
    // #118: the signed-in name is the OS user's — pin it so the approval
    // label assertions below stay deterministic on any machine.
    { LILOS_USER_NAME: "Oscar" },
  );
});
test.afterAll(async () => {
  await stackA?.stop();
});

test.describe.configure({ mode: "serial" });

/** Open the app, land on Default's DM (dismissing the first-run card). */
async function dmDefault(stack: Stack, page: Page) {
  await page.goto(`${stack.webUrl}/`);
  const aside = page.locator("aside");
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

const employeeIdFromUrl = (page: Page) =>
  decodeURIComponent(page.url().split("/dm/")[1].split("/")[0]);

test("AC-1 first run auto-hires the `default` engine profile", async ({
  page,
}) => {
  await page.goto(`${stackA.webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  // The hire affordance is wired (issue #115); first run hired `default`
  // without Oscar touching it.
  await expect(
    aside.getByRole("button", { name: "Hire employee" }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-first-employee.png` });
});

test("AC-2 sidebar shows Employees + status only (no channels/projects/tickets)", async ({
  page,
}) => {
  await page.goto(`${stackA.webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(aside.getByText("Employees")).toBeVisible();
  for (const label of ["Inbox", "Tickets", "Company", "Projects"])
    await expect(aside.getByText(label, { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-2-sidebar.png` });
});

test("AC-3 DM message opens a session; reply streams with reasoning + tool steps", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  await send(page, "Say hello then list files");
  // sendDm resolves messages.post then navigates to the conversation — the
  // URL change is the wire signal that the session exists, so a relay that's
  // slow under load can't race the first turn assert.
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 30_000 });
  // The new session's live turn streams into the thread as one AgentTurn,
  // with a reasoning block and collapsed tool steps.
  const turn = page.locator("[data-agentturn]").first();
  await expect(turn).toBeVisible({ timeout: 30_000 });
  await expect(turn.getByText(/Thinking…|Thought for \d+s/)).toBeVisible({
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
  await dmDefault(stackA, page);
  await send(page, "Add a release note to the readme");
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
  await dmDefault(stackA, page);
  // An edit-ask prompt holds the turn open on an approval — deterministic
  // running state for both legs.
  await send(page, "Add a release note to the readme");
  // Send the steer while the turn is parked on the approval — it is
  // provably running, so the steer lands inside it instead of racing
  // session creation and becoming a follow-up turn (which the fake's
  // scripts never echo back).
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Enter steers · ■ stop")).toBeVisible({
    timeout: 30_000,
  });
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
  await page.goto(`${stackA.webUrl}/dm/${employeeIdFromUrl(page)}`);
  await send(page, "Add a docs note about steering");
  await expect(page.getByText("Enter steers · ■ stop")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Stop" }).click();
  // Wait the turn-ended wire condition before asserting the footer chip
  // (turn.completed -> data-turnsettled), not a wall-clock guess (#257).
  const stopped = page.locator("[data-agentturn]").last();
  await expectSettled(stopped);
  await expect(stopped.getByText(/Stopped · session.interrupt/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-5-stopped.png` });
});

test("AC-5b without the `steer` capability, mid-turn typing queues", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stackB = await bootStack(
    "nosteer",
    { relay: wport(4653), feed: wport(4654), web: wport(5245) },
    { LILOS_HIDE_CAPS: "steer" },
  );
  try {
    await dmDefault(stackB, page);
    await send(page, "Add a release note to the readme");
    // The composer copy tells the truth: no steer → Enter queues.
    await expect(page.getByText("Enter queues · ■ stop")).toBeVisible({
      timeout: 30_000,
    });
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
  await dmDefault(stackA, page);
  await send(page, "Add a release note to the readme");
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
  await dmDefault(stackA, page);
  await send(page, "Add a release note to the readme");
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

  await page.getByRole("button", { name: "Stop" }).click();

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
  await dmDefault(stackA, page);
  await send(page, "Add a release note to the readme");
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
});

test("#315 AC-3/AC-4 without `steer`: a queued send runs next, Remove drops it", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const stackB = await bootStack(
    "nosteer-315",
    { relay: wport(4655), feed: wport(4656), web: wport(5247) },
    { LILOS_HIDE_CAPS: "steer" },
  );
  try {
    // Remove first: the queued send leaves the tray and never reaches the
    // conversation or the engine.
    await dmDefault(stackB, page);
    await send(page, "Add a release note to the readme");
    await expect(page.getByText("Enter queues · ■ stop")).toBeVisible({
      timeout: 30_000,
    });
    await send(page, "never mind that");
    const tray = page.locator("[data-queued]");
    await expect(tray).toHaveAttribute("data-queued-mode", "next");
    await expect(tray.getByText(/never mind that/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.locator("[data-userturn]", { hasText: /never mind/i }),
    ).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-315-waiting-next.png` });
    await page.locator('[data-queued-remove="0"]').click();
    await expect(page.locator("[data-queued]")).toHaveCount(0);
    const firstTurn = page.locator("[data-agentturn]").first();
    await allowAllWhile(page, expectSettled(firstTurn));
    // The removed message never became a turn or a bubble.
    await expect(page.locator("[data-agentturn]")).toHaveCount(1);
    await expect(
      page.locator("[data-userturn]", { hasText: /never mind/i }),
    ).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-315-removed.png` });

    // Queue-then-run: a second wait leaves the tray when the turn ends and
    // bubbles below the previous answer, its own turn under it.
    await send(page, "also mention bananas");
    await expect(tray.getByText(/also mention bananas/)).toBeVisible({
      timeout: 30_000,
    });
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

test("AC-6 two sessions run in parallel; the DM list shows each live phase", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(stackA, page);
  const empId = employeeIdFromUrl(page);
  // Edit-ask prompts hold each turn on an approval — both stay live long
  // enough to observe them running in parallel in the session list.
  await send(page, "Add a parallel-work note to the readme");
  // Let the send land (its navigation proves messages.post resolved) before
  // heading home — navigating early can abort the in-flight post.
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 30_000 });
  // Back to the DM home → second session → back home: both rows live.
  await page.goto(`${stackA.webUrl}/dm/${empId}`);
  await send(page, "Add a second note about parallel work");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 30_000 });
  await page.goto(`${stackA.webUrl}/dm/${empId}`);
  // A live session marks its row: a pulsing dot while it works, the `!`
  // needs-you chip while it waits on an approval (#224 badge design).
  const live = page.locator("[data-session]", {
    has: page.locator('.animate-pulse, [title="Needs you"]'),
  });
  await expect(live).toHaveCount(2, { timeout: 60_000 });
  // #71 AC-4: a turn parked on an approval reads `needs you`, a live phase.
  await expect(
    page
      .locator("[data-session]")
      .filter({ hasText: /working|thinking|replying|opening|needs you/ }),
  ).toHaveCount(2, { timeout: 60_000 });
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
  const port = wport(5246);
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
      },
      stdio: "inherit",
    },
  );
  try {
    await waitForHttp(`http://127.0.0.1:${port}`);
    await page.goto(`http://127.0.0.1:${port}/`);
    const aside = page.locator("aside");
    await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
      timeout: 30_000,
    });
    // Click every control on the surfaces a user can reach: sidebar buttons,
    // status entry, DM view buttons, session menus. A control that throws or
    // dead-ends fails the run via the page's console error listener.
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
        await page.waitForTimeout(60);
      }
    };
    await clickAll("aside");
    // Navigate into the DM. If the sweep left the first-run card up (its
    // buttons live outside aside), dismiss it with its own control.
    const dismissFirstRun = page.getByRole("button", { name: /Set up later/ });
    if (await dismissFirstRun.isVisible().catch(() => false)) {
      await dismissFirstRun.click({ timeout: 5_000 });
    }
    await aside
      .getByRole("button", { name: /default/i })
      .click({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/dm\//);
    await clickAll("main");
    // The app still works: the composer accepts a message.
    await send(page, "health check after control sweep");
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
  // Build the Electron payload (main + preload + status page), then launch
  // against stackA — the shell points its app window at the dev server.
  await ensureDesktopPayload(desktopDir);
  const portOf = (ws: string) => new URL(ws).port;
  const app = await _electron.launch({
    // Linux CI has no suid chrome-sandbox helper; disable it there only.
    args:
      process.platform === "linux"
        ? [desktopDir, "--no-sandbox"]
        : [desktopDir],
    env: {
      ...process.env,
      LILOS_RELAY_HOME: stackA.home,
      LILOS_RELAY_PORT: portOf(stackA.relayWs),
      LILOS_FEED_PORT: portOf(stackA.feedWs),
      LILOS_WEB_URL: stackA.webUrl,
    },
  });
  try {
    const win = await app.firstWindow();
    await expect(
      win.locator("aside").getByRole("button", { name: /default/i }),
    ).toBeVisible({ timeout: 60_000 });
    // Page.captureScreenshot intermittently fails on Electron under load
    // (CI: "Unable to capture screenshot") — wait for visible+painted and
    // retry. The assertion above already proved the AC; this is the evidence.
    await electronScreenshot(app, win, `${SHOTS}/ac-8-electron.png`);
  } finally {
    await app.close();
  }
});
