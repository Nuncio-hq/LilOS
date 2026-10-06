import { spawnSync } from "node:child_process";
import type { MessageSearchHit } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { createRelay } from "../src/session";
import { BUN, helloed, RELAY_DIR, req, TOKEN } from "./helpers";
import { createMemoryStore } from "./memory-store";

const lastFrame = (frames: unknown[]) =>
  frames.at(-1) as {
    result?: { hits?: MessageSearchHit[] };
    error?: { code: number; data?: { code?: string } };
  };
const hitsOf = (frames: unknown[]): MessageSearchHit[] =>
  lastFrame(frames).result?.hits ?? [];

interface Seed {
  employeeId: string;
  channelId: string;
  convId: string;
  replyId: string;
  archivedHitId: string;
}

/** One employee DM with a live session and an archived one, both carrying
    the search term in a reply (never in the session title). */
async function seed(
  connection: { receive(d: string): Promise<void> },
  frames: unknown[],
): Promise<Seed> {
  await connection.receive(
    req("employees.create", { name: "Ada", role: "eng" }),
  );
  const employee = (
    lastFrame(frames).result as unknown as { employee: { id: string } }
  ).employee;
  await connection.receive(req("channels.openDm", { employeeId: employee.id }));
  const channel = (
    lastFrame(frames).result as unknown as { channel: { id: string } }
  ).channel;
  const open = async (text: string) => {
    await connection.receive(
      req("conversations.open", { channelId: channel.id, text }),
    );
    return (
      lastFrame(frames).result as unknown as {
        conversation: { id: string };
        rootMessage: { id: string };
      }
    ).conversation;
  };
  const conv = await open("totally unrelated title");
  await connection.receive(
    req("messages.post", {
      channelId: channel.id,
      conversationId: conv.id,
      text: "the rate limit was hit during ingest",
      authorKind: "user",
    }),
  );
  const reply = (
    lastFrame(frames).result as unknown as { message: { id: string } }
  ).message;
  const archivedConv = await open("another title");
  await connection.receive(
    req("messages.post", {
      channelId: channel.id,
      conversationId: archivedConv.id,
      text: "rate limit inside the archived session",
      authorKind: "user",
    }),
  );
  const archivedHit = (
    lastFrame(frames).result as unknown as { message: { id: string } }
  ).message;
  await connection.receive(
    req("conversations.update", {
      conversationId: archivedConv.id,
      archived: true,
    }),
  );
  return {
    employeeId: employee.id,
    channelId: channel.id,
    convId: conv.id,
    replyId: reply.id,
    archivedHitId: archivedHit.id,
  };
}

const search = (
  connection: { receive(d: string): Promise<void> },
  params: Record<string, unknown>,
) => connection.receive(req("messages.search", params));

describe("messages.search over the session wire (memory store)", () => {
  it("AC-1 returns hits on message text with marked snippets", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const { frames, connection } = await helloed(relay);
    const s = await seed(connection, frames);

    await search(connection, { query: "rate limit" });
    const hits = hitsOf(frames);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find((h) => h.messageId === s.replyId);
    expect(hit).toBeDefined();
    expect(hit?.conversationId).toBe(s.convId);
    expect(hit?.channelId).toBe(s.channelId);
    expect(hit?.snippet).toContain("<mark>rate</mark>");
    expect(typeof hit?.createdAt).toBe("number");
  });

  it("AC-4 archived conversations are excluded unless includeArchived", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const { frames, connection } = await helloed(relay);
    const s = await seed(connection, frames);

    await search(connection, { query: "rate limit" });
    expect(hitsOf(frames).some((h) => h.messageId === s.archivedHitId)).toBe(
      false,
    );

    await search(connection, { query: "rate limit", includeArchived: true });
    expect(hitsOf(frames).some((h) => h.messageId === s.archivedHitId)).toBe(
      true,
    );
  });

  it("AC-4 a removed employee's messages leave the index", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const { frames, connection } = await helloed(relay);
    const s = await seed(connection, frames);
    await connection.receive(req("employees.remove", { id: s.employeeId }));
    await search(connection, { query: "rate limit", includeArchived: true });
    expect(lastFrame(frames).error).toBeUndefined();
    expect(hitsOf(frames)).toEqual([]);
  });

  it("AC-2 a match deep in a long message yields a …-led marked snippet", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const { frames, connection } = await helloed(relay);
    const s = await seed(connection, frames);
    const longText = `${"routine status note ".repeat(40)}needle lands at the tail`;
    await connection.receive(
      req("messages.post", {
        channelId: s.channelId,
        conversationId: s.convId,
        text: longText,
        authorKind: "user",
      }),
    );

    await search(connection, { query: "needle" });
    const hits = hitsOf(frames);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet.startsWith("…")).toBe(true);
    expect(hits[0].snippet).toContain("<mark>needle</mark>");
    // The window opens on a word boundary a few words before the match —
    // never a mid-word slice — and stays short enough for the hit row.
    const firstWord = hits[0].snippet
      .slice(1)
      .split(/\s/)[0]
      .replace(/<[^>]+>/g, "");
    expect("routine status note needle lands at the tail".split(" ")).toContain(
      firstWord,
    );
    expect(hits[0].snippet.length).toBeLessThan(160);
  });

  it("rejects bad params and scopes by channelId", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const { frames, connection } = await helloed(relay);
    await seed(connection, frames);

    await search(connection, { query: "" });
    expect(lastFrame(frames).error?.data?.code).toBe("invalid_params");
    await search(connection, { query: "rate", limit: 0 });
    expect(lastFrame(frames).error?.data?.code).toBe("invalid_params");
    await search(connection, {
      query: "rate limit",
      channelId: "ch_nope",
    });
    expect(hitsOf(frames)).toEqual([]);
  });
});

