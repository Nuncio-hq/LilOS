/**
 * Issue #412 live leg — agent sessions must not inherit LilOS internals:
 * the engine process env carries only the documented LILOS_* allow-list
 * (no `LILOS_RELAY_TOKEN`, no state dirs), and a folder-less session's
 * `pwd` is the user's home — never inside `$LILOS_HOME`.
 *
 *   bun scripts/live/412.ts [--seconds N]
 *
 * Same shape as the #106 leg: real relay + real harness — the harness
 * launches `hermes serve` itself, so the allow-list seam under test
 * (apps/harness/src/engine/launcher.ts) is exactly what ships. HOME /
 * HERMES_HOME / LILOS_HOME isolation is the caller's job (412.sh); nothing
 * here kills or touches a process it did not spawn — on Oscar's Mac the
 * other `hermes serve`s are real engines.
 *
 * Assertions:
 *   1. the `hermes serve` child of OUR harness (found by walking its own
 *      process tree, never a pgrep over the machine) has only allow-listed
 *      LILOS_* names in `ps eww` output — AC-1, model-independent;
 *   2. the agent's own shell: a `terminal` tool call runs
 *      `env | grep LILOS_ | sort; echo LILOS412_PWD=$PWD` — its output shows
 *      only allow-listed names — AC-3;
 *   3. the same output's pwd is $HOME, outside every LilOS state dir — AC-2.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative import: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — the package resolves its own deps internally.
import { RelayClient } from "../../packages/client-runtime/src/index";
import {
  cleanup,
  freePort,
  launch,
  startStub,
  waitForFile,
} from "./lib/helpers";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(arg("seconds", "180") ?? "180");
const engineKind =
  arg("engine", process.env.LILOS_ENGINE ?? "hermes") ?? "hermes";
const HOME = process.env.HOME ?? "";

/* Mirrors LILOS_ENV_ALLOW_LIST in packages/contracts/src/env.ts —
   the documented env an agent session may see. */
const ALLOW_LIST = ["LILOS_ENGINE_TOKEN", "LILOS_SURFACES_URL"];

const out = (line: string) => console.log(`[live-412] ${line}`);
let harnessHome = "";
const fail = (line: string): never => {
  console.error(`[live-412] FAIL ${line}`);
  try {
    console.error(readFileSync(join(harnessHome, "harness.log"), "utf8"));
  } catch {
    /* no log file */
  }
  process.exit(1);
};

const stub = process.env.LILOS_STUB_PORT
  ? await startStub(Number(process.env.LILOS_STUB_PORT))
  : null;
if (stub) out(`openai-stub listening on :${stub.port}`);

const relayPort = await freePort();
const feedPort = await freePort();
const relayHome = mkdtempSync(join(tmpdir(), "lilos412-relay-"));
harnessHome = mkdtempSync(join(tmpdir(), "lilos412-harness-"));

const teardown = () => cleanup(relayHome, harnessHome);
process.on("SIGINT", () => {
  teardown();
  process.exit(130);
});

launch("relay", ["bun", "apps/relay/src/index.ts"], {
  LILOS_RELAY_HOME: relayHome,
  LILOS_RELAY_PORT: String(relayPort),
});
const relayToken = await waitForFile(join(relayHome, "relay-token")).catch(
  (e) => fail(String(e)),
);
const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
out(`relay ws ${relayUrl}`);

/* No LILOS_WORKDIR on purpose: the shipped default is the thing under test
   — a folder-less session's cwd must be $HOME. The poison marker proves the
   env allow-list is generic (drops names nobody listed), not a hand-rolled
   list of today's internals. */
const harness = launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_POISON_MARKER: "must-not-reach-agents",
  LILOS_ENGINE: engineKind,
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});

