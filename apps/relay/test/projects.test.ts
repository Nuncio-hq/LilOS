import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, Project } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { deriveProjectKey, projectNameFor } from "../src/store";
import {
  errorData,
  eventsNamed,
  helloed,
  helloedDevice,
  homes,
  lastId,
  mkhome,
  newRelay,
  newWorld,
  type Relay,
  req,
  resultOf,
  setupChannel,
  tick,
} from "./helpers";

/**
 * D-#854: projects are made by hand — the sidebar ＋, a chat's "Add as
 * project", an agent's approved `project_create`. Opening or moving a
 * thread in a folder NEVER creates one: the relay files the thread under
 * the deepest project whose folder equals or contains its folder, and a
 * folder no project covers is a plain chat. `projects.remove` deletes only
 * the record — threads, goals and tickets stay, unfiled.
 */

const HOME = "/Users/ada";

/** What the rig needs of a helloed peer — the token peer and the phone both fit. */
interface Peer {
  frames: unknown[];
  connection: { receive(data: string): Promise<void> };
}

async function call<T>(peer: Peer, method: string, params = {}): Promise<T> {
  await peer.connection.receive(req(method, params));
  return resultOf(peer.frames, lastId()).result as T;
}

const open = (peer: Peer, channelId: string, extra: Record<string, unknown>) =>
  call<{ conversation: Conversation }>(peer, "conversations.open", {
    channelId,
    text: "hello",
    ...extra,
  }).then((r) => r.conversation);

const projects = (peer: Peer) =>
  call<{ projects: Project[] }>(peer, "projects.list").then((r) => r.projects);

async function setup() {
  const relay = newRelay({ homeDir: HOME });
  const user = await helloed(relay);
  const { channel } = await setupChannel(user.frames, user.connection);
  return { relay, user, channel };
}

describe("project keys and names", () => {
  it("derives a short uppercase tag, unique, from the name", () => {
    const none = new Set<string>();
    expect(deriveProjectKey("LilOS", none)).toBe("LIL");
    expect(deriveProjectKey("HeardBack", none)).toBe("HEA");
    expect(deriveProjectKey("Heard Back", none)).toBe("HB");
    expect(deriveProjectKey("quick-research-notes-v2", none)).toBe("QRN");
    expect(deriveProjectKey("a", none)).toBe("A");
    expect(deriveProjectKey("Café", none)).toBe("CAF");
    expect(deriveProjectKey("日本語", none)).toBe("P");
    // A taken tag gets a counter; the older project keeps its own.
    expect(deriveProjectKey("LilOS", new Set(["LIL"]))).toBe("LIL2");
    expect(deriveProjectKey("LilOS", new Set(["LIL", "LIL2"]))).toBe("LIL3");
  });

  it("names a project after its folder's last segment", () => {
    expect(projectNameFor("/Users/ada/Code/LilOS")).toBe("LilOS");
    expect(projectNameFor("/Users/ada/Code/LilOS/")).toBe("LilOS");
    expect(projectNameFor("~/Code/LilOS")).toBe("LilOS");
    expect(projectNameFor("~")).toBe("Home");
    expect(projectNameFor("/")).toBe("/");
  });
});

