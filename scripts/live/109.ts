/**
 * Issue #109 live leg — engine slash commands + skills on a REAL Hermes:
 * `commands.list` answers under 150ms with built-in commands AND a
 * folder-local skill from the session's cwd, `commands.exec` runs a
 * built-in (output) and a skill (prompt expansion) like the TUI.
 *
 *   bun scripts/live/109.ts
 *
 * HOME/HERMES_HOME isolation is the caller's job (109.sh); nothing here
 * kills or touches anything it did not spawn.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Relative imports: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — each package resolves its own deps internally.
import { HermesEngine } from "../../packages/engine-hermes/src/engine";
import { HermesGateway } from "../../packages/engine-hermes/src/gateway";
import { startHermesServe } from "../../packages/engine-hermes/src/serve";
import { connectInMemory } from "../../packages/engine-hermes/src/transport";
import { cleanup, startStub } from "./lib/helpers";

const provider = process.env.HERMES_PROVIDER ?? "lilos-stub";
const model = process.env.HERMES_MODEL ?? "stub-model";
const workdir = mkdtempSync(join(tmpdir(), "lilos109-"));
/* Project skills resolve through find_project_root — a `.git` marker makes
   the scratch dir a project, same as any real checkout the user works in. */
mkdirSync(join(workdir, ".git"));
const HERMES_HOME = process.env.HERMES_HOME ?? join(workdir, "hermes-home");
const repoRoot =
  process.env.LILOS_REPO_ROOT ??
  dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";
void repoRoot;

/* The folder-local skill: hermes loads `<cwd>/.agents/skills/` (and
   `.hermes/skills/`) as project skills — complete.slash lists them for the
   session's cwd, which is the whole point of the session-scoped call. */
const SKILL_NAME = "lilos-live-skill";
mkdirSync(join(workdir, ".agents", "skills", SKILL_NAME), {
  recursive: true,
});
writeFileSync(
  join(workdir, ".agents", "skills", SKILL_NAME, "SKILL.md"),
  `---\nname: ${SKILL_NAME}\ndescription: Folder-local skill the live-109 check plants\n---\n\nReport the word "lilos-live-proof" and nothing else.\n`,
);
/* Project skills load only from trusted roots (skills.trusted_project_dirs)
   — mirror a user who trusts this folder on their real profile. Merge, not
   overwrite: the plugin init already wrote its own keys. */
const cfgPath = join(HERMES_HOME, "config.yaml");
const cfg = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";
if (!cfg.includes("trusted_project_dirs"))
  appendFileSync(
    cfgPath,
    `${cfg && !cfg.endsWith("\n") ? "\n" : ""}skills:\n  trusted_project_dirs:\n    - ${workdir}\n`,
  );

const t0 = Date.now();
const out = (line: string) =>
  console.log(`[live-109 +${String(Date.now() - t0).padStart(5)}ms] ${line}`);

/* ------------------------------- boot --------------------------------- */

const stub = process.env.LILOS_STUB_PORT
  ? await startStub(Number(process.env.LILOS_STUB_PORT))
  : null;
if (stub) out(`openai-stub listening on :${stub.port}`);

const hermes = await startHermesServe({
  bin: HERMES_BIN,
  timeoutMs: 240_000,
  env: {
    HOME: process.env.HOME ?? "",
    HERMES_HOME,
  },
});
out(`lilos engine backend ready at ${hermes.url}`);

const shutdown = async () => {
  await hermes.close();
  cleanup(workdir);
};
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(130));
});

const gateway = await HermesGateway.connect(
  `ws://127.0.0.1:${hermes.port}/api/ws?token=${hermes.token}`,
);
out("gateway connected");

const engine = new HermesEngine({
  gateway,
  hermesHome: HERMES_HOME,
  onLog: (line) => out(`engine ${line}`),
});
engine.setGateway(gateway, { url: hermes.url, token: hermes.token });

const conn = connectInMemory(engine);
conn.onEvent((e) => {
  /* Headless run: never let an approval ask stall a turn. */
  if (e.type === "request.opened") {
    const p = e.payload as {
      requestId: string;
      request: { kind: string };
    };
    void conn.request("request.respond", {
      sessionId: e.sessionId,
      requestId: p.requestId,
      outcome: p.request.kind === "question" ? "answer" : "once",
      ...(p.request.kind === "question" ? { answer: "proceed" } : {}),
    });
  }
});

