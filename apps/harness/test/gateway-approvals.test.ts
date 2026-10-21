import type {
  AppMessage,
  Ask,
  Conversation,
  Employee,
  Project,
} from "@lilos/contracts/app";
import { SessionSurfaces, toolBackend } from "@lilos/surfaces";
import { describe, expect, it } from "vitest";
import {
  FakePtySpawner,
  serveGateway,
} from "../../../packages/surfaces/test/fakes";
import { createAppOps } from "../src/harness/app-ops";
import { openDmConversation, setupWorld, waitFor } from "./helpers";

/**
 * The approval-gated gateway tools end to end (D-#341): a tool call posts an
 * ask on the bound conversation, NOTHING is written before the user answers,
 * approve applies through the real relay methods, and decline returns the
 * declined error — across the real HTTP gateway the engines talk to. Full
 * access never skips the card.
 */
describe("approval-gated gateway tools", () => {
  async function world() {
    const w = await setupWorld();
    const { employee, channel } = await openDmConversation(w.user);
    /* team_set_ceo is CEO-only (D-#778). This employee holds the position
       before the recording proxy, so those calls are offered and the hire
       test's `sent` list stays about the tool call. team_hire is not
       CEO-only; the holder is still set so a hire reports to them. */
    await w.user.request("company.setCeo", { employeeId: employee.id });
    const { conversation } = await w.user.request<{
      conversation: Conversation;
    }>("conversations.open", { channelId: channel.id, text: "hi" });
    const binding = {
      employeeId: employee.id,
      channelId: channel.id,
      conversationId: conversation.id,
    };
    /* The harness's relay, recording every request it makes — the tests
       assert what the agent's call really put on the wire (a `cwd`, never a
       project id) and what it did NOT send before the user answered. */
    const sent: { method: string; params: unknown }[] = [];
    const recording = new Proxy(w.harnessRelay, {
      get(target, prop) {
        if (prop === "request") {
          return (method: string, params?: Record<string, unknown>) => {
            sent.push({ method, params });
            return target.request(method, params);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const appOps = createAppOps({
      relay: recording,
      runningTurnId: () => "turn-1",
      log: w.log,
    })("s1", binding);
    if (!appOps) throw new Error("unbound");
    const scope = new SessionSurfaces({
      session: "s1",
      cwd: "/tmp",
      spawnPty: new FakePtySpawner().spawn,
      appOps,
      binding,
      ceoAtStart: true,
    });
    const gw = await serveGateway({ sessions: [{ scope, token: "tok" }] });
    const client = toolBackend({
      baseUrl: gw.baseUrl,
      token: "tok",
      session: "s1",
    });
    const asks = async (state: "open" | "resolved") => {
      const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
        conversationId: conversation.id,
        state,
      });
      return asks;
    };
    const nextAsk = async (have: Set<string>) =>
      await waitFor(async () => {
        const open = await asks("open");
        return open.find((a) => !have.has(a.id));
      }, "the approval ask to open");
    const answer = async (askId: string, outcome: "once" | "deny") =>
      await w.user.request<{ ask: Ask }>("asks.respond", {
        askId,
        outcome,
      });
    const conversations = async () => {
      const { conversations } = await w.user.request<{
        conversations: Conversation[];
      }>("conversations.list", { channelId: channel.id });
      return conversations;
    };
    const employees = async () => {
      const { employees } = await w.user.request<{
        employees: Employee[];
      }>("employees.list", {});
      return employees;
    };
    const projects = async () => {
      const { projects } = await w.user.request<{ projects: Project[] }>(
        "projects.list",
        {},
      );
      return projects;
    };
    const makeProject = async (folder: string, name?: string) => {
      const { project } = await w.user.request<{ project: Project }>(
        "projects.create",
        { folder, ...(name ? { name } : {}) },
      );
      return project;
    };
    return {
      w,
      binding,
      scope,
      gw,
      client,
      nextAsk,
      answer,
      conversations,
      employees,
      asks,
      sent,
      projects,
      makeProject,
    };
  }

  it("thread_start: approve opens the thread, decline writes nothing", async () => {
    const v = await world();
    try {
      const seen = new Set<string>();
      const before = (await v.conversations()).length;

      /* Approve: the ask opens first — nothing written until "once". */
      const call = v.client.threadStart({
        title: "Vendor notes",
        text: "tracking the vendor thread",
      });
      const ask = await v.nextAsk(seen);
      seen.add(ask.id);
      expect(ask.request.kind).toBe("approval");
      if (ask.request.kind !== "approval") throw new Error("not approval");
      expect(ask.request.options).toEqual(["once", "deny"]);
      expect((await v.conversations()).length).toBe(before);
      await v.answer(ask.id, "once");
      const res = await call;
      expect(res.conversation.title).toBe("Vendor notes");
      expect(res.message.text).toBe("tracking the vendor thread");
      expect((await v.conversations()).length).toBe(before + 1);

      /* Decline: same card, denied — the tool errors and no thread lands. */
      const call2 = v.client.threadStart({ text: "try again" });
      const ask2 = await v.nextAsk(seen);
      seen.add(ask2.id);
      await v.answer(ask2.id, "deny");
      await expect(call2).rejects.toThrow();
      expect((await v.conversations()).length).toBe(before + 1);
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("thread_start with no project: a plain chat — no cwd on the wire, no DM in the card", async () => {
    const v = await world();
    try {
      const seen = new Set<string>();
      const call = v.client.threadStart({ text: "just thinking out loud" });
      const ask = await v.nextAsk(seen);
      if (ask.request.kind !== "approval") throw new Error("not approval");
      expect(ask.request.description).toContain("Start a new thread");
      expect(ask.request.description).toContain("plain chat");
      expect(ask.request.description).toContain("just thinking out loud");
      expect(ask.request.description).not.toMatch(/\bDM\b/);
      await v.answer(ask.id, "once");
      const res = await call;

      const open = v.sent.find((s) => s.method === "conversations.open");
      expect(open?.params).toEqual({
        channelId: v.binding.channelId,
        authorId: v.binding.employeeId,
        text: "just thinking out loud",
      });
      const conv = (await v.conversations()).find(
        (c) => c.id === res.conversation.id,
      );
      expect(conv?.cwd).toBeUndefined();
      expect(conv?.projectId).toBeUndefined();
      // Asking and starting a plain chat created no project.
      expect(await v.projects()).toEqual([]);
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("thread_start with a project id or a lowercase key: the project's folder is the cwd and the relay files it", async () => {
    const v = await world();
    try {
      const shop = await v.makeProject("/work/shop", "Shop");
      const lab = await v.makeProject("/work/lab", "Lab");
      expect(shop.key).not.toBe(lab.key);
      const seen = new Set<string>();

      const byId = v.client.threadStart({
        text: "start with the cart",
        project: shop.id,
      });
      const askId = await v.nextAsk(seen);
      seen.add(askId.id);
      if (askId.request.kind !== "approval") throw new Error("not approval");
      // The card names the project and its folder.
      expect(askId.request.description).toContain("Shop");
      expect(askId.request.description).toContain("/work/shop");
      expect(askId.request.description).toContain("start with the cart");
      expect(askId.request.description).not.toMatch(/\bDM\b/);
      // Nothing is opened before "once".
      expect(v.sent.some((s) => s.method === "conversations.open")).toBe(false);
      await v.answer(askId.id, "once");
      const first = await byId;

      const byKey = v.client.threadStart({
        text: "and the checkout",
        title: "Checkout",
        project: lab.key.toLowerCase(),
      });
      const askKey = await v.nextAsk(seen);
      seen.add(askKey.id);
      await v.answer(askKey.id, "once");
      const second = await byKey;

      /* What went on the wire: the folder as `cwd` and nothing project-ish —
         no id, no key (the relay files the thread, D-#771). Channel and author
         still come from the binding. */
      const opens = v.sent.filter((s) => s.method === "conversations.open");
      expect(opens.map((o) => o.params)).toEqual([
        {
          channelId: v.binding.channelId,
          authorId: v.binding.employeeId,
          text: "start with the cart",
          cwd: "/work/shop",
        },
        {
          channelId: v.binding.channelId,
          authorId: v.binding.employeeId,
          text: "and the checkout",
          title: "Checkout",
          cwd: "/work/lab",
        },
      ]);

      const convs = await v.conversations();
      const a = convs.find((c) => c.id === first.conversation.id);
      const b = convs.find((c) => c.id === second.conversation.id);
      expect(a).toMatchObject({ cwd: "/work/shop", projectId: shop.id });
      expect(b).toMatchObject({ cwd: "/work/lab", projectId: lab.id });
      // No project was created along the way.
      expect((await v.projects()).map((p) => p.id)).toEqual([shop.id, lab.id]);
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("thread_start with an unknown project errors before any ask opens", async () => {
    const v = await world();
    try {
      const shop = await v.makeProject("/work/shop", "Shop");
      const before = (await v.conversations()).length;

      const err = await v.client
        .threadStart({ text: "hello", project: "NOPE" })
        .then(
          () => undefined,
          (e: Error) => e,
        );
      expect(err).toBeInstanceOf(Error);
      // The message names the value and the keys that do exist.
      expect(err?.message).toContain('"NOPE"');
      expect(err?.message).toContain(shop.key);
      expect(err?.message).toContain("project_list");

      // Nothing reached the user and nothing was opened.
      expect(await v.asks("open")).toEqual([]);
      expect(v.sent.some((s) => s.method === "asks.open")).toBe(false);
      expect(v.sent.some((s) => s.method === "conversations.open")).toBe(false);
      expect((await v.conversations()).length).toBe(before);

      // With no projects at all the error says so (and still asks nothing).
      const v2 = await world();
      try {
        const err2 = await v2.client
          .threadStart({ text: "hello", project: "X" })
          .then(
            () => undefined,
            (e: Error) => e,
          );
        expect(err2?.message).toContain("there are no projects yet");
        expect(await v2.asks("open")).toEqual([]);
      } finally {
        v2.gw.server.close();
        await v2.scope.close();
        await v2.w.cleanup();
      }
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("thread_start into a project: a decline opens nothing", async () => {
    const v = await world();
    try {
      const shop = await v.makeProject("/work/shop", "Shop");
      const before = (await v.conversations()).length;
      const call = v.client.threadStart({ text: "nope", project: shop.key });
      const ask = await v.nextAsk(new Set());
      await v.answer(ask.id, "deny");
      await expect(call).rejects.toThrow(/declined/);
      expect(v.sent.some((s) => s.method === "conversations.open")).toBe(false);
      expect((await v.conversations()).length).toBe(before);
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("project_list: answers the relay's list and raises no ask", async () => {
    const v = await world();
    try {
      expect((await v.client.projectList()).projects).toEqual([]);
      const shop = await v.makeProject("/work/shop", "Shop");
      const lab = await v.makeProject("/work/lab");
      expect(lab.name).toBe("lab");
      const listed = (await v.client.projectList()).projects;
      expect(listed).toEqual(await v.projects());
      expect(listed.map((p) => p.id)).toEqual([shop.id, lab.id]);
      expect(await v.asks("open")).toEqual([]);
      expect(v.sent.some((s) => s.method === "asks.open")).toBe(false);
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("project_create: the ask names folder, name and about; nothing is made before once; deny makes nothing", async () => {
    const v = await world();
    try {
      const seen = new Set<string>();
      const call = v.client.projectCreate({
        folder: "/work/shop",
        name: "Shop",
        about: "the storefront",
      });
      const ask = await v.nextAsk(seen);
      seen.add(ask.id);
      expect(ask.request.kind).toBe("approval");
      if (ask.request.kind !== "approval") throw new Error("not approval");
      expect(ask.request.options).toEqual(["once", "deny"]);
      expect(ask.request.command).toContain("/work/shop");
      expect(ask.request.description).toContain("/work/shop");
      expect(ask.request.description).toContain("Shop");
      expect(ask.request.description).toContain("the storefront");
      // The ask is up and the call is waiting: nothing exists yet.
      expect(await v.projects()).toEqual([]);
      expect(v.sent.some((s) => s.method === "projects.create")).toBe(false);

      await v.answer(ask.id, "once");
      const made = await call;
      expect(made.project).toMatchObject({
        name: "Shop",
        folder: "/work/shop",
        about: "the storefront",
      });
      expect(await v.projects()).toEqual([made.project]);

      // A folder that already has a project answers it — still asked first.
      const again = v.client.projectCreate({ folder: "/work/shop" });
      const askAgain = await v.nextAsk(seen);
      seen.add(askAgain.id);
      await v.answer(askAgain.id, "once");
      expect((await again).project).toEqual(made.project);
      expect((await v.projects()).length).toBe(1);

      // Deny: the card goes up, the user refuses, nothing is created.
      const denied = v.client.projectCreate({ folder: "/work/nope" });
      const askDeny = await v.nextAsk(seen);
      seen.add(askDeny.id);
      await v.answer(askDeny.id, "deny");
      await expect(denied).rejects.toThrow(/declined/);
      expect((await v.projects()).map((p) => p.folder)).toEqual(["/work/shop"]);
      expect(v.sent.filter((s) => s.method === "projects.create").length).toBe(
        2,
      );
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("team_hire: the ask carries the draft; approve hires, decline doesn't", async () => {
    const v = await world();
    try {
      const seen = new Set<string>();
      const before = (await v.employees()).length;

      const call = v.client.teamHire({
        name: "Bea",
        role: "designer",
        model: "fake-small",
        instructions: "make it pretty",
      });
      const ask = await v.nextAsk(seen);
      seen.add(ask.id);
      /* The card IS the hire draft — Mac renders the hire card off it. */
      expect(ask.hire).toMatchObject({
        name: "Bea",
        role: "designer",
        model: "fake-small",
        instructions: "make it pretty",
      });
      expect((await v.employees()).length).toBe(before);
      await v.answer(ask.id, "once");
      const res = await call;
      expect(res.employee.name).toBe("Bea");
      expect(res.employee.role).toBe("designer");
      const all = await v.employees();
      expect(all.length).toBe(before + 1);
      expect(all.find((e) => e.name === "Bea")?.profile).toBeTruthy();
      /* A hire while someone holds the seat reports to them (D-#778). */
      expect(all.find((e) => e.name === "Bea")?.reportsTo).toBe(
        v.binding.employeeId,
      );

      const call2 = v.client.teamHire({
        name: "Cal",
        role: "ops",
        model: "fake-small",
        instructions: "run the floor",
      });
      const ask2 = await v.nextAsk(seen);
      seen.add(ask2.id);
      await v.answer(ask2.id, "deny");
      await expect(call2).rejects.toThrow();
      expect((await v.employees()).length).toBe(before + 1);
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("team_set_ceo: unknown and already-holder open no card; deny writes nothing; approve moves it", async () => {
    const v = await world();
    try {
      const ceoNow = async () =>
        (
          await v.w.user.request<{ value: unknown }>("settings.get", {
            key: "ceoId",
          })
        ).value;

      await expect(
        v.client.teamSetCeo({ employeeId: "emp_missing" }),
      ).rejects.toThrow(/not found/);
      expect(await v.asks("open")).toEqual([]);
      expect(await ceoNow()).toBe(v.binding.employeeId);

      await expect(
        v.client.teamSetCeo({ employeeId: v.binding.employeeId }),
      ).rejects.toThrow(/already holds/);
      expect(await v.asks("open")).toEqual([]);

      const { employee: denied } = await v.w.user.request<{
        employee: Employee;
      }>("employees.create", { name: "Nia", role: "ops" });
      const seen = new Set<string>();
      const denyCall = v.client.teamSetCeo({ employeeId: denied.id });
      const askDeny = await v.nextAsk(seen);
      seen.add(askDeny.id);
      expect(askDeny.request.kind).toBe("approval");
      if (askDeny.request.kind === "approval") {
        expect(askDeny.request.description ?? "").toContain("Nia");
      }
      expect(await ceoNow()).toBe(v.binding.employeeId);
      await v.answer(askDeny.id, "deny");
      await expect(denyCall).rejects.toThrow(/declined/);
      expect(await ceoNow()).toBe(v.binding.employeeId);

      const { employee: next } = await v.w.user.request<{
        employee: Employee;
      }>("employees.create", { name: "Quill", role: "notes" });
      const call = v.client.teamSetCeo({ employeeId: next.id });
      const ask = await v.nextAsk(seen);
      seen.add(ask.id);
      expect(await ceoNow()).toBe(v.binding.employeeId);
      await v.answer(ask.id, "once");
      expect((await call).ceoId).toBe(next.id);
      expect(await ceoNow()).toBe(next.id);
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("team_update: edits only the calling employee, approve or decline", async () => {
    const v = await world();
    try {
      const seen = new Set<string>();
      const meBefore = (await v.employees()).find(
        (e) => e.id === v.binding.employeeId,
      );

      const call = v.client.teamUpdate({ role: "lead engineer" });
      const ask = await v.nextAsk(seen);
      seen.add(ask.id);
      await v.answer(ask.id, "once");
      const res = await call;
      expect(res.employee.id).toBe(v.binding.employeeId);
      expect(res.employee.role).toBe("lead engineer");
      const me = (await v.employees()).find(
        (e) => e.id === v.binding.employeeId,
      );
      expect(me?.role).toBe("lead engineer");
      /* A stray id in params can't point the edit at someone else —
         strict params reject it before the gate even opens. */
      await expect(
        v.client.teamUpdate({ id: "emp-other", role: "x" } as never),
      ).rejects.toThrow();

      const call2 = v.client.teamUpdate({ name: "Ada II" });
      const ask2 = await v.nextAsk(seen);
      seen.add(ask2.id);
      await v.answer(ask2.id, "deny");
      await expect(call2).rejects.toThrow();
      const after = (await v.employees()).find(
        (e) => e.id === v.binding.employeeId,
      );
      expect(after?.name).toBe(meBefore?.name);

      /* The engine-write leg: a model change goes through agents.update
         on the calling profile before the employee record moves. */
      const call3 = v.client.teamUpdate({ model: "fake-large" });
      const ask3 = await v.nextAsk(seen);
      seen.add(ask3.id);
      /* The card states the value being approved, not just the field. */
      expect(ask3.request.kind).toBe("approval");
      if (ask3.request.kind !== "approval") throw new Error("not approval");
      expect(ask3.request.description ?? "").toContain("fake-large");
      await v.answer(ask3.id, "once");
      const res3 = await call3;
      expect(res3.employee.model).toBe("fake-large");
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("team_update reportsTo asks, then applies or clears to the owner", async () => {
    const v = await world();
    try {
      const seen = new Set<string>();
      const { employee: other } = await v.w.user.request<{
        employee: Employee;
      }>("employees.create", { name: "Bea", role: "ops" });
      /* A hire while this session holds the seat reports to them (D-#778).
         Point Bea at the owner first, or the caller reporting to her cycles. */
      await v.w.user.request("employees.update", {
        id: other.id,
        reportsTo: null,
      });

      const call = v.client.teamUpdate({ reportsTo: other.id });
      const ask = await v.nextAsk(seen);
      seen.add(ask.id);
      if (ask.request.kind !== "approval") throw new Error("not approval");
      expect(ask.request.description ?? "").toContain(other.id);
      const mid = (await v.employees()).find(
        (e) => e.id === v.binding.employeeId,
      );
      expect(mid?.reportsTo).toBeUndefined();
      await v.answer(ask.id, "once");
      expect((await call).employee.reportsTo).toBe(other.id);

      const denied = v.client.teamUpdate({ reportsTo: null });
      const ask2 = await v.nextAsk(seen);
      seen.add(ask2.id);
      if (ask2.request.kind !== "approval") throw new Error("not approval");
      expect(ask2.request.description ?? "").toContain("owner");
      await v.answer(ask2.id, "deny");
      await expect(denied).rejects.toThrow();
      expect(
        (await v.employees()).find((e) => e.id === v.binding.employeeId)
          ?.reportsTo,
      ).toBe(other.id);

      const clear = v.client.teamUpdate({ reportsTo: null });
      const ask3 = await v.nextAsk(seen);
      seen.add(ask3.id);
      await v.answer(ask3.id, "once");
      expect((await clear).employee.reportsTo).toBeUndefined();
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("team_update rejects a bad reportsTo before any ask or engine write", async () => {
    const v = await world();
    try {
      const engineWrites = () =>
        v.sent.filter(
          (s) => s.method === "agents.update" || s.method === "asks.open",
        );

      await expect(
        v.client.teamUpdate({
          reportsTo: v.binding.employeeId,
          model: "fake-large",
        }),
      ).rejects.toThrow(/itself/);
      expect(await v.asks("open")).toEqual([]);
      expect(engineWrites()).toEqual([]);

      await expect(
        v.client.teamUpdate({ reportsTo: "emp_missing" }),
      ).rejects.toThrow(/not found/);
      expect(await v.asks("open")).toEqual([]);
      expect(engineWrites()).toEqual([]);

      const { employee: other } = await v.w.user.request<{
        employee: Employee;
      }>("employees.create", { name: "Bea", role: "ops" });
      await v.w.user.request("employees.update", {
        id: other.id,
        reportsTo: v.binding.employeeId,
      });
      await expect(
        v.client.teamUpdate({
          reportsTo: other.id,
          instructions: "should not land",
        }),
      ).rejects.toThrow(/cycle/);
      expect(await v.asks("open")).toEqual([]);
      expect(engineWrites()).toEqual([]);
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("folder_add: approve lands the recents row, decline doesn't", async () => {
    const v = await world();
    try {
      const seen = new Set<string>();
      const folders = async () => {
        const { folders } = await v.w.user.request<{
          folders: { path: string }[];
        }>("folders.list", {});
        return folders.map((f) => f.path);
      };
      const before = await folders();

      const call = v.client.folderAdd({ path: "~/work/app" });
      const ask = await v.nextAsk(seen);
      seen.add(ask.id);
      expect(await folders()).toEqual(before);
      await v.answer(ask.id, "once");
      const res = await call;
      expect(res.folder.path).toBe("~/work/app");
      expect(await folders()).toContain("~/work/app");

      const call2 = v.client.folderAdd({ path: "~/work/nope" });
      const ask2 = await v.nextAsk(seen);
      seen.add(ask2.id);
      await v.answer(ask2.id, "deny");
      await expect(call2).rejects.toThrow();
      expect(await folders()).not.toContain("~/work/nope");
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("a gateway ask is always asked — even when the thread's access is Full", async () => {
    const v = await world();
    try {
      await v.w.user.request("conversations.update", {
        conversationId: v.binding.conversationId,
        access: "full",
      });
      const seen = new Set<string>();
      const call = v.client.folderAdd({ path: "~/work/full" });
      /* Full access does NOT auto-approve company changes: the card still
         waits for the user. */
      const ask = await v.nextAsk(seen);
      seen.add(ask.id);
      const { asks } = await v.w.user.request<{ asks: Ask[] }>("asks.list", {
        conversationId: v.binding.conversationId,
      });
      expect(ask.state).toBe("open");
      expect(asks.find((a) => a.id === ask.id)?.outcome).toBeUndefined();
      await v.answer(ask.id, "once");
      await expect(call).resolves.toMatchObject({
        folder: { path: "~/work/full" },
      });
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("ask posts why, ifYes and ifNo, and returns the chosen answer", async () => {
    const v = await world();
    try {
      const seen = new Set((await v.asks("open")).map((a) => a.id));
      const before = (await v.employees()).length;
      const call = v.client.ask({
        question: "Ship the paywall?",
        why: "The hooks scored best",
        ifYes: "The ads start today",
        ifNo: "The ticket closes",
        options: ["Keep it", "Ship it"],
      });
      const ask = await v.nextAsk(seen);
      expect(ask.why).toBe("The hooks scored best");
      expect(ask.ifYes).toBe("The ads start today");
      expect(ask.ifNo).toBe("The ticket closes");
      expect(ask.request).toMatchObject({
        kind: "question",
        question: "Ship the paywall?",
      });
      expect((await v.employees()).length).toBe(before);
      await v.w.user.request("asks.respond", {
        askId: ask.id,
        outcome: "answer",
        answer: "o1",
      });
      await expect(call).resolves.toEqual({
        outcome: "yes",
        answer: "Ship it",
      });
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });

  it("ask without options is a once/deny approval, and deny declines", async () => {
    const v = await world();
    try {
      const seen = new Set((await v.asks("open")).map((a) => a.id));
      const call = v.client.ask({
        question: "Delete the draft",
        why: "It is stale",
      });
      const ask = await v.nextAsk(seen);
      expect(ask.why).toBe("It is stale");
      expect(ask.request).toMatchObject({
        kind: "approval",
        command: "Delete the draft",
        options: ["once", "deny"],
      });
      await v.answer(ask.id, "deny");
      await expect(call).rejects.toThrow(/declined/);
    } finally {
      v.gw.server.close();
      await v.scope.close();
      await v.w.cleanup();
    }
  });
});