describe("projects.list / projects.create", () => {
  it("is empty on a fresh relay and creates a project from a folder", async () => {
    const { user } = await setup();
    expect(await projects(user)).toEqual([]);

    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/LilOS", about: "The company OS." },
    );
    expect(project).toMatchObject({
      name: "LilOS",
      key: "LIL",
      folder: "~/Code/LilOS",
      about: "The company OS.",
    });
    expect(project.id).toBeTruthy();
    expect(await projects(user)).toEqual([project]);
  });

  it("takes the dialog's editable name and key (D-#854)", async () => {
    const { user } = await setup();
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/journal-app", name: "Journal", key: "JRN" },
    );
    expect(project).toMatchObject({ name: "Journal", key: "JRN" });
  });

  it("keeps a typed key exactly as typed — never shortened to a stem", async () => {
    const { user } = await setup();
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/lilos", name: "LilOS", key: "LILOS" },
    );
    // LILOS is a legal key (1–8 uppercase alphanumerics): it lands as typed.
    expect(project.key).toBe("LILOS");
  });

  it("refuses a key a live project already has — the dialog shows the error", async () => {
    const { user } = await setup();
    await call(user, "projects.create", {
      folder: "~/Code/a",
      name: "Alpha",
      key: "ALPHA",
    });
    await user.connection.receive(
      req("projects.create", {
        folder: "~/Code/b",
        name: "Beta",
        key: "ALPHA",
      }),
    );
    expect(errorData(user.frames, lastId())).toBe("conflict");
    // Nothing was made: the folder stays a plain chat target.
    expect((await projects(user)).map((p) => p.folder)).toEqual(["~/Code/a"]);
    // But a taken key on the SAME folder is just the get-or-create hit.
    const again = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code/a",
      name: "Anything",
      key: "ALPHA",
    });
    expect(again.project.folder).toBe("~/Code/a");
  });

  it("rejects a malformed key before anything is stored", async () => {
    const { user } = await setup();
    await user.connection.receive(
      req("projects.create", { folder: "~/Code/x", key: "lowercase!" }),
    );
    expect(errorData(user.frames, lastId())).toBe("invalid_params");
    expect(await projects(user)).toEqual([]);
  });

  it("broadcasts project.upserted to every peer on create, once", async () => {
    const { relay, user } = await setup();
    const other = await helloed(relay);
    user.frames.length = 0;

    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "/Users/ada/Code/qrit", name: "QRit" },
    );
    expect(eventsNamed(other.frames, "project.upserted")).toEqual([
      expect.objectContaining({ params: { project } }),
    ]);

    // The same folder again answers the stored project: nothing new is
    // announced and the name given the second time does not rename it.
    other.frames.length = 0;
    const again = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code/qrit/",
      name: "Something else",
    });
    expect(again.project).toEqual(project);
    expect(eventsNamed(other.frames, "project.upserted")).toHaveLength(0);
  });

  it("keeps keys unique across projects whose names collide", async () => {
    const { user } = await setup();
    const a = await call<{ project: Project }>(user, "projects.create", {
      folder: "/Users/ada/a/lilos",
    });
    const b = await call<{ project: Project }>(user, "projects.create", {
      folder: "/Users/ada/b/lilos",
    });
    expect([a.project.key, b.project.key]).toEqual(["LIL", "LIL2"]);
  });

  it("rejects params that name no folder", async () => {
    const { user } = await setup();
    await user.connection.receive(req("projects.create", {}));
    expect(errorData(user.frames, lastId())).toBe("invalid_params");
  });

  it("lets a phone create projects only for folders under the Mac's home", async () => {
    const home = mkhome();
    homes.push(home);
    mkdirSync(join(home, "Code", "app"), { recursive: true });
    const { pairing, relay } = newWorld(home);
    const phone = await helloedDevice(pairing, relay);

    const { project } = await call<{ project: Project }>(
      phone,
      "projects.create",
      { folder: "~/Code/app" },
    );
    expect(project.folder).toBe("~/Code/app");

    await phone.connection.receive(req("projects.create", { folder: "/etc" }));
    expect(errorData(phone.frames, lastId())).toBe("forbidden");
  });

  it("stores one spelling: ~-collapsed under the Mac's home, absolute outside it", async () => {
    const { user } = await setup();
    const folderOf = async (folder: string) =>
      (await call<{ project: Project }>(user, "projects.create", { folder }))
        .project.folder;
    expect(await folderOf(`${HOME}/Code/a/`)).toBe("~/Code/a");
    expect(await folderOf("~/Code/a")).toBe("~/Code/a"); // same project
    expect(await folderOf("/opt/shared/repo/")).toBe("/opt/shared/repo");
    expect((await projects(user)).map((p) => p.folder)).toEqual([
      "~/Code/a",
      "/opt/shared/repo",
    ]);
  });

  it("refuses a project that is the whole home folder or the root", async () => {
    const { user } = await setup();
    for (const folder of ["~", HOME, "/", "~/"]) {
      await user.connection.receive(req("projects.create", { folder }));
      expect(errorData(user.frames, lastId()), folder).toBe("invalid_params");
    }
    expect(await projects(user)).toEqual([]);
  });

  it("adopts the threads already in the folder — they were chats before it existed", async () => {
    const { relay, user, channel } = await setup();
    const other = await helloed(relay);
    await other.connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );
    const inside = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    const nested = await open(user, channel.id, {
      cwd: "~/Code/LilOS/sub/dir",
    });
    const outside = await open(user, channel.id, { cwd: "~/Code/qrit" });
    const chat = await open(user, channel.id, {});
    expect(inside.projectId).toBeUndefined();
    expect(await projects(user)).toEqual([]);

    other.frames.length = 0;
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/LilOS" },
    );
    // Both covered threads re-file; the other's folder and the folderless
    // chat stay untouched.
    const convs = await call<{ conversations: Conversation[] }>(
      user,
      "conversations.list",
      {},
    );
    const filed = (id: string) =>
      convs.conversations.find((c) => c.id === id)?.projectId;
    expect(filed(inside.id)).toBe(project.id);
    expect(filed(nested.id)).toBe(project.id);
    expect(filed(outside.id)).toBeUndefined();
    expect(filed(chat.id)).toBeUndefined();
    // Each adopted thread arrives as its own conversation.updated.
    const updates = eventsNamed(other.frames, "conversation.updated").length;
    expect(updates).toBeGreaterThanOrEqual(2);
  });

  it("a nested project adopts the threads a shallower project filed — most-specific wins", async () => {
    const { user, channel } = await setup();
    const outer = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code",
    });
    // Threads filed under ~/Code before the deeper project exists.
    const moved = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    const stays = await open(user, channel.id, { cwd: "~/Code/qrit" });
    expect(moved.projectId).toBe(outer.project.id);
    expect(stays.projectId).toBe(outer.project.id);

    const inner = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code/LilOS",
    });
    const filed = async (id: string) =>
      (
        await call<{ conversations: Conversation[] }>(
          user,
          "conversations.list",
          {},
        )
      ).conversations.find((c) => c.id === id)?.projectId;
    // The deeper project takes the threads it covers; the rest stay put.
    expect(await filed(moved.id)).toBe(inner.project.id);
    expect(await filed(stays.id)).toBe(outer.project.id);

    // And the other direction: a shallower project made later never steals
    // threads a deeper one already filed.
    const pkg = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/work/app",
    });
    const filedDeep = await open(user, channel.id, { cwd: "~/work/app/x" });
    expect(filedDeep.projectId).toBe(pkg.project.id);
    await call(user, "projects.create", { folder: "~/work" });
    expect(await filed(filedDeep.id)).toBe(pkg.project.id);
  });

  it("matches folders across case and symlink spellings (macOS filesystem)", async () => {
    const home = mkhome();
    homes.push(home);
    mkdirSync(join(home, "Code", "LilOS"), { recursive: true });
    symlinkSync(join(home, "Code", "LilOS"), join(home, "LinkToLilOS"));
    const { relay } = newWorld(home);
    const user = await helloed(relay);
    const { channel } = await setupChannel(user.frames, user.connection);

    // The project is made through the symlink spelling.
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/LinkToLilOS" },
    );

    // A thread in the real folder — another spelling of the same directory.
    const real = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    expect(real.projectId).toBe(project.id);

    // macOS's case-insensitive fs: the wrong-case spelling is the same folder.
    if (process.platform === "darwin") {
      const wrongCase = await open(user, channel.id, {
        cwd: "~/code/lilos",
      });
      expect(wrongCase.projectId).toBe(project.id);
    }

    // And the symlinked spelling for a thread files the same way.
    const linked = await open(user, channel.id, { cwd: "~/LinkToLilOS/sub" });
    expect(linked.projectId).toBe(project.id);
  });
});

