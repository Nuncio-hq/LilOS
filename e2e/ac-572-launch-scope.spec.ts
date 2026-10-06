import { expect, type Page, test } from "@playwright/test";
import WebSocket from "ws";
import { RelayClient } from "../packages/client-runtime/src/index";
import type { Ask, Conversation } from "../packages/contracts/src/app/index";
import type { EngineEvent } from "../packages/contracts/src/engine/index";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #572 — replay only the threads that matter at launch. ACs:
 *   AC-1 boot traffic < 300 kB with 31 engine sessions — the feed socket
 *       must carry zero `events.since` replays while nothing is open,
 *       running, or asking (measured at the wire, both directions);
 *   AC-2 badges, the life ring, and notifications keep updating for
 *       background sessions that were never opened — driven by relay rows
 *       plus broadcast-folded signals, not per-session replay.
 *
 * The spec seeds 31 real engine sessions in beforeAll through the same
 * relay calls the composer makes, then watches the app's feed socket:
 * which sessions get replayed (`events.since`) and how many bytes flow
 * inbound. A background turn/ask is driven by a second RelayClient so the
 * app under test never touches the seeded conversations.
 */

const SESSIONS = 31;
const BOOT_BUDGET_BYTES = 300_000;
/* md: blocks writes a fat multi-section answer — the session-log shape the
   2.8 MB/31-session audit measured; replayed in full it would blow the
   budget in a handful of sessions. */
const SEED_PROMPT = "md: blocks";
const USER_ID = "user";

let stack: Stack;
let seeder: RelayClient;
let dmChannelId = "";
let convs: Conversation[] = [];

/** conversationId -> resolve() for its next turn.completed (engine.event). */
const turnWaiters = new Map<string, () => void>();

test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await bootStack("ac572", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    ENGINE_FAKE_TICK: "2",
  });
  seeder = new RelayClient({
    url: stack.relayWs,
    token: stack.relayToken,
    /* Spec files run under Node (no guaranteed global WebSocket) — the same
       ws-package factory e2e/helpers/relay-thread.ts uses. */
    socketFactory: (url) => new WebSocket(url),
  });
  /* engine.event frames reach channel subscribers only — the seeder holds
     the dm subscription so it sees turn completions. */
  seeder.onEvent((method, params) => {
    if (method !== "engine.event") return;
    const p = params as { conversationId?: string; event?: EngineEvent };
    if (p.event?.type !== "turn.completed") return;
    turnWaiters.get(p.conversationId ?? "")?.();
  });
  await seeder.connect();
  await expect
    .poll(() => seeder.directoryReady.get(), { timeout: 30_000 })
    .toBe(true);
  const dm = seeder.channels.get().find((c) => c.kind === "dm");
  if (!dm) throw new Error("no dm channel in the seeded stack");
  dmChannelId = dm.id;
  await seeder.request("channel.subscribe", { channelId: dm.id });

  const waitTurn = async (conversationId: string) => {
    const done = new Promise<void>((resolve) =>
      turnWaiters.set(conversationId, resolve),
    );
    await Promise.race([
      done,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`turn never completed: ${conversationId}`)),
          60_000,
        ),
      ),
    ]);
    turnWaiters.delete(conversationId);
  };

  /* Sessions fan out in parallel batches — engine-fake runs each session's
     turn independently, but 31 simultaneous opens bursty enough to throttle
     are pointless; 8-wide keeps seeding quick and deterministic. */
  const created: Conversation[] = [];
  for (let i = 0; i < SESSIONS; i += 8) {
    await Promise.all(
      Array.from({ length: Math.min(8, SESSIONS - i) }, async () => {
        const res = await seeder.request<{ conversation: Conversation }>(
          "conversations.open",
          { channelId: dmChannelId, authorId: USER_ID, text: SEED_PROMPT },
        );
        await waitTurn(res.conversation.id);
        created.push(res.conversation);
      }),
    );
  }
  /* engineRef binds when the harness reports session.start — re-read the
     rows so the spec has the session ids it asserts on. */
  const listed = await seeder.request<{ conversations: Conversation[] }>(
    "conversations.list",
    { channelId: dmChannelId },
  );
  convs = listed.conversations.filter((c) => c.engineRef);
  expect(convs.length).toBe(SESSIONS);
});