describe("messages.search over real SQLite FTS5 (bun fixture)", () => {
  /* The fixture runs the scenario under bun:sqlite and prints one JSON line
     per step; this block replays each line as an assertion (vitest/Node has
     no sqlite driver — the migrate.test.ts pattern). */
  const res = spawnSync(BUN, ["run", "test/fts-fixture.ts"], {
    cwd: RELAY_DIR,
    encoding: "utf8",
    timeout: 120_000,
  });
  const steps = new Map<string, unknown>();
  if (res.status === 0) {
    for (const line of res.stdout.trim().split("\n")) {
      const row = JSON.parse(line) as { step: string; data: unknown };
      steps.set(row.step, row.data);
    }
  }
  const hitsAt = (step: string) =>
    (steps.get(step) ?? []) as MessageSearchHit[];
  const idsAt = (step: string) => hitsAt(step).map((h) => h.messageId);

  it("fixture ran clean", () => {
    expect(res.status, res.stderr).toBe(0);
    expect(steps.get("version")).toEqual({ user_version: 22 });
  });

  it("AC-1 backfills pre-index rows and index follows writes", () => {
    expect(res.status).toBe(0);
    // 4 hits: alpha root + alpha reply + archived beta reply + other channel.
    expect(idsAt("backfill")).toHaveLength(4);
    expect(idsAt("insert-trigger")).toHaveLength(1);
    // Update trigger: old term stops matching, new term hits the same row.
    expect(idsAt("update-old-term")).toEqual([]);
    expect(idsAt("update-new-term")).toHaveLength(1);
    // Snippets carry the <mark> terms the UI renders.
    for (const h of hitsAt("backfill")) {
      expect(h.snippet).toContain("<mark>");
      expect(h.channelId).toBeTruthy();
      expect(h.createdAt).toBeGreaterThanOrEqual(0);
    }
  });

  it("AC-4 archived excluded by default; delete keeps the index in sync", () => {
    expect(res.status).toBe(0);
    expect(idsAt("archived-excluded")).toHaveLength(3);
    expect(idsAt("archived-included")).toHaveLength(1);
    expect(idsAt("channel-scope")).toHaveLength(1);
    // Only the surviving other-channel message remains after the remove.
    expect(idsAt("removed-employee")).toHaveLength(1);
  });

  it("FTS syntax in input never throws", () => {
    expect(res.status).toBe(0);
    expect(hitsAt("syntax-safe")).toEqual([]);
  });

  it("AC-2 a deep match opens the excerpt a few tokens before it (…+mark)", () => {
    expect(res.status).toBe(0);
    const snippets = (steps.get("deep-snippet") ?? []) as string[];
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toMatch(/^…/);
    expect(snippets[0]).toContain("<mark>needle</mark>");
    // The mark lands within the first few words so the row never clips it.
    expect(snippets[0].indexOf("<mark>")).toBeLessThan(80);
  });

  it("AC-5 answers a query on 100k messages under 100ms", () => {
    expect(res.status).toBe(0);
    const perf = steps.get("perf") as {
      queryMs: number;
      hits: number;
      id: string;
    };
    expect(perf.hits).toBe(1);
    expect(perf.id).toBe("m50000");
    expect(perf.queryMs).toBeLessThan(100);
  });
});