describe("conversations.open files the thread (D-#854)", () => {
  it("opens a foldered thread as a chat — it never creates a project", async () => {
    const { user, channel } = await setup();
    const thread = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    expect(thread.projectId).toBeUndefined();
    expect(thread.cwd).toBe("~/Code/LilOS");
    expect(await projects(user)).toEqual([]);
  });

  it("files a thread under the project whose folder is, or contains, its cwd", async () => {
    const { user, channel } = await setup();
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/LilOS" },
    );
    const exact = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    const same = await open(user, channel.id, { cwd: `${HOME}/Code/LilOS/` });
    const nested = await open(user, channel.id, {
      cwd: "~/Code/LilOS/packages/ui",
    });
    const sibling = await open(user, channel.id, {
      cwd: "~/Code/LilOS-sibling",
    });
    expect(exact.projectId).toBe(project.id);
    expect(same.projectId).toBe(project.id);
    expect(nested.projectId).toBe(project.id);
    /* Segment boundary: "~/Code/LilOS-sibling" shares a prefix but is not
       inside the project — a chat. */
    expect(sibling.projectId).toBeUndefined();
  });

  it("the deepest containing project wins", async () => {
    const { user, channel } = await setup();
    const outer = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code",
    });
    const inner = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code/LilOS",
    });
    const deep = await open(user, channel.id, { cwd: "~/Code/LilOS/pkg" });
    const shallow = await open(user, channel.id, { cwd: "~/Code/qrit" });
    expect(deep.projectId).toBe(inner.project.id);
    expect(shallow.projectId).toBe(outer.project.id);
  });

  it("files a workstream thread under its repo's project, not its worktree", async () => {
    const { user, channel } = await setup();
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/LilOS" },
    );
    const thread = await open(user, channel.id, {
      cwd: "~/Code/LilOS/.lilos/wt/fix-login",
      workspace: {
        mode: "new",
        repoPath: "~/Code/LilOS",
        branch: "fix-login",
        base: "main",
      },
    });
    expect(thread.projectId).toBe(project.id);
    expect(thread.cwd).toBe("~/Code/LilOS/.lilos/wt/fix-login");
  });

  it("takes a project id from nobody: a client-sent projectId is ignored", async () => {
    const { user, channel } = await setup();
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "/Users/ada/Code/a" },
    );
    const thread = await open(user, channel.id, {
      cwd: "/Users/ada/Code/b",
      projectId: project.id,
    });
    expect(thread.projectId).not.toBe(project.id);
    expect(thread.projectId).toBeUndefined();
  });

  it("a retried open (same dedupeKey) files nothing twice", async () => {
    const { user, channel } = await setup();
    await call(user, "projects.create", { folder: "~/Code/LilOS" });
    const a = await open(user, channel.id, {
      cwd: "~/Code/LilOS",
      dedupeKey: "k1",
    });
    const b = await open(user, channel.id, {
      cwd: "~/Code/LilOS",
      dedupeKey: "k1",
    });
    expect(b.id).toBe(a.id);
    expect(await projects(user)).toHaveLength(1);
  });

  it("leaves a thread with no folder a plain chat and makes no project", async () => {
    const { user, channel } = await setup();
    const chat = await open(user, channel.id, {});
    expect(chat.projectId).toBeUndefined();
    expect(await projects(user)).toEqual([]);
  });

  it("carries projectId in the summaries' conversation too", async () => {
    const { user, channel } = await setup();
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/LilOS" },
    );
    const thread = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    const { summaries } = await call<{
      summaries: { conversation: Conversation }[];
    }>(user, "conversations.summaries", {});
    expect(summaries[0].conversation.projectId).toBe(project.id);
    expect(thread.projectId).toBe(project.id);
  });
});