test.afterAll(async () => {
  seeder?.close();
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

/* ------------------------------ page probes ------------------------------ */

interface PostedNote {
  conversationId: string;
  kind: string;
  title: string;
  body: string;
}
type BridgeWindow = Window & {
  __lilosPosts?: PostedNote[];
  lilos?: unknown;
};

async function injectBridge(page: Page) {
  await page.addInitScript(() => {
    const w = window as BridgeWindow;
    w.__lilosPosts = [];
    w.lilos = {
      notifications: {
        post: (n: PostedNote) => (w.__lilosPosts ?? []).push(n),
      },
      onOpenConversation: () => () => {},
    };
  });
}

const postKeys = (page: Page) =>
  page.evaluate(() =>
    ((window as BridgeWindow).__lilosPosts ?? []).map(
      (n) => `${n.conversationId}:${n.kind}`,
    ),
  );

interface FeedMeter {
  /** sessionId per outbound events.since — the replay scope. */
  sinceCalls: string[];
  /** Bytes the feed socket delivered inbound — the AC-1 "boot traffic". */
  inboundBytes: number;
}

/** Proxies the app's feed socket, metering outbound replays + inbound bytes. */
async function meterFeedSocket(page: Page): Promise<FeedMeter> {
  const acc: FeedMeter = { sinceCalls: [], inboundBytes: 0 };
  await page.routeWebSocket(
    new RegExp(`127\\.0\\.0\\.1:${stack.ports.feed}/`),
    (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => {
        try {
          const f = JSON.parse(String(msg)) as {
            method?: string;
            params?: { sessionId?: string };
          };
          if (f.method === "events.since" && f.params?.sessionId)
            acc.sinceCalls.push(f.params.sessionId);
        } catch {}
        void server.send(msg);
      });
      server.onMessage((msg) => {
        acc.inboundBytes +=
          typeof msg === "string" ? Buffer.byteLength(msg) : msg.length;
        void ws.send(msg);
      });
    },
  );
  return acc;
}

const post = (conversationId: string, text: string) =>
  seeder.request("messages.post", {
    channelId: dmChannelId,
    conversationId,
    authorId: USER_ID,
    authorKind: "user",
    text,
  });

/* ------------------------------ the AC legs ------------------------------ */

test("AC-1/AC-2: cold boot replays nothing; background sessions still badge, ring, and notify", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await injectBridge(page);
  const meter = await meterFeedSocket(page);

  // ── AC-1: cold boot on the DM home — 31 engine sessions, zero replays ──
  await page.goto(`${stack.webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByText(/^default$/i)).toBeVisible({
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
    await aside.getByText(/^default$/i).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
  /* The session list renders from relay rows — all 31 land before we meter;
     any replay would have been sent the moment the feed socket opened, so
     once every row is on screen the window for boot replays is closed. A
     beat (ac-32's convention for "nothing posts") closes the race between
     the row render and the socket's first frames. */
  await expect(page.locator("[data-session]")).toHaveCount(SESSIONS, {
    timeout: 60_000,
  });
  await page.waitForTimeout(1_000);
  expect(meter.sinceCalls).toEqual([]);
  expect(meter.inboundBytes).toBeLessThan(BOOT_BUDGET_BYTES);

  // ── AC-2: a background turn badges running + rings without a replay ──
  const convA = convs[0];
  await post(convA.id, "slow:400 Say hi to Carol");
  await expect(aside.locator("[data-badge-running]")).toBeVisible({
    timeout: 60_000,
  });
  /* The session row's life pill shows the running ring. */
  const rowA = page.locator(`[data-session="${convA.rootMessageId}"]`);
  await expect(rowA.locator("[data-life]")).toHaveAttribute(
    "data-life",
    "running",
    { timeout: 30_000 },
  );
  /* The running session earns its feed — exactly that one session replays.
     (Set compare: a reconnect resync could legitimately re-ask a sid.) */
  await expect
    .poll(() => new Set(meter.sinceCalls), { timeout: 30_000 })
    .toEqual(new Set([convA.engineRef]));

  // ── AC-2: a background ask badges approvals + posts a notification ──
  const convB = convs[1];
  await post(convB.id, "Add a release note to the readme");
  const approvals = aside.locator("[data-badge-approvals]");
  await expect(approvals.locator("[aria-hidden]")).toHaveText("!", {
    timeout: 60_000,
  });
  await expect
    .poll(() => postKeys(page), { timeout: 60_000 })
    .toContain(`${convB.id}:ask`);
  await expect
    .poll(() => new Set(meter.sinceCalls), { timeout: 30_000 })
    .toEqual(new Set([convA.engineRef, convB.engineRef]));

  // ── AC-1: opening a thread replays exactly that session ──
  const convC = convs[2];
  await page
    .locator(`[data-session="${convC.rootMessageId}"] [data-life]`)
    .click();
  await expect(page).toHaveURL(new RegExp(`/dm/[^/]+/${convC.id}$`));
  await expect(page.locator("[data-thread-panel]")).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => new Set(meter.sinceCalls).size, { timeout: 30_000 })
    .toBe(3);
  expect(new Set(meter.sinceCalls)).toEqual(
    new Set([convA.engineRef, convB.engineRef, convC.engineRef]),
  );

  // ── AC-2: resolving the ask out of band clears the badge and the turn
  //    ending posts a done notification — background lifecycle end-to-end ──
  const { asks } = await seeder.request<{ asks: Ask[] }>("asks.list", {});
  const openAsk = asks.find(
    (a) => a.conversationId === convB.id && a.state === "open",
  );
  if (!openAsk) throw new Error("no open ask for convB");
  await seeder.request("asks.respond", {
    askId: openAsk.id,
    outcome: "once",
  });
  await expect(approvals).toHaveCount(0, { timeout: 60_000 });
  await expect
    .poll(() => postKeys(page), { timeout: 60_000 })
    .toContain(`${convB.id}:done`);

  // ── AC-2: the slow background turn completes → done notification + the
  //    running badge and the feed release follow the turn's end ──
  await expect
    .poll(() => postKeys(page), { timeout: 120_000 })
    .toContain(`${convA.id}:done`);
  await expect(aside.locator("[data-badge-running]")).toHaveCount(0, {
    timeout: 60_000,
  });
});
