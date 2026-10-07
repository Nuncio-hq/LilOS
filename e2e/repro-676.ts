/**
 * Scratch repro for #676 — reply attachment chip missing.
 * Spawns the real relay + harness (engine-fake), drives a real RelayClient
 * exactly like the DM page does (channelMessages + conversationSummaries),
 * and samples `waitingMessages` on the open conversation so we can see when
 * the reply's row is hidden (pre-fix the chip's only disappearance path —
 * the tray was text-only; now the row is parked but its chips ride along).
 *
 * Run: bun e2e/repro-676.ts [iterations]
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { RelayClient } from "../packages/client-runtime/src/client";
import { waitingMessages } from "../packages/client-runtime/src/waiting";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === "object" && addr
          ? resolve(addr.port)
          : reject(new Error("no port")),
      );
    });
  });

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQI12P8z/CfAQMwMCooKOgDAu2zC+h6pBe+AAAAAElFTkSuQmCC";

const VERBOSE = !!process.env.REPRO_VERBOSE;

async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  ms = 30_000,
  what = "",
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting ${what}`);
    await sleep(50);
  }
}

async function once() {
  const relayPort = await freePort();
  const feedPort = await freePort();
  const home = mkdtempSync(path.join(tmpdir(), "lilos-676-"));
  const relayProc = spawn(["bun", "run", "apps/relay/src/index.ts"], {
    cwd: repo,
    env: {
      ...process.env,
      LILOS_RELAY_HOME: home,
      LILOS_RELAY_PORT: String(relayPort),
      LILOS_RELAY_HOST: "127.0.0.1",
    },
    stdout: VERBOSE ? "inherit" : "ignore",
    stderr: "inherit",
  });
  const token = await waitFor(
    () => {
      try {
        return readFileSync(path.join(home, "relay-token"), "utf8").trim();
      } catch {
        return undefined;
      }
    },
    30_000,
    "relay token",
  );
  for (let i = 0; i < 300; i++) {
    const ok = await fetch(`http://127.0.0.1:${relayPort}/healthz`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await sleep(100);
  }
  const harnessProc = spawn(["bun", "run", "apps/harness/src/index.ts"], {
    cwd: repo,
    env: {
      ...process.env,
      LILOS_RELAY_URL: `ws://127.0.0.1:${relayPort}/ws`,
      LILOS_RELAY_HOME: home,
      LILOS_RELAY_TOKEN: token,
      LILOS_HARNESS_HOME: path.join(home, "harness"),
      LILOS_REPO_ROOT: repo,
      LILOS_WORKDIR: path.join(home, "work"),
      LILOS_FEED_PORT: String(feedPort),
      LILOS_ENGINE: "fake",
    },
    stdout: VERBOSE ? "inherit" : "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 300; i++) {
    const ok = await fetch(`http://127.0.0.1:${feedPort}/`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await sleep(100);
  }

  const client = new RelayClient({
    url: `ws://127.0.0.1:${relayPort}/ws`,
    token,
  });
  const events: string[] = [];
  const t0 = Date.now();
  const mark = (s: string) => events.push(`+${Date.now() - t0}ms ${s}`);
  client.onEvent((method, params) => {
    const p = params as Record<string, unknown>;
    const m = p.message as
      | {
          id?: string;
          seq?: number;
          claimed?: boolean;
          attachments?: unknown[];
        }
      | undefined;
    const c = p.conversation as
      | { id?: string; deliveredSeq?: number }
      | undefined;
    mark(
      `${method}` +
        (m
          ? ` msg=${m.id?.slice(0, 8)} seq=${m.seq} claimed=${m.claimed} att=${m.attachments?.length ?? 0}`
          : "") +
        (c ? ` conv=${c.id?.slice(0, 8)} dseq=${c.deliveredSeq}` : ""),
    );
  });
  await client.connect();

  const emp = (await waitFor(
    async () =>
      (
        await client.request<{ employees: { id: string }[] }>(
          "employees.list",
          {},
        )
      ).employees[0],
    30_000,
    "seeded employee",
  )) as unknown as { id: string };
  const { channel } = await client.request<{ channel: { id: string } }>(
    "channels.openDm",
    { employeeId: emp.id },
  );
  const channelId = channel.id;
  const store = client.channelMessages(channelId);
  await waitFor(
    () => (store.get().synced ? true : undefined),
    15_000,
    "channel sync",
  );

  // AC-2's first leg: open a thread with an image.
  const open = await client.request<{
    conversation: { id: string; rootMessageId: string; deliveredSeq: number };
  }>("conversations.open", {
    channelId,
    authorId: "me",
    text: `${process.env.REPRO_SLOW ? `slow:${process.env.REPRO_SLOW} ` : ""}what does this image show?`,
    attachments: [
      { name: "picked.png", mimeType: "image/png", dataBase64: PNG_B64 },
    ],
  });
  const convId = open.conversation.id;

  if (process.env.REPRO_MIDTURN) {
    // Post the reply while turn 1 is still streaming (queued behind it).
    await sleep(Number(process.env.REPRO_MIDTURN));
  } else {
    // Wait for the answer's row (employee author) — like the test waiting
    // for the "prompt content block" text, but measured on relay truth.
    await waitFor(
      () =>
        store
          .get()
          .messages.find(
            (m) => m.conversationId === convId && m.authorKind === "employee",
          ),
      30_000,
      "answer row",
    );
  }

  // REPLY leg — exactly like the test: messages.post with an image, right
  // after the answer text landed (turn may still be settling).
  const reply = await client.request<{ message: { id: string; seq: number } }>(
    "messages.post",
    {
      channelId,
      conversationId: convId,
      authorId: "me",
      authorKind: "user",
      text: "and this one?",
      attachments: [
        { name: "reply.png", mimeType: "image/png", dataBase64: PNG_B64 },
      ],
    },
  );
  const replyId = reply.message.id;
  const replySeq = reply.message.seq;

  // Sample the fold's visibility decision for ~8s: is the reply hidden
  // (pending && !claimed → waiting tray, no chip)? Also watch for a claimed
  // revert or a dropped row — either would hide the chip post-drain.
  let everHidden = 0;
  let firstHiddenAt = -1;
  let lastHiddenAt = -1;
  let firstVisibleAt = -1;
  let sawClaimed = false;
  const hiddenLog: string[] = [];
  for (let i = 0; i < 400; i++) {
    const msgs = store
      .get()
      .messages.filter((m) => m.conversationId === convId);
    const summ = client.conversationSummaries
      .get()
      .find((s) => s.conversation.id === convId);
    const dseq = summ?.conversation.deliveredSeq ?? -1;
    const row = msgs.find((m) => m.id === replyId);
    const w = waitingMessages(msgs as never[], Math.max(dseq, 0), undefined);
    const hidden = w.hiddenIds.has(replyId);
    const st = `row=${!!row} seq=${row?.seq} claimed=${row?.claimed} dseq=${dseq} hidden=${hidden}`;
    if (row?.claimed && !sawClaimed) {
      sawClaimed = true;
      hiddenLog.push(`CLAIMED +${Date.now() - t0}ms`);
    }
    if (sawClaimed && row && !row.claimed)
      hiddenLog.push(`!!! CLAIMED REVERTED +${Date.now() - t0}ms`);
    if (hidden) {
      everHidden++;
      if (firstHiddenAt < 0) firstHiddenAt = Date.now() - t0;
      lastHiddenAt = Date.now() - t0;
      if (sawClaimed) {
        hiddenLog.push(`!!! HIDDEN AFTER CLAIM +${Date.now() - t0}ms — ${st}`);
      } else if (
        hiddenLog.length === 0 ||
        !hiddenLog[hiddenLog.length - 1].startsWith("hidden")
      ) {
        hiddenLog.push(`hidden @+${Date.now() - t0}ms — ${st}`);
      }
    } else if (firstVisibleAt < 0 && row) {
      firstVisibleAt = Date.now() - t0;
      hiddenLog.push(`FIRST VISIBLE +${firstVisibleAt}ms — ${st}`);
    }
    if (VERBOSE && i % 40 === 0) mark(`sample ${st}`);
    await sleep(20);
  }

  await client.close();
  relayProc.kill();
  harnessProc.kill();
  await Promise.race([
    Promise.allSettled([relayProc.exited, harnessProc.exited]),
    sleep(5_000),
  ]);

  console.log(`\n=== events ===`);
  for (const e of events) console.log(e);
  console.log(`=== samples ===`);
  for (const e of hiddenLog) console.log(e);
  console.log(
    `reply seq=${replySeq} hiddenSamples=${everHidden} ` +
      `firstHidden=${firstHiddenAt}ms lastHidden=${lastHiddenAt}ms firstVisible=${firstVisibleAt}ms`,
  );
}

const iters = Number(process.argv[2] ?? 1);
for (let i = 0; i < iters; i++) {
  console.log(`\n######## iter ${i + 1}/${iters} ########`);
  try {
    await once();
  } catch (e) {
    console.log(`ITERATION FAILED: ${e}`);
  }
}
process.exit(0);