/* The harness lands a move as a host-only `conversations.update {cwd}`
   while `conversations.moveFolder` is in flight (apps/relay move-folder
   tests carry the whole forward/note flow) — the filing rides that write. */
describe("moving a thread re-files it (D-#854)", () => {
  async function host(relay: Relay) {
    const peer = await helloed(relay);
    await peer.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
    );
    peer.frames.length = 0;
    return peer;
  }
  const hostMove = (h: Peer, conversationId: string, cwd: string | null) =>
    h.connection.receive(req("conversations.update", { conversationId, cwd }));

  it("re-files under the destination's project — and un-files where none covers", async () => {
    const { relay, user, channel } = await setup();
    const h = await host(relay);
    const lilos = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code/LilOS",
    });
    const qrit = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code/qrit",
    });
    const thread = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    const list = () =>
      call<{ conversations: Conversation[] }>(user, "conversations.list", {});
    const filed = async () =>
      (await list()).conversations.find((c) => c.id === thread.id);

    await hostMove(h, thread.id, "~/Code/qrit");
    await tick();
    expect((await filed())?.projectId).toBe(qrit.project.id);
    expect((await filed())?.cwd).toBe("~/Code/qrit");

    // A folder no project covers → a chat, no new project.
    await hostMove(h, thread.id, "~/Code/misc");
    expect((await filed())?.projectId).toBeUndefined();
    expect(await projects(user)).toHaveLength(2);

    // Moving back files it under the project that already exists.
    await hostMove(h, thread.id, `${HOME}/Code/LilOS`);
    expect((await filed())?.projectId).toBe(lilos.project.id);
  });

  it("makes a plain chat of a thread whose folder is cleared", async () => {
    const { relay, user, channel } = await setup();
    const h = await host(relay);
    await call(user, "projects.create", { folder: "~/Code/LilOS" });
    const thread = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    expect(thread.projectId).toBeTruthy();

    await hostMove(h, thread.id, null);
    const cleared = (
      await call<{ conversations: Conversation[] }>(
        user,
        "conversations.list",
        {},
      )
    ).conversations.find((c) => c.id === thread.id);
    expect(cleared?.projectId).toBeUndefined();
    expect(cleared?.cwd).toBeUndefined();
  });

  it("refuses a client writing cwd, so no client can re-file a thread", async () => {
    const { user, channel } = await setup();
    const thread = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    await user.connection.receive(
      req("conversations.update", {
        conversationId: thread.id,
        cwd: "~/elsewhere",
      }),
    );
    expect(errorData(user.frames, lastId())).toBe("forbidden");
  });

  it("a moved workstream drops its stale workspace — the old repo no longer claims it", async () => {
    const { relay, user, channel } = await setup();
    const h = await host(relay);
    /* A workstream thread: cwd is the .lilos/wt worktree, workspace.repoPath
       is the repo it forked (D-#848/#156). */
    const thread = await open(user, channel.id, {
      cwd: "~/Code/LilOS/.lilos/wt/fix-login",
      workspace: {
        mode: "new",
        repoPath: "~/Code/LilOS",
        branch: "fix-login",
        base: "main",
      },
    });
    expect(thread.workspace?.repoPath).toBe("~/Code/LilOS");

    // The host moves it to a plain folder — the workspace intent is stale.
    await hostMove(h, thread.id, "~/elsewhere");
    const moved = (
      await call<{ conversations: Conversation[] }>(
        user,
        "conversations.list",
        {},
      )
    ).conversations.find((c) => c.id === thread.id);
    expect(moved?.cwd).toBe("~/elsewhere");
    expect(moved?.workspace).toBeUndefined();

    // Making a project of the OLD repo must not adopt the moved thread.
    await call(user, "projects.create", { folder: "~/Code/LilOS" });
    let current = (
      await call<{ conversations: Conversation[] }>(
        user,
        "conversations.list",
        {},
      )
    ).conversations.find((c) => c.id === thread.id);
    expect(current?.projectId).toBeUndefined();

    // But a project over the NEW folder does.
    const home = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/elsewhere",
    });
    current = (
      await call<{ conversations: Conversation[] }>(
        user,
        "conversations.list",
        {},
      )
    ).conversations.find((c) => c.id === thread.id);
    expect(current?.projectId).toBe(home.project.id);
  });
});

