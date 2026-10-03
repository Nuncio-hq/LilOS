import { describe, expect, it } from "vitest";
import {
  errorData,
  helloedDevice,
  helloedToken,
  lastId,
  newWorld,
  registeredHost,
  req,
  requestsTo,
  resultOf,
} from "./helpers";
import type { createMemoryStore } from "./memory-store";

/* `conversations.prs` (#159): a thread's pull requests. The relay resolves
   the conversation's folder (`cwd`/`workspace.repoPath`) + branch
   (`workspace.branch`) and awaits `forge.prs` on the registered harness —
   the device peer only ever names a conversationId, never a host path
   (same scoping rule as `session.events`). A folderless just-chat thread
   answers `{prs: []}` without a host call; host failures surface as errors
   the app treats as "nothing to show" (AC-4). */

/** A DM with a conversation on it — the store needs the channel row. */
async function seedConversation(
  store: ReturnType<typeof createMemoryStore>,
  over: {
    cwd?: string;
    workspace?: { mode: "existing"; repoPath: string; branch: string };
  } = {},
) {
  const employee = await store.createEmployee({
    name: "Ada",
    role: "eng",
    status: "online",
    profile: "builder",
    model: "",
    now: "",
    instructions: "",
    respondTo: "me",
  });
  const { channel } = await store.openDmChannel(employee.id);
  const { conversation } = await store.openConversation({
    channelId: channel.id,
    title: "",
    text: "ship it",
    authorId: "oscar",
    ...over,
  });
  return { channel, conversation };
}

const PR_ITEM = {
  number: 96,
  url: "https://github.com/acme/widgets/pull/96",
  repo: "acme/widgets",
  title: "Fix the badge",
  state: "open",
  draft: true,
  head: "ws/fix-7",
  base: "main",
  openedAt: "2026-09-24T08:00:00Z",
  checks: "failing",
};

describe("#159 conversations.prs — a thread's pull requests", () => {
  it("resolves the conversation's folder + branch, awaits the host, returns {prs}", async () => {
    const { store, pairing, relay } = newWorld();
    const { conversation } = await seedConversation(store, {
      cwd: "~/repo/.lilos/wt/fix-7",
      workspace: {
        mode: "existing",
        repoPath: "~/repo",
        branch: "ws/fix-7",
      },
    });
    const host = await registeredHost(relay);
    const phone = await helloedDevice(pairing, relay);

    /* conversations.prs awaits the host answer inside receive(), so kick
       the call off and answer as the host before awaiting it. The macrotask
       hop lets the conversation lookup + forward land on host.frames. */
    const pending = phone.connection.receive(
      req("conversations.prs", { conversationId: conversation.id }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const forwarded = requestsTo(host.frames);
    expect(forwarded).toHaveLength(1);
    /* The worktree cwd forwards — `gh` there queries the same GitHub repo
       and sees the branch the session actually checked out (the workstream
       branch also rides along via `branches`). */
    expect(forwarded[0]).toMatchObject({
      method: "forge.prs",
      params: { path: "~/repo/.lilos/wt/fix-7", branches: ["ws/fix-7"] },
    });

    await host.connection.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: forwarded[0].id,
        result: { root: "~/repo", branches: ["ws/fix-7"], prs: [PR_ITEM] },
      }),
    );
    await pending;
    expect(resultOf(phone.frames, lastId()).result).toEqual({
      prs: [PR_ITEM],
    });
  });

  it("a plain folder thread (cwd, no workspace) forwards the cwd, no branches", async () => {
    const { store, relay } = newWorld();
    const { conversation } = await seedConversation(store, {
      cwd: "~/repo",
    });
    const host = await registeredHost(relay);
    const caller = await helloedToken(relay);

    const pending = caller.connection.receive(
      req("conversations.prs", { conversationId: conversation.id }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const forwarded = requestsTo(host.frames);
    expect(forwarded[0]).toMatchObject({
      method: "forge.prs",
      params: { path: "~/repo" },
    });
    await host.connection.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: forwarded[0].id,
        result: { root: "~/repo", branches: ["feat/forge"], prs: [PR_ITEM] },
      }),
    );
    await pending;
    expect(resultOf(caller.frames, lastId()).result).toEqual({
      prs: [PR_ITEM],
    });
  });

  it("AC-4 a just-chat thread (no folder) answers {prs: []} with no host call", async () => {
    const { store, pairing, relay } = newWorld();
    const { conversation } = await seedConversation(store);
    const host = await registeredHost(relay);
    const phone = await helloedDevice(pairing, relay);

    await phone.connection.receive(
      req("conversations.prs", { conversationId: conversation.id }),
    );
    expect(resultOf(phone.frames, lastId()).result).toEqual({ prs: [] });
    expect(requestsTo(host.frames)).toHaveLength(0);
  });

  it("an unknown conversation is not_found — nothing reaches the host", async () => {
    const { pairing, relay } = newWorld();
    const host = await registeredHost(relay);
    const phone = await helloedDevice(pairing, relay);

    await phone.connection.receive(
      req("conversations.prs", { conversationId: "conv-nope" }),
    );
    expect(errorData(phone.frames, lastId())).toBe("not_found");
    expect(requestsTo(host.frames)).toHaveLength(0);
  });

  it("AC-4 no registered host → engine_unavailable (the app renders nothing)", async () => {
    const { store, relay } = newWorld();
    const { conversation } = await seedConversation(store, {
      cwd: "~/repo",
    });
    const caller = await helloedToken(relay);
    await caller.connection.receive(
      req("conversations.prs", { conversationId: conversation.id }),
    );
    expect(errorData(caller.frames, lastId())).toBe("engine_unavailable");
  });

  it("a host error reaches the caller as an error, not an empty list", async () => {
    const { store, relay } = newWorld();
    const { conversation } = await seedConversation(store, {
      cwd: "~/repo",
    });
    const host = await registeredHost(relay);
    const caller = await helloedToken(relay);

    const pending = caller.connection.receive(
      req("conversations.prs", { conversationId: conversation.id }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const forwarded = requestsTo(host.frames);
    await host.connection.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: forwarded[0].id,
        error: { code: -32102, message: "not a git repo: ~/repo" },
      }),
    );
    await pending;
    const frame = resultOf(caller.frames, lastId());
    expect(frame.error?.data?.code).toBe("engine_error");
  });
});
