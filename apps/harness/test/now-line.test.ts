import type { RelayClient } from "@lilos/client-runtime";
import type { Ask, Employee } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { openDmConversation, setupWorld, waitFor } from "./helpers";

/**
 * #422 — the DM header's live "now:" line. The harness derives it from
 * engine events and pushes `employees.update {now}` so every surface
 * renders `role · now: <step>`: "thinking" at turn start,
 * "<tool> <target>" on each scripted step, a wait line while an ask is
 * open, "" when the turn ends — and a stale line a dead harness left
 * behind is swept on (re)register.
 */

const employeeNow = async (
  user: RelayClient,
  employeeId: string,
): Promise<string | undefined> => {
  const { employees } = await user.request<{ employees: Employee[] }>(
    "employees.list",
    {},
  );
  return employees.find((e) => e.id === employeeId)?.now;
};

const nowBecomes = (user: RelayClient, employeeId: string, want: string) =>
  waitFor(
    async () =>
      (await employeeNow(user, employeeId)) === want ? want : undefined,
    `now === "${want}"`,
    20_000,
  );

const openConversation = (user: RelayClient, channelId: string, text: string) =>
  user.request<{ conversation: { id: string } }>("conversations.open", {
    channelId,
    text,
  });

describe("employee now-line (#422)", () => {
  it("AC-1: 'thinking' at turn start, 'now: <tool> <target>' on the scripted step, cleared at turn end", {
    timeout: 30_000,
  }, async () => {
    const w = await setupWorld({ tick: 150 });
    try {
      const { employee, channel } = await openDmConversation(w.user);
      expect(await employeeNow(w.user, employee.id)).toBe("");
      // recall: — one reasoning line, one step (terminal history --turns).
      await openConversation(w.user, channel.id, "recall: earlier turns");
      await nowBecomes(w.user, employee.id, "thinking");
      await nowBecomes(w.user, employee.id, "terminal history --turns");
      await nowBecomes(w.user, employee.id, "");
    } finally {
      await w.cleanup();
    }
  });

  it("AC-1: 'waiting on your approval' while an ask is open, back to the step line once answered", {
    timeout: 30_000,
  }, async () => {
    const w = await setupWorld({ tick: 150 });
    try {
      const { employee, channel } = await openDmConversation(w.user);
      // EDIT_ASK script: search_files → patch (approval) → write_file
      // (approval) → terminal test → terminal git commit (approval).
      const { conversation } = await openConversation(
        w.user,
        channel.id,
        "Add a footer to the page",
      );
      await nowBecomes(w.user, employee.id, "waiting on your approval");

      const answer = async () => {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        for (const ask of asks) {
          await w.user
            .request("asks.respond", { askId: ask.id, outcome: "once" })
            .catch(() => {});
        }
        return asks.length > 0;
      };
      await answer();
      // The wait ended — the running step's line is back on the wire.
      await waitFor(async () => {
        const now = await employeeNow(w.user, employee.id);
        return now && !now.startsWith("waiting") ? now : undefined;
      }, "step line after the answer");
      // Answer every remaining ask; the last one lets the turn complete.
      await waitFor(
        async () => {
          await answer();
          return (await employeeNow(w.user, employee.id)) === ""
            ? true
            : undefined;
        },
        "now cleared after the last ask",
        20_000,
      );
    } finally {
      await w.cleanup();
    }
  });

  it("concurrent sessions: the freshest step wins, then falls back, then clears", {
    timeout: 30_000,
  }, async () => {
    const w = await setupWorld({ tick: 150 });
    try {
      const { employee, channel } = await openDmConversation(w.user);
      // A held turn parks at "thinking" until it is interrupted.
      const { conversation: held } = await openConversation(
        w.user,
        channel.id,
        "LILOS_TURN_HOLD hold this",
      );
      await nowBecomes(w.user, employee.id, "thinking");
      // A second session on the same DM: its live step outranks the hold.
      await openConversation(w.user, channel.id, "recall: again");
      await nowBecomes(w.user, employee.id, "terminal history --turns");
      // The second turn ended — the held session's line is what remains.
      await nowBecomes(w.user, employee.id, "thinking");
      await w.user.request("turns.interrupt", {
        conversationId: held.id,
      });
      await nowBecomes(w.user, employee.id, "");
    } finally {
      await w.cleanup();
    }
  });

  it("a stale now left by a dead harness is swept on (re)register", {
    timeout: 30_000,
  }, async () => {
    const w = await setupWorld({
      engine: null,
      captureSockets: true,
      reconnectMinDelayMs: 20,
    });
    try {
      const { employee } = await openDmConversation(w.user);
      await w.user.request("employees.update", {
        id: employee.id,
        now: "write_file README.md",
      });
      expect(await employeeNow(w.user, employee.id)).toBe(
        "write_file README.md",
      );
      // Bounce the harness socket: re-register sweeps derived now-state.
      for (const socket of w.relaySockets.splice(0)) socket.close();
      await nowBecomes(w.user, employee.id, "");
    } finally {
      await w.cleanup();
    }
  });
});