describe("projects.remove (D-#854)", () => {
  it("removes the record only: threads become chats, goals and tickets keep theirs minus the link", async () => {
    const { relay, user, channel } = await setup();
    const other = await helloed(relay);
    await other.connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/LilOS" },
    );
    const inside = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    const nested = await open(user, channel.id, {
      cwd: "~/Code/LilOS/pkg",
    });
    const { goal } = await call<{ goal: { id: string } }>(
      user,
      "goals.create",
      { project: project.id, title: "Ship it" },
    );
    const { ticket } = await call<{ ticket: { id: string } }>(
      user,
      "tickets.create",
      { project: project.id, title: "Do the thing" },
    );

    other.frames.length = 0;
    await call(user, "projects.remove", { id: project.id });
    expect(await projects(user)).toEqual([]);

    const convs = await call<{ conversations: Conversation[] }>(
      user,
      "conversations.list",
      {},
    );
    const filed = (id: string) => convs.conversations.find((c) => c.id === id);
    expect(filed(inside.id)?.projectId).toBeUndefined();
    expect(filed(inside.id)?.cwd).toBe("~/Code/LilOS"); // the folder stays
    expect(filed(nested.id)?.projectId).toBeUndefined();

    const { goals } = await call<{
      goals: { id: string; projectId?: string }[];
    }>(user, "goals.list", {});
    expect(goals.find((g) => g.id === goal.id)?.projectId).toBeUndefined();
    const { tickets } = await call<{
      tickets: { id: string; projectId?: string }[];
    }>(user, "tickets.list", {});
    expect(tickets.find((t) => t.id === ticket.id)?.projectId).toBeUndefined();

    // Announced: the removal, and every thread's new filing.
    expect(eventsNamed(other.frames, "project.removed")).toEqual([
      expect.objectContaining({ params: { projectId: project.id } }),
    ]);
    expect(
      eventsNamed(other.frames, "conversation.updated").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("re-files the threads under a containing project that remains", async () => {
    const { user, channel } = await setup();
    const outer = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code",
    });
    const inner = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code/LilOS",
    });
    const thread = await open(user, channel.id, { cwd: "~/Code/LilOS/pkg" });
    expect(thread.projectId).toBe(inner.project.id);

    await call(user, "projects.remove", { id: inner.project.id });
    const moved = (
      await call<{ conversations: Conversation[] }>(
        user,
        "conversations.list",
        {},
      )
    ).conversations.find((c) => c.id === thread.id);
    expect(moved?.projectId).toBe(outer.project.id);
    expect(await projects(user)).toEqual([outer.project]);
  });

  it("is idempotent — a second remove (or a stale id) answers ok and deletes nothing", async () => {
    const { user, channel } = await setup();
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/LilOS" },
    );
    const thread = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    await call(user, "projects.remove", { id: project.id });
    // A double-click or a retried menu pick: the record is already gone,
    // which is the end state the caller asked for.
    const again = await call<{ ok: boolean }>(user, "projects.remove", {
      id: project.id,
    });
    expect(again.ok).toBe(true);
    // An id that was never a project answers the same way — nothing is
    // deleted either way.
    const never = await call<{ ok: boolean }>(user, "projects.remove", {
      id: "nope",
    });
    expect(never.ok).toBe(true);
    const { conversations } = await call<{ conversations: Conversation[] }>(
      user,
      "conversations.list",
      {},
    );
    expect(conversations.find((c) => c.id === thread.id)).toBeTruthy();
    expect(
      conversations.find((c) => c.id === thread.id)?.projectId,
    ).toBeUndefined();
  });

  it("keeps ticket ids climbing across a remove + re-add — no collision (D-#844)", async () => {
    const { user } = await setup();
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/LilOS", name: "LilOS", key: "LIL" },
    );
    const t1 = await call<{ ticket: { id: string } }>(user, "tickets.create", {
      project: project.id,
      title: "First",
    });
    expect(t1.ticket.id).toBe("LIL-1");
    await call(user, "projects.remove", { id: project.id });
    // Same folder again → the key LIL is free and reused; the next ticket
    // must NOT collide with the detached LIL-1.
    const again = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code/LilOS",
      name: "LilOS",
      key: "LIL",
    });
    const t2 = await call<{ ticket: { id: string } }>(user, "tickets.create", {
      project: again.project.id,
      title: "Second",
    });
    expect(t2.ticket.id).toBe("LIL-2");
  });

  it("re-adding a removed project's folder re-attaches its goals and tickets", async () => {
    const { user } = await setup();
    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/LilOS", name: "LilOS", key: "LIL" },
    );
    const { goal } = await call<{ goal: { id: string } }>(
      user,
      "goals.create",
      { project: project.id, title: "Ship it" },
    );
    const { ticket } = await call<{ ticket: { id: string } }>(
      user,
      "tickets.create",
      { project: project.id, title: "Do the thing", goalId: goal.id },
    );
    expect(ticket.id).toBe("LIL-1");
    await call(user, "projects.remove", { id: project.id });

    const re = await call<{ project: Project }>(user, "projects.create", {
      folder: "~/Code/LilOS",
      name: "LilOS",
      key: "LIL",
    });
    expect(re.project.id).not.toBe(project.id);

    const { goals } = await call<{
      goals: { id: string; projectId?: string }[];
    }>(user, "goals.list", {});
    expect(goals.find((g) => g.id === goal.id)?.projectId).toBe(re.project.id);
    const { tickets } = await call<{
      tickets: { id: string; projectId?: string }[];
    }>(user, "tickets.list", {});
    const back = tickets.find((t) => t.id === ticket.id);
    expect(back?.projectId).toBe(re.project.id);

    // The re-attached ticket can be picked up again — tickets.assign opens
    // its thread in the project's folder like a fresh one.
    const { employee } = await call<{ employee: { id: string } }>(
      user,
      "employees.create",
      { name: "Ada", role: "eng" },
    );
    const assigned = await call<{
      ticket: { id: string };
      conversation: Conversation;
    }>(user, "tickets.assign", { id: ticket.id, ownerId: employee.id });
    expect(assigned.ticket.id).toBe("LIL-1");
    expect(assigned.conversation.cwd).toBe("~/Code/LilOS");
    expect(assigned.conversation.projectId).toBe(re.project.id);
  });
});
