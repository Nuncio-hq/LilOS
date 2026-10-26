import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Harness } from "@lilos/engine-conformance";
import { describe, expect, test } from "vitest";
import { claudeSpec } from "../shims/claude.js";
import { ACP_AGENTS } from "../shims/registry.js";
import { AcpEngine } from "../src/engine.js";
import { connectAcp } from "../src/transport.js";

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

  test("the registry's npx channel is the exact pinned package", () => {
    /* D-#866: no manual install — an absent adapter is provisioned from
       this exact pin into the LilOS cache, never a floating version. */
    expect(claudeSpec.provision).toEqual({
      npm: {
        package: "@agentclientprotocol/claude-agent-acp",
        version: "0.96.0",
        bin: "claude-agent-acp",
      },
    });
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
    expect(claudeSpec.modeForAccess?.("full", all)).toBe("bypassPermissions");
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
    expect(claudeSpec.modeForAccess?.("ask", MODES("something-else"))).toBe(
      "something-else",
    );
    expect(claudeSpec.modeForAccess?.("full", [])).toBeUndefined();
  });

  test("ask sessions are born without the skip flag (D-#866)", () => {
    /* The spawned `claude` binds its permission gating to the mode in its
       argv — a set_mode after session/new cannot un-shadow it (proven
       against adapter 0.96.0: born-bypass sessions kept auto-approving
       after set_mode 'default'). `sessionMeta` opts `ask` out at
       creation so the adapter clamps the initial mode itself. */
    expect(
      claudeSpec.sessionMeta?.({ agent: "t", cwd: "/x", access: "ask" }),
    ).toEqual({
      claudeCode: { options: { allowDangerouslySkipPermissions: false } },
    });
    /* `full` and hinted-less starts pass nothing — bypass stays allowed
       and the mode lands via set_mode. */
    expect(
      claudeSpec.sessionMeta?.({ agent: "t", cwd: "/x", access: "full" }),
    ).toEqual({});
    expect(claudeSpec.sessionMeta?.({ agent: "t", cwd: "/x" })).toEqual({});
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
    .filter((e) => e.sessionId === sessionId && e.type === "tool.completed")
    .at(-1);
  return String((ev?.payload as { output?: string } | undefined)?.output ?? "");
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

  test("sessionMeta reaches session/new AND the resume re-create", async () => {
    /* The fake agent echoes the `_meta` it received on a `meta` prompt —
       proves the shim's meta crosses the wire on start and again on the
       suspend→loadSession re-create (an `ask` session must come back
       without the skip flag too). */
    const engine = new AcpEngine({
      name: "engine-acp-meta-probe",
      command: ["bun", FAKE_AGENT],
      sessionMeta: (p) => (p.access === "ask" ? { flag: "no-bypass" } : {}),
    });
    const h = new Harness(connectAcp(engine));
    const metaOf = async (sessionId: string) => {
      await h.request("prompt", {
        sessionId,
        content: [{ type: "text", text: "meta" }],
      });
      const ev = h.events
        .filter((e) => e.sessionId === sessionId && e.type === "tool.completed")
        .at(-1);
      return (ev?.payload as { output?: string } | undefined)?.output;
    };
    try {
      const { sessionId } = (await h.request("session.start", {
        agent: "t",
        cwd: process.cwd(),
        access: "ask",
      })) as { sessionId: string };
      expect(JSON.parse((await metaOf(sessionId)) ?? "null")).toEqual({
        flag: "no-bypass",
      });
      await h.request("session.suspend", { sessionId });
      expect(JSON.parse((await metaOf(sessionId)) ?? "null")).toEqual({
        flag: "no-bypass",
      });
    } finally {
      h.close();
    }
  }, 30_000);

  test("the catalog probe session carries the ask meta too (D-#866 r4)", async () => {
    /* The scratch probe still spawns the agent's child — it must not be
       born under the user's bypassPermissions default either. The fake
       logs every session/new _meta; the FIRST line is the probe's. */
    const dir = mkdtempSync(join(tmpdir(), "acp-meta-"));
    const log = join(dir, "meta.log");
    const engine = new AcpEngine({
      name: "engine-acp-meta-probe",
      command: ["bun", FAKE_AGENT],
      env: { LILOS_FAKE_META_LOG: log },
      sessionMeta: claudeSpec.sessionMeta,
    });
    const h = new Harness(connectAcp(engine));
    try {
      await h.request("describe", {});
      /* The probe fires on connection open — bounded wait for its line. */
      for (let i = 0; i < 50 && !existsSync(log); i++)
        await new Promise((r) => setTimeout(r, 100));
      const first = readFileSync(log, "utf8").trim().split("\n")[0];
      expect(JSON.parse(first)).toEqual({
        op: "new",
        meta: {
          claudeCode: { options: { allowDangerouslySkipPermissions: false } },
        },
      });
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
