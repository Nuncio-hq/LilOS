import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Harness } from "@lilos/engine-conformance";
import { describe, expect, test } from "vitest";
import { AcpEngine } from "../src/engine.js";
import { connectAcp } from "../src/transport.js";
import { claudeSpec } from "../shims/claude.js";
import { ACP_AGENTS } from "../shims/registry.js";

/**
 * D-#866 — the Claude Code shim's recipe: Anthropic's official adapter
 * binary, ACP v1 pinned by env, provider-auth vars dropped from the
 * inherited env so the user's own Claude login carries the session, and
 * LilOS access levels mapped onto the adapter's permission modes. The
 * env-drop leg runs against the deterministic fake — no LLM in CI.
 */

const MODES = (...ids: string[]) => ids.map((id) => ({ id }));

describe("the claude registry entry (D-#866)", () => {
  test("ACP_AGENTS names it; the recipe is the official adapter", () => {
    expect(ACP_AGENTS.claude).toBe(claudeSpec);
    expect(claudeSpec.command).toEqual(["claude-agent-acp"]);
    expect(claudeSpec.verify?.args).toEqual(["--version"]);
    expect(claudeSpec.agent?.name).toBe("Claude Code");
    expect(claudeSpec.agent?.detail).toMatchObject({ isDefault: true });
  });

  test("ACP stays pinned to v1 (D-#764)", () => {
    /* 0.96's knob and the earlier experimental flag both say v1 — an
       adapter serving the v2 preview can never be negotiated. */
    expect(claudeSpec.env).toMatchObject({
      CLAUDE_AGENT_ACP_PROTOCOL: "v1",
      CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: "0",
    });
  });

  test("provider-auth env never reaches the adapter", () => {
    /* Every var the adapter itself counts as backend routing — a stray
       one in the harness env would reroute the session off the Max login
       (API billing, a router, Bedrock/Vertex). */
    const drop = new Set(claudeSpec.dropEnv);
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ]) {
      expect(drop, `${name} must be dropped`).toContain(name);
    }
  });

  test("access maps onto the adapter's permission modes", () => {
    const all = MODES(
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "bypassPermissions",
    );
    /* ask: asks ride session/request_permission to LilOS — the manual
       mode, never `auto` (Claude deciding on its own hides asks). */
    expect(claudeSpec.modeForAccess?.("ask", all)).toBe("default");
    /* full: unattended — bypass when offered, then auto/acceptEdits. */
    expect(claudeSpec.modeForAccess?.("full", all)).toBe(
      "bypassPermissions",
    );
    expect(
      claudeSpec.modeForAccess?.(
        "full",
        MODES("default", "acceptEdits", "plan", "auto"),
      ),
    ).toBe("auto");
    expect(
      claudeSpec.modeForAccess?.("full", MODES("default", "acceptEdits")),
    ).toBe("acceptEdits");
    /* Degenerate mode lists still answer safely. */
    expect(
      claudeSpec.modeForAccess?.("ask", MODES("something-else")),
    ).toBe("something-else");
    expect(claudeSpec.modeForAccess?.("full", [])).toBeUndefined();
  });
});

/* The dropEnv mechanism the shim relies on, through the real spawn path:
   the fake agent echoes its own env on `env NAME`. */
const FAKE_AGENT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "fake-agent.ts",
);

const envOf = async (h: Harness, sessionId: string, name: string) => {
  await h.request("prompt", {
    sessionId,
    content: [{ type: "text", text: `env ${name}` }],
  });
  const ev = h.events
    .filter(
      (e) => e.sessionId === sessionId && e.type === "tool.completed",
    )
    .at(-1);
  return String(ev?.payload.output ?? "");
};

describe("shim env policy reaches the agent child (D-#866)", () => {
  test("dropEnv removes inherited vars; explicit env grants still win", async () => {
    process.env.ACP_TEST_ROUTER = "router.example.invalid";
    process.env.ACP_TEST_GRANT = "granted";
    const engine = new AcpEngine({
      name: "engine-acp-fake",
      command: ["bun", FAKE_AGENT],
      env: { ACP_TEST_GRANT: "granted", ACP_TEST_READD: "re-added" },
      dropEnv: ["ACP_TEST_ROUTER", "ACP_TEST_READD"],
    });
    const h = new Harness(connectAcp(engine));
    try {
      const { sessionId } = (await h.request("session.start", {
        agent: "t",
        cwd: process.cwd(),
      })) as { sessionId: string };
      /* Inherited name dropped… */
      expect(await envOf(h, sessionId, "ACP_TEST_ROUTER")).toBe("<unset>");
      /* …explicit env grant lands… */
      expect(await envOf(h, sessionId, "ACP_TEST_GRANT")).toBe("granted");
      /* …and a grant naming a dropped var still wins (D-#412 ordering:
         drop applies to the inherited env, never to explicit grants). */
      expect(await envOf(h, sessionId, "ACP_TEST_READD")).toBe("re-added");
    } finally {
      h.close();
      delete process.env.ACP_TEST_ROUTER;
      delete process.env.ACP_TEST_GRANT;
    }
  }, 30_000);
});
