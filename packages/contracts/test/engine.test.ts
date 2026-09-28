import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  ENGINE_EVENT_TYPES,
  ENGINE_METHODS,
  ENGINE_PROTOCOL,
  EngineEvent,
  PromptParams,
  SessionStartParams,
} from "../src/engine/index.js";

const ENGINE_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "engine",
);

describe("engine wire contract", () => {
  test("protocol identity is name+version pinned", () => {
    expect(ENGINE_PROTOCOL).toEqual({ name: "lilos-engine", version: 1 });
  });

  test("core methods are all declared with params+result", () => {
    expect(Object.keys(ENGINE_METHODS)).toEqual([
      "describe",
      "session.start",
      "prompt",
      "interrupt",
      "request.respond",
      "events.since",
      "session.stop",
      "session.steer",
      "agents.list",
      "agents.describe",
      "agents.create",
      "models.list",
      "session.setModel",
      "session.setTitle",
      "session.setHidden",
    ]);
    for (const [name, m] of Object.entries(ENGINE_METHODS)) {
      expect(m.doc.length, name).toBeGreaterThan(0);
      expect(m.params.safeParse({}).success !== undefined, name).toBe(true);
      expect(m.result, name).toBeDefined();
    }
    expect(ENGINE_METHODS["session.steer"].capability).toBe("steer");
    expect(ENGINE_METHODS["agents.list"].capability).toBe("agents");
    expect(ENGINE_METHODS["agents.describe"].capability).toBe("agents");
    expect(ENGINE_METHODS["agents.create"].capability).toBe("agents");
    expect(ENGINE_METHODS["models.list"].capability).toBe("models");
    expect(ENGINE_METHODS["session.setModel"].capability).toBe("models");
    expect(ENGINE_METHODS["session.setTitle"].capability).toBe("session_meta");
    expect(ENGINE_METHODS["session.setHidden"].capability).toBe("session_meta");
  });

  test("AC-4 the protocol has no profile-delete method", () => {
    // LilOS never deletes an engine profile; firing only removes the LilOS
    // employee record. Nothing in the method table may delete/destroy agents.
    const killers = Object.keys(ENGINE_METHODS).filter((n) =>
      /delete|remove|destroy|unregister/i.test(n),
    );
    expect(killers).toEqual([]);
  });

  test("events v1 registry covers the replayable surface", () => {
    expect(ENGINE_EVENT_TYPES).toEqual([
      "session.started",
      "session.state",
      "session.note",
      "turn.started",
      "turn.delta",
      "tool.started",
      "tool.completed",
      "request.opened",
      "request.resolved",
      "session.ref.changed",
      "turn.steered",
      "turn.completed",
    ]);
  });

  test("params are strict and carry the #18 additions", () => {
    const start = SessionStartParams.parse({
      agent: "fake",
      cwd: "/tmp",
      mcpServers: [{ name: "lilos", command: "lilos-mcp", args: [], env: [] }],
    });
    expect(start.mcpServers).toHaveLength(1);
    const prompt = PromptParams.parse({
      sessionId: "s1",
      content: [
        { type: "text", text: "hi" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
    });
    expect(prompt.content).toHaveLength(2);
    expect(
      SessionStartParams.safeParse({ agent: "x", cwd: "/t", heresy: 1 })
        .success,
    ).toBe(false);
  });

  test("event frames validate by discriminated union", () => {
    const frame = {
      seq: 7,
      sessionId: "s1",
      type: "request.opened",
      payload: {
        turnId: "t1",
        requestId: "r1",
        request: {
          kind: "approval",
          command: "rm -rf /tmp/x",
          options: ["once", "deny"],
        },
      },
    };
    const ev = EngineEvent.parse(frame);
    if (ev.type !== "request.opened")
      throw new Error("expected request.opened");
    expect(ev.payload.requestId).toBe("r1");
    expect(EngineEvent.safeParse({ ...frame, type: "nope" }).success).toBe(
      false,
    );
    expect(EngineEvent.safeParse({ ...frame, seq: 0 }).success).toBe(false);
  });

  // The generated-schema stale checks moved to schema-gen.test.ts with the
  // unified generator (#42) — one check covers every registry.

  test("AC-4 the seam carries no vendor names", () => {
    const root = join(ENGINE_SRC, "..", "..", "..");
    const needle = /h[e]rmes/i; // self-excluding pattern — this file must pass too
    const dirs = ["contracts", "engine-fake", "engine-conformance"]
      .map((p) => join(root, p))
      .filter((p) => statSync(p, { throwIfNoEntry: false }));
    expect(dirs.length).toBeGreaterThan(0);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) {
          if (e !== "node_modules") walk(p);
        } else if (
          /\.(ts|json|py|md)$/.test(e) &&
          needle.test(readFileSync(p, "utf8"))
        ) {
          hits.push(p);
        }
      }
    };
    for (const d of dirs) walk(d);
    expect(hits).toEqual([]);
  });
});
