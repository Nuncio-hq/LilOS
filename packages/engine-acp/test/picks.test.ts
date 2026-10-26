import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Harness } from "@lilos/engine-conformance";
import { describe, expect, test } from "vitest";
import { AcpEngine } from "../src/engine.js";
import { connectAcp } from "../src/transport.js";

/**
 * D-#846 — a model/effort/fast pick reaches the agent only through config
 * options the live session advertised (`session/set_config_option`), and a
 * pick the session cannot take is skipped with a `session.note` — never a
 * silent drop, never a failed session.start. The agent under test is the
 * deterministic fake (no LLM); its env knobs simulate an agent that
 * advertises fewer options or forgets config across `session/load`.
 */
const FAKE_AGENT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "fake-agent.ts",
);

const make = (env?: Record<string, string>) => {
  const engine = new AcpEngine({
    name: "engine-acp-fake",
    command: ["bun", FAKE_AGENT],
    ...(env ? { env } : {}),
    clientInfo: { name: "lilos-picks-test", version: "0" },
  });
  return new Harness(connectAcp(engine));
};

const notes = (h: Harness, sessionId: string) =>
  h.events.filter(
    (e) => e.sessionId === sessionId && e.type === "session.note",
  );

const started = (h: Harness, sessionId: string) =>
  h.events.filter(
    (e) => e.sessionId === sessionId && e.type === "session.started",
  );

describe("per-job model/effort picks reach the agent (D-#846)", () => {
  test("session.start writes an advertised model + effort + fast pick", async () => {
    const h = make();
    try {
      const { sessionId } = (await h.request("session.start", {
        agent: "devin",
        cwd: "/tmp/lilos-picks",
        model: "fake-smart",
        effort: "high",
        fast: true,
      })) as { sessionId: string };
      const ev = await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "session.started"),
      );
      expect(ev.payload).toMatchObject({
        model: "fake-smart",
        effort: "high",
        fast: true,
      });
      expect(notes(h, sessionId)).toHaveLength(0);
      /* The pick read back through the catalog — models.list's default is
         the option's live currentValue. */
      const list = (await h.request("models.list")) as {
        default?: string;
      };
      expect(list.default).toBe("fake-smart");
    } finally {
      h.close();
    }
  }, 30_000);

  test("a pick the session doesn't advertise skips with a visible note", async () => {
    const h = make();
    try {
      /* Start-time skips ride the result — an event emitted inside
         session.start would race the host's binding registration. */
      const res = (await h.request("session.start", {
        agent: "devin",
        cwd: "/tmp/lilos-picks",
        model: "no-such-model",
        effort: "xhigh",
      })) as { sessionId: string; notes?: string[] };
      const ev = await h.waitEvent(
        h.forSession(res.sessionId, (e) => e.type === "session.started"),
      );
      /* The session still starts — on the agent's own defaults. */
      expect(ev.payload).toMatchObject({
        model: "fake-fast",
        effort: "medium",
      });
      const texts = res.notes ?? [];
      expect(
        texts.some((t) => t.includes('"no-such-model"')),
        `model skip note, got ${JSON.stringify(texts)}`,
      ).toBe(true);
      expect(
        texts.some((t) => t.includes('"xhigh"')),
        `effort skip note, got ${JSON.stringify(texts)}`,
      ).toBe(true);
    } finally {
      h.close();
    }
  }, 30_000);

  test("an agent that advertises no model option takes effort but skips model", async () => {
    const h = make({ LILOS_FAKE_CONFIG: "thought_level,speed" });
    try {
      const res = (await h.request("session.start", {
        agent: "devin",
        cwd: "/tmp/lilos-picks",
        model: "anything",
        effort: "high",
      })) as { sessionId: string; notes?: string[] };
      const ev = await h.waitEvent(
        h.forSession(res.sessionId, (e) => e.type === "session.started"),
      );
      expect(ev.payload).toMatchObject({ effort: "high" });
      expect((ev.payload as { model?: string }).model).toBeUndefined();
      expect((res.notes ?? []).some((t) => t.includes('"anything"'))).toBe(
        true,
      );
    } finally {
      h.close();
    }
  }, 30_000);

  test("session.setModel applies the pick and the next turn carries it", async () => {
    const h = make();
    try {
      const { sessionId } = (await h.request("session.start", {
        agent: "devin",
        cwd: "/tmp/lilos-picks",
      })) as { sessionId: string };
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "session.started"),
      );
      const ack = (await h.request("session.setModel", {
        sessionId,
        model: "fake-deep",
        effort: "low",
      })) as { model: string; effort?: string };
      expect(ack.model).toBe("fake-deep");
      expect(ack.effort).toBe("low");
      const turn = h.request("prompt", {
        sessionId,
        content: [{ type: "text", text: "hi" }],
      });
      const t = await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.started"),
      );
      expect(t.payload).toMatchObject({ model: "fake-deep" });
      await turn;
    } finally {
      h.close();
    }
  }, 30_000);

  test("session.setModel validates the whole pick before any write", async () => {
    const h = make();
    try {
      const { sessionId } = (await h.request("session.start", {
        agent: "devin",
        cwd: "/tmp/lilos-picks",
      })) as { sessionId: string };
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "session.started"),
      );
      /* A bad effort must not half-apply a good model. */
      const code = await h
        .request("session.setModel", {
          sessionId,
          model: "fake-deep",
          effort: "bogus",
        })
        .then(
          () => 0,
          (e) => (e as { code?: number }).code ?? 0,
        );
      expect(code).toBe(-32005);
      const snap = (await h.request("events.since", {
        sessionId,
        after: 0,
      })) as { snapshot: { model?: string; effort?: string } };
      expect(snap.snapshot.model).toBe("fake-fast");
      expect(snap.snapshot.effort).toBe("medium");
    } finally {
      h.close();
    }
  }, 30_000);

  test("suspend/resume re-applies the session's pick on an agent that resets", async () => {
    const h = make({ LILOS_FAKE_RESET_ON_LOAD: "1" });
    try {
      const { sessionId } = (await h.request("session.start", {
        agent: "devin",
        cwd: "/tmp/lilos-picks",
        model: "fake-smart",
        effort: "high",
      })) as { sessionId: string };
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "session.started"),
      );
      await h.request("session.suspend", { sessionId });
      const turn = h.request("prompt", {
        sessionId,
        content: [{ type: "text", text: "hi again" }],
      });
      await turn;
      const starts = started(h, sessionId);
      expect(starts.length).toBeGreaterThanOrEqual(2);
      /* The reloaded session's config fell back to defaults; the engine
         re-wrote the pick before announcing the session. */
      expect(starts.at(-1)?.payload).toMatchObject({
        model: "fake-smart",
        effort: "high",
      });
    } finally {
      h.close();
    }
  }, 30_000);
});
