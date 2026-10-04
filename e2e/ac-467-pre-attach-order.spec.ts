import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { allowAllWhile, expectSettled } from "./helpers/approvals";
import { bootStack, type Stack } from "./helpers/stack";
import { wport } from "./ports";

/**
 * Issue #467 — post-reload, the thread must never paint the unanchored frame:
 * raw relay replies rendering employee posts below newer user rows while the
 * session feed is still replaying (mergeTurns has no anchor yet — the inverse
 * of the #308 invariant once the model binds).
 *
 * The window can't be caught by polling the DOM — it lasts a few frames — so
 * the spec records EVERY committed `[data-thread]` frame through a reload via
 * a MutationObserver installed by addInitScript (it survives navigation and
 * starts before the app's own scripts). Asserting over the recorded frames is
 * stronger than sampling: the unanchored frame cannot slip between polls.
 *
 * `slowleg:` keeps an engine leg running across the reload (#432 pacing) so
 * the pre-attach window carries live feed traffic, not just a static log.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-467");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  stack = await bootStack(
    "preattach",
    { relay: wport(5348), feed: wport(5349), web: wport(5342) },
    {
      LILOS_USER_NAME: "Oscar",
      /* Same shape as ac-308: no steer → mid-run sends queue and drain as
         ref'd turns, which is what puts relay posts AFTER later user rows. */
      LILOS_HIDE_CAPS: "steer",
      ENGINE_FAKE_TICK: "300",
    },
  );
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });

/* Records every committed `[data-thread]` frame (+ whether the transcript
   note was shown) into window.__lilosFrames — installed before the app's own
   scripts on every navigation, so the reload's pre-attach window is captured
   regardless of how many frames it lasts. */
const FRAME_RECORDER = `(() => {
  const w = window;
  w.__lilosFrames = [];
  try {
    const record = () => {
      const t = document.querySelector("[data-thread]");
      if (!t) return;
      const text = t.textContent ?? "";
      const note = !!document.querySelector("[data-transcript-note]");
      const last = w.__lilosFrames[w.__lilosFrames.length - 1];
      if (last && last.text === text && last.note === note) return;
      if (w.__lilosFrames.length < 2000) w.__lilosFrames.push({ text, note });
    };
    /* document.documentElement does not exist yet when the init script runs
       (pre-parse) — observe the document node itself. */
    new MutationObserver(record).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  } catch (e) {
    w.__lilosFramesErr = String(e);
  }
})();`;

interface Frame {
  text: string;
  note: boolean;
}

const frames = (page: Page): Promise<Frame[]> =>
  page.evaluate(
    () =>
      (window as unknown as { __lilosFrames?: Frame[] }).__lilosFrames ?? [],
  );

/* Holds the session-feed socket open but delivers nothing inbound — the
   attach watermark can't stamp until the hold is released, so the pre-model
   window stays up for exactly as long as the spec needs (deterministic
   window, not a race against `events.since`). */
interface FeedHold {
  release: () => void;
}

async function holdFeedSocket(page: Page, feedPort: number): Promise<FeedHold> {
  let held = true;
  const queued: (string | Buffer)[] = [];
  let clientSend: (msg: string | Buffer) => void = () => {};
  await page.routeWebSocket(
    new RegExp(`127\\.0\\.0\\.1:${feedPort}/`),
    (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => server.send(msg));
      clientSend = (msg) => ws.send(msg);
      server.onMessage((msg) => {
        if (held) queued.push(msg);
        else ws.send(msg);
      });
    },
  );
  return {
    release: () => {
      held = false;
      for (const m of queued.splice(0)) clientSend(m);
    },
  };
}

