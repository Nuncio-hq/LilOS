import { describe, expect, it } from "vitest";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

const TOKEN = "test-token";

function connectPeer(relay: ReturnType<typeof createRelay>) {
  const frames: unknown[] = [];
  const peer: RelayWsPeer = {
    send: (frame) => frames.push(JSON.parse(frame)),
    close: () => {},
  };
  const connection = relay.connect(peer);
  return { frames, connection };
}

const resultOf = (frames: unknown[], id: string) => {
  const frame = (
    frames as {
      id?: string;
      result?: unknown;
      error?: { code: number; message: string };
    }[]
  ).find((f) => f.id === id);
  if (!frame) throw new Error(`no response frame for ${id}`);
  return frame;
};

let nextId = 0;
const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });

async function helloed(relay: ReturnType<typeof createRelay>) {
  const { frames, connection } = connectPeer(relay);
  await connection.receive(
    req("session.hello", { protocolVersion: 1, token: TOKEN }),
  );
  frames.length = 0;
  return { frames, connection };
}

async function setupChannel(
  frames: unknown[],
  connection: { receive(d: string): Promise<void> },
) {
  await connection.receive(
    req("employees.create", { name: "Ada", role: "eng" }),
  );
  const employee = (
    resultOf(frames, `t${nextId - 1}`).result as {
      employee: { id: string; name: string };
    }
  ).employee;
  await connection.receive(req("channels.openDm", { employeeId: employee.id }));
  const channel = (
    resultOf(frames, `t${nextId - 1}`).result as {
      channel: { id: string; kind: string; employeeId: string };
    }
  ).channel;
  return { employee, channel };
}

const newRelay = () =>
  createRelay({ store: createMemoryStore(), token: TOKEN });

describe("AC-4 conversations.open carries the picked folder", () => {
  it("stores `cwd` on the conversation and returns it", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);
    frames.length = 0;

    await connection.receive(
      req("conversations.open", {
        channelId: channel.id,
        text: "look around",
        cwd: "/tmp/work",
      }),
    );
    const opened = resultOf(frames, `t${nextId - 1}`).result as {
      conversation: { id: string; cwd?: string };
    };
    expect(opened.conversation.cwd).toBe("/tmp/work");

    frames.length = 0;
    await connection.receive(req("conversations.list", {}));
    const listed = resultOf(frames, `t${nextId - 1}`).result as {
      conversations: { id: string; cwd?: string }[];
    };
    expect(
      listed.conversations.find((c) => c.id === opened.conversation.id)?.cwd,
    ).toBe("/tmp/work");
  });

  it("leaves `cwd` absent when no folder is picked", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);
    frames.length = 0;
    await connection.receive(
      req("conversations.open", { channelId: channel.id, text: "hi" }),
    );
    const opened = resultOf(frames, `t${nextId - 1}`).result as {
      conversation: { id: string; cwd?: string };
    };
    expect(opened.conversation.cwd).toBeUndefined();
  });
});

describe("AC-5 recent folders are LilOS-owned, shared, newest first", () => {
  it("folders.add records a folder and folders.list returns it", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);

    await connection.receive(req("folders.add", { path: "/tmp/a" }));
    const added = resultOf(frames, `t${nextId - 1}`).result as {
      folder: { path: string; lastUsedAt: number };
    };
    expect(added.folder.path).toBe("/tmp/a");
    expect(added.folder.lastUsedAt).toBeGreaterThan(0);

    frames.length = 0;
    await connection.receive(req("folders.list", {}));
    const listed = resultOf(frames, `t${nextId - 1}`).result as {
      folders: { path: string; lastUsedAt: number }[];
    };
    expect(listed.folders.map((f) => f.path)).toEqual(["/tmp/a"]);
  });

  it("conversations.open with cwd records the folder as a recent", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);

    await connection.receive(
      req("conversations.open", {
        channelId: channel.id,
        text: "go",
        cwd: "/tmp/repo-a",
      }),
    );
    frames.length = 0;
    await connection.receive(req("folders.list", {}));
    const listed = resultOf(frames, `t${nextId - 1}`).result as {
      folders: { path: string }[];
    };
    expect(listed.folders.map((f) => f.path)).toContain("/tmp/repo-a");
  });

  it("orders recents newest first and dedupes by path", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);

    await connection.receive(req("folders.add", { path: "/tmp/old" }));
    await new Promise((r) => setTimeout(r, 5));
    await connection.receive(req("folders.add", { path: "/tmp/new" }));
    await new Promise((r) => setTimeout(r, 5));
    // Re-adding bumps the folder to the top instead of duplicating it.
    await connection.receive(req("folders.add", { path: "/tmp/old" }));

    frames.length = 0;
    await connection.receive(req("folders.list", {}));
    const listed = resultOf(frames, `t${nextId - 1}`).result as {
      folders: { path: string }[];
    };
    expect(listed.folders.map((f) => f.path)).toEqual(["/tmp/old", "/tmp/new"]);
  });

  it("is shared across employees: one list, not scoped", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel: ch1 } = await setupChannel(frames, connection);
    // A second employee's DM channel sees the same recents.
    await connection.receive(
      req("employees.create", { name: "Bo", role: "ops" }),
    );
    const emp2 = (
      resultOf(frames, `t${nextId - 1}`).result as { employee: { id: string } }
    ).employee;
    await connection.receive(req("channels.openDm", { employeeId: emp2.id }));
    const ch2 = (
      resultOf(frames, `t${nextId - 1}`).result as { channel: { id: string } }
    ).channel;

    await connection.receive(
      req("conversations.open", {
        channelId: ch1.id,
        text: "x",
        cwd: "/tmp/shared",
      }),
    );
    // The other employee's client asks for the same global list.
    frames.length = 0;
    await connection.receive(req("folders.list", {}));
    const listed = resultOf(frames, `t${nextId - 1}`).result as {
      folders: { path: string }[];
    };
    expect(listed.folders.map((f) => f.path)).toEqual(["/tmp/shared"]);
    // And a session in ch2 from the same folder stays one recent entry.
    await connection.receive(
      req("conversations.open", {
        channelId: ch2.id,
        text: "y",
        cwd: "/tmp/shared",
      }),
    );
    frames.length = 0;
    await connection.receive(req("folders.list", {}));
    const again = resultOf(frames, `t${nextId - 1}`).result as {
      folders: { path: string }[];
    };
    expect(again.folders.map((f) => f.path)).toEqual(["/tmp/shared"]);
  });
});
