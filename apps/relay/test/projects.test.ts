import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Conversation,
  type Project,
  ProjectUpsertedEvent,
} from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { backfillProjects } from "../src/projects";
import { deriveProjectKey, projectNameFor } from "../src/store";
import {
  errorData,
  events,
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
import { createMemoryStore } from "./memory-store";

/**
 * D-#771: projects are records the relay owns, and the relay is the ONE place
 * that files a thread — a client opens or moves a thread into a folder and
 * the relay sets `projectId`, creating the folder's project on first use.
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
    expect(projectNameFor("/")).toBe("/");
  });
});

describe("projects.list / projects.create", () => {
  it("is empty on a fresh relay and creates a project from a folder", async () => {
    const { user } = await setup();
    expect(await call(user, "projects.list")).toEqual({ projects: [] });

    const { project } = await call<{ project: Project }>(
      user,
      "projects.create",
      { folder: "~/Code/LilOS", about: "The company OS." },
    );
    expect(project).toMatchObject({
      name: "LilOS",
      key: "LIL",
      folder: `${HOME}/Code/LilOS`,
      about: "The company OS.",
    });
    expect(project.id).toBeTruthy();
    expect(await call(user, "projects.list")).toEqual({ projects: [project] });
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
    expect(project.folder).toBe(join(home, "Code", "app"));

    await phone.connection.receive(req("projects.create", { folder: "/etc" }));
    expect(errorData(phone.frames, lastId())).toBe("forbidden");
  });
});

describe("conversations.open files the thread (D-#771)", () => {
  it("creates the folder's project on first use, then reuses it", async () => {
    const { user, channel } = await setup();
    const first = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    const { projects } = await call<{ projects: Project[] }>(
      user,
      "projects.list",
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      name: "LilOS",
      key: "LIL",
      folder: `${HOME}/Code/LilOS`,
    });
    expect(first.projectId).toBe(projects[0].id);

    // A different spelling of the same folder is the same project.
    const second = await open(user, channel.id, {
      cwd: `${HOME}/Code/LilOS/`,
    });
    expect(second.projectId).toBe(projects[0].id);
    expect(await call(user, "projects.list")).toEqual({ projects });
  });

  it("announces a new project before the thread that created it", async () => {
    const { relay, user, channel } = await setup();
    const other = await helloed(relay);
    await other.connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );
    other.frames.length = 0;

    const conversation = await open(user, channel.id, { cwd: "~/Code/HB" });
    const methods = events(other.frames)
      .map((f) => f.method)
      .filter((m) => m === "project.upserted" || m === "conversation.updated");
    expect(methods).toEqual(["project.upserted", "conversation.updated"]);
    const upserted = ProjectUpsertedEvent.parse(
      eventsNamed(other.frames, "project.upserted")[0].params,
    );
    expect(upserted.project.id).toBe(conversation.projectId);

    // A second thread in the folder announces no project.
    other.frames.length = 0;
    await open(user, channel.id, { cwd: "~/Code/HB" });
    expect(eventsNamed(other.frames, "project.upserted")).toHaveLength(0);
  });

  it("leaves a thread with no folder a plain chat and makes no project", async () => {
    const { user, channel } = await setup();
    const chat = await open(user, channel.id, {});
    expect(chat.projectId).toBeUndefined();
    expect(await call(user, "projects.list")).toEqual({ projects: [] });
  });

  it("files a workstream thread under its repo folder, not its worktree", async () => {
    const { user, channel } = await setup();
    const thread = await open(user, channel.id, {
      cwd: "~/Code/LilOS/.lilos/wt/fix-login",
      workspace: {
        mode: "new",
        repoPath: "~/Code/LilOS",
        branch: "fix-login",
        base: "main",
      },
    });
    const { projects } = await call<{ projects: Project[] }>(
      user,
      "projects.list",
    );
    expect(projects.map((p) => p.folder)).toEqual([`${HOME}/Code/LilOS`]);
    expect(thread.projectId).toBe(projects[0].id);
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
  });

  it("a retried open (same dedupeKey) files nothing twice", async () => {
    const { user, channel } = await setup();
    const a = await open(user, channel.id, {
      cwd: "~/Code/LilOS",
      dedupeKey: "k1",
    });
    const b = await open(user, channel.id, {
      cwd: "~/Code/LilOS",
      dedupeKey: "k1",
    });
    expect(b.id).toBe(a.id);
    const { projects } = await call<{ projects: Project[] }>(
      user,
      "projects.list",
    );
    expect(projects).toHaveLength(1);
  });

  it("carries projectId in the summaries' conversation too", async () => {
    const { user, channel } = await setup();
    const thread = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    const { summaries } = await call<{
      summaries: { conversation: Conversation }[];
    }>(user, "conversations.summaries", {});
    expect(summaries[0].conversation.projectId).toBe(thread.projectId);
  });
});

/* The harness lands a move as a host-only `conversations.update {cwd}`
   while `conversations.moveFolder` is in flight (apps/relay move-folder
   tests carry the whole forward/note flow) — the filing rides that write. */
describe("moving a thread re-files it (D-#771)", () => {
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

  it("files the thread under the destination folder's project, created on first use", async () => {
    const { relay, user, channel } = await setup();
    const h = await host(relay);
    const thread = await open(user, channel.id, { cwd: "~/Code/LilOS" });
    user.frames.length = 0;

    await hostMove(h, thread.id, "~/Code/qrit");
    await tick();
    const { projects } = await call<{ projects: Project[] }>(
      user,
      "projects.list",
    );
    expect(projects.map((p) => p.name)).toEqual(["LilOS", "qrit"]);
    const moved = (
      await call<{ conversations: Conversation[] }>(
        user,
        "conversations.list",
        {},
      )
    ).conversations.find((c) => c.id === thread.id);
    expect(moved?.projectId).toBe(projects[1].id);
    expect(moved?.cwd).toBe("~/Code/qrit");

    // Moving back files it under the project that already exists.
    await hostMove(h, thread.id, `${HOME}/Code/LilOS`);
    const back = (
      await call<{ conversations: Conversation[] }>(
        user,
        "conversations.list",
        {},
      )
    ).conversations.find((c) => c.id === thread.id);
    expect(back?.projectId).toBe(projects[0].id);
    expect(
      (await call<{ projects: Project[] }>(user, "projects.list")).projects,
    ).toHaveLength(2);
  });

  it("makes a plain chat of a thread whose folder is cleared", async () => {
    const { relay, user, channel } = await setup();
    const h = await host(relay);
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
});

describe("backfillProjects", () => {
  it("files foldered threads, leaves chats plain, and is idempotent", async () => {
    const store = createMemoryStore();
    const employee = await store.createEmployee({
      name: "Ada",
      role: "",
      status: "offline",
      profile: "",
      model: "",
      now: "",
      instructions: "",
      respondTo: "me",
    });
    const { channel } = await store.openDmChannel(employee.id);
    const mk = async (extra: Record<string, unknown>) =>
      (
        await store.openConversation({
          channelId: channel.id,
          title: "",
          text: "t",
          authorId: "user",
          ...extra,
        })
      ).conversation;
    const a1 = await mk({ cwd: "~/Code/LilOS" });
    const a2 = await mk({ cwd: `${HOME}/Code/LilOS` });
    const b = await mk({ cwd: "~/Code/qrit" });
    const wt = await mk({
      cwd: "~/Code/LilOS/.lilos/wt/x",
      workspace: {
        mode: "existing",
        repoPath: "~/Code/LilOS",
        branch: "x",
      },
    });
    const chat = await mk({});

    expect(await backfillProjects(store, HOME)).toEqual({
      filed: 4,
      created: 2,
    });
    const projects = await store.listProjects();
    expect(projects.map((p) => [p.name, p.key, p.folder])).toEqual([
      ["LilOS", "LIL", `${HOME}/Code/LilOS`],
      ["qrit", "QRI", `${HOME}/Code/qrit`],
    ]);
    const projectOf = async (id: string) =>
      (await store.getConversation(id))?.projectId;
    expect(await projectOf(a1.id)).toBe(projects[0].id);
    expect(await projectOf(a2.id)).toBe(projects[0].id);
    expect(await projectOf(wt.id)).toBe(projects[0].id);
    expect(await projectOf(b.id)).toBe(projects[1].id);
    expect(await projectOf(chat.id)).toBeUndefined();

    // A second boot has nothing left to do.
    expect(await backfillProjects(store, HOME)).toEqual({
      filed: 0,
      created: 0,
    });
    expect(await store.listProjects()).toEqual(projects);
  });
});