/* -------------------------------- run ---------------------------------- */

let ok = true;
const check = (pass: boolean, label: string) => {
  out(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (!pass) ok = false;
};

const described = (await conn.request("describe")) as {
  capabilities?: { id?: string }[];
};
check(
  (described.capabilities ?? []).some((c) => c.id === "commands"),
  `describe advertises commands (${(described.capabilities ?? []).map((c) => c.id).join(",")})`,
);

let { agents } = (await conn.request("agents.list")) as {
  agents: { id: string }[];
};
if (!agents[0]?.id) {
  out("no hermes profile under the isolated home — creating 'lilos109'");
  await conn.request("agents.create", {
    name: "lilos109",
    description: "live-109 check profile",
    model,
    provider,
  });
  ({ agents } = (await conn.request("agents.list")) as {
    agents: { id: string }[];
  });
}
const agent = agents[0]?.id;
if (!agent) throw new Error("no hermes profile available");
out(`agent=${agent}`);

const { sessionId } = (await conn.request("session.start", {
  agent,
  cwd: workdir,
  model,
  provider,
})) as { sessionId: string };
out(`session ${sessionId} (cwd=${workdir})`);

/* The adapter prefetches the list at session.start (the gateway's profile +
   project skill scan is a one-time ~300-900ms cold cost); a real user's
   first `/` lands well after that. Let the prefetch settle, then measure
   the interactive path. */
await new Promise((r) => setTimeout(r, 1200));

/* AC: <150ms for the list — timed on the wire call, cold then warm. */
type Item = { name: string; description: string; kind: string };
const tList = Date.now();
const items = (await conn.request("commands.list", {
  sessionId,
})) as Item[];
const coldMs = Date.now() - tList;
const tList2 = Date.now();
await conn.request("commands.list", { sessionId });
const warmMs = Date.now() - tList2;
out(
  `commands.list: ${items.length} items, cold ${coldMs}ms / warm ${warmMs}ms`,
);
check(items.length > 0, `commands.list returned ${items.length} items`);
check(
  coldMs < 150 && warmMs < 150,
  `list under 150ms (cold ${coldMs}ms, warm ${warmMs}ms)`,
);
check(
  items.some((i) => i.name === SKILL_NAME && i.kind === "skill"),
  `folder-local skill ${SKILL_NAME} listed as skill`,
);
check(
  items.some((i) => i.kind === "command"),
  `built-in commands listed (e.g. ${items.find((i) => i.kind === "command")?.name ?? "none"})`,
);

/* Query filtering rides the same call. */
const filtered = (await conn.request("commands.list", {
  sessionId,
  query: "lilos",
})) as Item[];
check(
  filtered.length > 0 &&
    filtered.every((i) => i.name.toLowerCase().includes("lilos")),
  `query "lilos" filters (${filtered.map((i) => i.name).join(",")})`,
);

/* commands.exec on a built-in: slash.exec answers output for the thread. */
const builtin =
  items.find((i) => i.kind === "command" && i.name === "help") ??
  items.find((i) => i.kind === "command");
if (!builtin) {
  check(false, "no built-in command to exec");
} else {
  const r = (await conn.request("commands.exec", {
    sessionId,
    name: builtin.name,
  })) as { outcome: string; output?: string; prompt?: string };
  out(`exec /${builtin.name} → ${JSON.stringify(r).slice(0, 200)}`);
  check(
    r.outcome === "output" || r.outcome === "prompt",
    `exec /${builtin.name} resolved (${r.outcome})`,
  );
}

/* commands.exec on the folder-local skill: slash.exec's 4018 routes to
   command.dispatch whose `send` directive becomes outcome:"prompt" — the
   text the next turn sends, exactly the TUI's skill expansion. */
const skillExec = (await conn.request("commands.exec", {
  sessionId,
  name: SKILL_NAME,
  args: "auth flow",
})) as { outcome: string; prompt?: string };
out(`exec /${SKILL_NAME} → ${JSON.stringify(skillExec).slice(0, 200)}`);
check(
  skillExec.outcome === "prompt" && (skillExec.prompt?.length ?? 0) > 0,
  `skill exec expanded to a prompt (${skillExec.outcome})`,
);

await shutdown();
out(`RESULT: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