{
  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${feedPort}/host`, {
        method: "OPTIONS",
      });
      if (res.status === 204) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) fail("harness feed did not come up");
}

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-412", version: "0" },
});
await user.connect().catch((e) => fail(`relay connect: ${e}`));

const deadline = Date.now() + seconds * 1000;
const waitFor = async <T>(
  what: string,
  fn: () => T | undefined | Promise<T | undefined>,
): Promise<T> => {
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fail(`timed out waiting for ${what}`);
};

/* Every `terminal` tool result the session reports — the agent shell's own
   env/pwd under test. engine.event fans out to channel subscribers. */
const termOutputs: string[] = [];
user.onEvent((method, params) => {
  if (method !== "engine.event") return;
  const ev = (
    params as {
      event?: { type?: string; payload?: { tool?: string; output?: string } };
    }
  ).event;
  if (ev?.type === "tool.completed" && ev.payload?.tool === "terminal") {
    const raw = String(ev.payload.output ?? "");
    /* Hermes reports the terminal result as a JSON string
       ({"output":"…","exit_code":0}) — unwrap it when it is one so the
       line-anchored checks below see real newlines. */
    try {
      const parsed = JSON.parse(raw) as { output?: unknown };
      termOutputs.push(typeof parsed.output === "string" ? parsed.output : raw);
    } catch {
      termOutputs.push(raw);
    }
  }
});

/* The engine process's env, straight off OUR harness's child tree — the
   AC-1 reading that doesn't depend on what the model decides to run. Only
   descendants of the spawned harness pid are inspected: a `hermes serve`
   belonging to a real stack is never touched. */
const serveEnvLilos = (): string[] | undefined => {
  const root = harness.pid;
  if (!root) return undefined;
  /* `hermes serve` runs as `python -c <multi-line script> serve --host …` —
     ps prints argv newlines raw, so a `command` column shatters one row
     across lines. Walk the tree on clean `pid,ppid` columns, then read the
     candidate's command/env with per-pid ps calls (no line parsing). */
  const rows = (
    spawnSync("ps", ["-axo", "pid,ppid"], { encoding: "utf8" }).stdout ?? ""
  )
    .split("\n")
    .slice(1)
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)$/))
    .filter((m): m is RegExpMatchArray => m !== null);
  const kids = new Map<number, number[]>();
  for (const m of rows) {
    const list = kids.get(Number(m[2])) ?? [];
    list.push(Number(m[1]));
    kids.set(Number(m[2]), list);
  }
  const queue = [root];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.shift() ?? 0;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of kids.get(pid) ?? []) {
      const command =
        spawnSync("ps", ["-o", "command=", "-p", String(c)], {
          encoding: "utf8",
        }).stdout ?? "";
      /* The launcher argv differs per install: `serve --host 127.0.0.1`
         on the real toolchain, `['-c','serve','--host','127.0.0.1',…]` on
         a scratch-minted launcher — match the tokens, not the literal. */
      const isServe =
        command.includes("serve") &&
        command.includes("--host") &&
        command.includes("127.0.0.1");
      if (!isServe) {
        queue.push(c);
        continue;
      }
      /* undefined = the serve child isn't up yet; an empty (allow-listed)
         env IS an answer — keep polling only before the process exists. */
      const env =
        spawnSync("ps", ["eww", "-p", String(c)], { encoding: "utf8" })
          .stdout ?? "";
      return env
        .split(/\s+/)
        .map((t) => t.match(/^(LILOS_[A-Z0-9_]+)=/)?.[1])
        .filter((n): n is string => Boolean(n))
        .sort();
    }
  }
  return undefined;
};

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
out(`dm channel ${channel.id}`);
await user.request("channel.subscribe", { channelId: channel.id });

await waitFor("engine host running", async () => {
  const { components } = await user.request<{
    components: { id: string; state: string }[];
  }>("system.status", { logLines: 0 });
  return components.find((c) => c.id === "engine")?.state === "ok"
    ? true
    : undefined;
});
out("engine running");

/* AC-1, engine-process leg: the `hermes serve` env the moment it's up —
   nothing the agent does can add a var it lacks. */
const lilosOnEngine = await waitFor("engine process env", async () =>
  serveEnvLilos(),
);
out(`engine process LILOS_*: ${lilosOnEngine.join(",") || "(none)"}`);
const leaked = lilosOnEngine.filter((n) => !ALLOW_LIST.includes(n));
if (leaked.length)
  fail(`engine env leaked LilOS internals: ${leaked.join(",")}`);
/* The allow-list pair must actually LAND — an empty set would mean the
   gateway creds the lilos plugin needs never made it to the engine. */
for (const want of ALLOW_LIST)
  if (!lilosOnEngine.includes(want))
    fail(`engine env is missing the granted ${want}`);
out("PASS leg1: engine process env is allow-listed (no LILOS_RELAY_TOKEN)");

/* AC-2/AC-3, agent-shell leg: a no-folder conversation — access full keeps
   the terminal call off the approval card so the leg stays unattended. */
const { conversation } = await user.request<{
  conversation: { id: string; cwd?: string | null };
}>("conversations.open", {
  channelId: channel.id,
  text: "LILOS412 — run `env | grep LILOS_ | sort; echo LILOS412_PWD=$PWD` in the terminal, show the output verbatim, then reply with exactly: LILOS412_DONE",
  access: "full",
  title: "412 env leg",
});
if (conversation.cwd)
  fail(`folder-less conversation unexpectedly carries cwd ${conversation.cwd}`);

const probe = await waitFor("agent terminal output", () =>
  termOutputs.find((o) => o.includes("LILOS412_PWD=")),
);
out(`agent terminal output:\n${probe}`);

const seen = [...probe.matchAll(/^(LILOS_[A-Z0-9_]+)=.*$/gm)]
  .map((m) => m[1] ?? "")
  .sort();
const offList = seen.filter((n) => !ALLOW_LIST.includes(n));
if (offList.length)
  fail(`agent shell sees non-allow-listed LILOS_*: ${offList.join(",")}`);
/* Like leg1, the granted pair must actually LAND in the agent shell —
   ⊆ alone would pass vacuously on an empty env and miss a scrub that
   silently under-inherits (the lilos_* plugin needs both names). */
for (const want of ALLOW_LIST)
  if (!seen.includes(want)) fail(`agent shell is missing the granted ${want}`);
out(
  `PASS leg2: agent shell env shows only the allow-list ` +
    `(${seen.join(",") || "none"})`,
);

const pwd = probe.match(/^LILOS412_PWD=(\S+)$/m)?.[1] ?? "";
if (!pwd) fail("agent terminal output had no LILOS412_PWD line");
if (pwd !== HOME)
  fail(`no-folder session pwd is ${pwd}, expected $HOME (${HOME})`);
for (const inside of [
  relayHome,
  harnessHome,
  process.env.LILOS_HOME ?? "",
  process.env.HERMES_HOME ?? "",
])
  if (inside && pwd.startsWith(inside))
    fail(`no-folder session pwd ${pwd} sits inside LilOS state ${inside}`);
out("PASS leg3: no-folder session pwd is $HOME, outside LilOS state");

await waitFor("turn to settle", async () => {
  const { conversations } = await user.request<{
    conversations: { id: string; state: string }[];
  }>("conversations.list", { channelId: channel.id });
  const s = conversations.find((c) => c.id === conversation.id)?.state;
  return s === "idle" || s === "closed" ? s : undefined;
});

user.close();
teardown();
console.log("[live-412] PASS all legs");
process.exit(0);
