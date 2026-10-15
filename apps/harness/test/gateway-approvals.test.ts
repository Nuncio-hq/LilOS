import type {
  AppMessage,
  Ask,
  Conversation,
  Employee,
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
    const { conversation } = await w.user.request<{
      conversation: Conversation;
    }>("conversations.open", { channelId: channel.id, text: "hi" });
    const binding = {
      employeeId: employee.id,
      channelId: channel.id,
      conversationId: conversation.id,
    };
    const appOps = createAppOps({
      relay: w.harnessRelay,
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
});
