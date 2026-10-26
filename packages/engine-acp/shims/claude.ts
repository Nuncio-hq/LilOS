import type { AcpLaunchSpec } from "../src/launch.js";

/**
 * D-#866 — the Claude Code shim: Anthropic's official ACP adapter
 * `claude-agent-acp` (ACP registry `claude-acp`, npm
 * `@agentclientprotocol/claude-agent-acp`), kept out of src/ like every
 * agent recipe. An installed adapter on PATH wins; otherwise the pinned
 * `provision.npm` distribution is fetched once into the LilOS cache
 * (`~/.lilos/acp`) and run by a local JS runtime — no manual install.
 *
 * The adapter wraps the Claude Agent SDK's own native `claude` binary —
 * the user's own Claude Code login (keychain) carries the session, so
 * LilOS stores no credentials. Two env rules keep that true:
 *
 * - `dropEnv`: every var the adapter itself counts as backend routing
 *   (its PROVIDER_ROUTING_ENV_VARS) is removed from the inherited env, so
 *   a stray `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` or a Bedrock/Vertex
 *   switch in the harness env can never reroute a session off the Max
 *   login. An explicit `env` grant still wins (D-#412 ordering).
 * - `env`: ACP stays on v1 (D-#764). Adapter ≥0.96 also serves the v2
 *   preview — `CLAUDE_AGENT_ACP_PROTOCOL=v1` is its knob;
 *   `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=0` is the older one, set for
 *   whatever version is installed.
 *
 * Modes the adapter advertises: `default` (asks before changes),
 * `acceptEdits`, `plan`, `auto`, and `bypassPermissions` (only when the
 * user's settings allow bypass). LilOS `ask` maps to `default` —
 * permission asks ride session/request_permission into LilOS; `auto`
 * would let Claude decide alone and hide asks from Oscar. `full` prefers
 * `bypassPermissions`, then `auto`, then `acceptEdits`.
 */
export const claudeSpec: AcpLaunchSpec = {
  id: "claude",
  command: ["claude-agent-acp"],
  verify: { args: ["--version"], timeoutMs: 15_000 },
  /* Registry `npx` channel (D-#866): exact pin, provisioned on first
     use into the LilOS cache when no installed adapter is found. */
  provision: {
    npm: {
      package: "@agentclientprotocol/claude-agent-acp",
      version: "0.96.0",
      bin: "claude-agent-acp",
    },
  },
  /* The roster seed — what "Claude Code" looks like to Oscar before he
     ever opens a thread; the harness's first-run hire reads isDefault. */
  agent: {
    id: "claude",
    name: "Claude Code",
    description:
      "Claude Code over ACP — Anthropic's official adapter, signed in locally.",
    detail: { isDefault: true },
  },
  env: {
    CLAUDE_AGENT_ACP_PROTOCOL: "v1",
    CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: "0",
  },
  dropEnv: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLOUD_ML_REGION",
    "AWS_REGION",
  ],
  modeForAccess: (access, modes) => {
    const ids = new Set(modes.map((m) => m.id));
    const prefer =
      access === "ask"
        ? ["default", "acceptEdits"]
        : ["bypassPermissions", "auto", "acceptEdits"];
    return prefer.find((id) => ids.has(id)) ?? modes[0]?.id ?? undefined;
  },
};