async function dmDefault(page: Page) {
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

const mainText = async (page: Page) =>
  page.locator("[data-thread]").innerText();

/* The order mergeTurns binds once the session model attaches: each drained
   reply anchors under ITS prompt, and the live leg's card sits at the tail. */
const CONVERGED = [
  "Done on", // turn 1's answer (prompt is the thread's root header)
  "first queued zebra",
  "First queued zebra",
  "second queued apple",
  "Second queued apple",
  "slowleg:900 leg: MID-LEG WITNESS", // the arming prompt row
  "I'll report back", // the arming turn's answer
  "Agent-initiated", // the leg card's badge — stays after it settles
];

test("AC-1 post-reload, no painted frame ever places a newer user row above an older answer", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.addInitScript(FRAME_RECORDER);
  await dmDefault(page);
  // Hold the session on an approval so both sends queue behind it — their
  // posts land AFTER the later user rows, the raw order that breaks #308
  // when mergeTurns has no model yet.
  await send(page, "Add a release note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 120_000,
  });
  await send(page, "first queued zebra");
  await expect(
    page.locator("[data-queued]").getByText("first queued zebra").first(),
  ).toBeVisible({ timeout: 15_000 });
  await send(page, "second queued apple");
  await expect(
    page.locator("[data-queued]").getByText("second queued apple").first(),
  ).toBeVisible({ timeout: 15_000 });
  const turns = page.locator("[data-agentturn]");
  await allowAllWhile(page, expectSettled(turns.first()));
  await expect(page.getByText("Allowed once by Oscar").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(turns).toHaveCount(3, { timeout: 240_000 });
  await expect(turns.last()).toContainText("Second queued apple", {
    timeout: 120_000,
  });
  /* A `slowleg:` leg stays running across the reload — the pre-attach window
     then replays mid-turn, not over an idle log. */
  await send(page, "slowleg:900 leg: MID-LEG WITNESS");
  await expect(turns).toHaveCount(5, { timeout: 120_000 });
  await expect(turns.last()).toContainText("Wrapping the background run", {
    timeout: 60_000,
  });
  /* The leg is mid-flight now (reasoning still streaming) — the reload lands
     inside it by construction. */

  /* Stall the feed socket's inbound stream before reloading so the attach
     watermark provably hasn't stamped at first paint — the pre-model window
     is held open until the spec releases it (asserts below stay honest:
     the note is the app's own "not synced" signal). */
  const feed = await holdFeedSocket(page, stack.ports.feed);
  await page.reload();
  await expect(page.locator("textarea").last()).toBeVisible({
    timeout: 30_000,
  });
  /* Inside the held window: the transcript note is up and the queued user
     rows are painted while the engine's posts are held — the pre-attach
     state the recorded frames must show. */
  await expect(page.locator("[data-transcript-note]").first()).toBeVisible({
    timeout: 30_000,
  });
  feed.release();
  // Converged state: the feed attached (note gone) and every marker sits in
  // its bound position. This waits on a CONDITION — the order itself is
  // asserted once below from the recorded frames, never re-polled.
  await expect(page.locator("[data-transcript-note]")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(turns).toHaveCount(5, { timeout: 120_000 });
  const converged = await mainText(page);
  const at = (text: string, marker: string) => text.indexOf(marker);
  for (let i = 0; i + 1 < CONVERGED.length; i++) {
    const a = at(converged, CONVERGED[i]);
    expect(
      a,
      `converged frame is missing ${CONVERGED[i]}`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      at(converged, CONVERGED[i + 1]),
      `${CONVERGED[i]} must sit above ${CONVERGED[i + 1]}`,
    ).toBeGreaterThan(a);
  }

  /* Every frame committed since the reload must already BE the converged
     order (a subsequence of it — rows may hydrate progressively). A frame
     that shows a user row above an earlier message's answer is the
     unanchored paint this issue removes. */
  const seen = await frames(page);
  const violations: { index: number; text: string }[] = [];
  seen.forEach((f, index) => {
    let prev = -1;
    for (const marker of CONVERGED) {
      const pos = at(f.text, marker);
      if (pos < 0) continue;
      if (pos <= prev) {
        violations.push({ index, text: f.text });
        return;
      }
      prev = pos;
    }
  });
  /* Guard against a vacuous pass: the pre-attach window must actually be
     in the log — either a still-syncing frame or a frame where user rows
     painted while engine posts were still held. */
  const windowSeen = seen.some(
    (f) =>
      f.note ||
      (f.text.includes("second queued apple") && !f.text.includes("Done on")),
  );
  expect(
    violations,
    `unanchored frames painted: ${violations
      .map((v) => `--- frame ${v.index} ---\n${v.text}`)
      .join("\n")}`,
  ).toHaveLength(0);
  expect(
    windowSeen,
    "the pre-attach window never made it into the recorded frames",
  ).toBe(true);
  await page.screenshot({ path: `${SHOTS}/ac-1-reload-converged.png` });
});
