import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Harness, SUITES } from "@lilos/engine-conformance";
import { describe, test } from "vitest";
import { AcpEngine } from "../src/engine.js";
import { connectAcp } from "../src/transport.js";

/**
 * D-#764 — the generic ACP engine through engine-conformance. The agent is
 * `scripts/fake-agent.ts`: a deterministic ACP speaker over stdio, never an
 * LLM, so CI runs the whole seam end to end. Suites run are exactly the
 * capabilities an ACP agent can honestly declare — proposals-free plan
 * frames, no rewind/compact/workspace-move (ACP has none), no LilOS-side
 * agents/jobs/subagents. What remains is the whole shared mapping on the
 * wire: turns, asks, steers, models, MCP attach, titles.
 */
const FAKE_AGENT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "fake-agent.ts",
);

const make = () => {
  const engine = new AcpEngine({
    name: "engine-acp-fake",
    command: ["bun", FAKE_AGENT],
    clientInfo: { name: "lilos-conformance", version: "0" },
    modeForAccess: (access) => (access === "ask" ? "ask" : "code"),
  });
  return new Harness(connectAcp(engine));
};

/* Capabilities the fake ACP agent declares (and the engine maps). ACP has
   no agents/jobs/rewind/compact/move/commands surface — those suites stay
   out the same way the capability rows stay out of describe(). */
const RUN = new Set([
  "core",
  "steer",
  "image_prompt",
  "mcp_servers",
  "models",
  "session_meta",
  "plan",
]);

for (const suite of SUITES.filter(
  (s) => s.implemented && RUN.has(s.capability),
)) {
  /* ACP has no plan-PROPOSAL surface — `detail.proposals:false` is the
     honest row, so the proposal-approval scenarios are the ones the suite
     itself says only proposal-capable engines run. */
  const scenarios =
    suite.capability === "plan"
      ? suite.scenarios.filter((s) => !s.id.includes("proposal"))
      : suite.scenarios;
  describe(`acp engine vs fake agent — ${suite.capability}`, () => {
    for (const s of scenarios) {
      test(s.id, async () => {
        const h = make();
        try {
          await s.run(h);
        } finally {
          h.close();
        }
      });
    }
  });
}
