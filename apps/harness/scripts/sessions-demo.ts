/**
 * Issue #28 live leg: session history + reconnect through the REAL relay and
 * harness against a real engine (`hermes serve` or `fake`):
 *
 *   bun apps/harness/scripts/sessions-demo.ts [--engine fake|hermes]
 *
 * Drives, over the real app protocol (the same calls the UI makes):
 *   AC-1 leg — conversations.summaries lists a past conversation with its
 *              root message + answer preview (still there after a relay
 *              restart, which is the app's restart boundary)
 *   AC-2 leg — messages.list {conversationId} returns the thread's visible
 *              messages (user + employee) after the restart
 *   AC-3 leg — conversations.update title/archived persist and mirror to the
 *              engine when it advertises `session_meta`
 *   AC-5 leg — kill the relay mid-turn, restart it: the turn's answer still
 *              lands, exactly once (dedupeKey + deliveredSeq + pending drain)
 * Prints PASS/FAIL per leg and exits non-zero on any failure.
 *
 * Engine selection is the same env the harness uses:
 *   LILOS_ENGINE=fake (default) | hermes
 *   HERMES_PROVIDER / HERMES_MODEL for the hermes leg.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";
import type {
  AppMessage,
  Conversation,
  ConversationSummary,
} from "@lilos/contracts/app";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const engineKind = arg("engine", process.env.LILOS_ENGINE ?? "fake") ?? "fake";

const checks: { id: string; ok: boolean; note: string }[] = [];
const check = (id: string, ok: boolean, note: string) => {
  checks.push({ id, ok, note });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${id} — ${note}`);
};
const out = (line: string) => console.log(`[demo28] ${line}`);
const fail = (line: string): never => {
  console.error(`[demo28] FAIL ${line}`);
  cleanup();
  process.exit(1);
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === "object" && addr
          ? resolve(addr.port)
          : reject(new Error("no port")),
      );
    });
  });
const port = await freePort();
const feedPort = await freePort();

const relayHome = mkdtempSync(join(tmpdir(), "lilos-relay-28-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos-harness-28-"));
const procs = new Set<ChildProcess>();
const launch = (name: string, cmd: string[], env: Record<string, string>) => {
  const child = spawn(cmd[0] ?? "bun", cmd.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.add(child);
  child.stderr?.on("data", (d) => {
    for (const l of String(d).trimEnd().split("\n"))
      console.error(`  [${name}!] ${l}`);
  });
  child.on("exit", () => procs.delete(child));
  return child;
};
const killProc = (proc: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 8_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    proc.kill("SIGTERM");
  });
const cleanup = () => {
  for (const p of procs) p.kill("SIGTERM");
  rmSync(relayHome, { recursive: true, force: true });
  rmSync(harnessHome, { recursive: true, force: true });
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

const relayUrl = `ws://127.0.0.1:${port}/ws`;
const healthUrl = `http://127.0.0.1:${port}/health`;
const waitForRelay = async (ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.status > 0) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  fail("relay did not come up");
};
const spawnRelay = () =>
  launch("relay", ["bun", "apps/relay/src/index.ts"], {
    LILOS_RELAY_HOME: relayHome,
    LILOS_RELAY_PORT: String(port),
  });

let relay = spawnRelay();
await waitForRelay();
const tokenPath = join(relayHome, "relay-token");
const relayToken = await (async () => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const t = readFileSync(tokenPath, "utf8").trim();
      if (t) return t;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return fail("timed out waiting for relay-token");
})();

launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: join(harnessHome, "work"),
  LILOS_ENGINE: engineKind,
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});
out(`relay+harness up (engine=${engineKind})`);

const newUser = () =>
  new RelayClient({
    url: relayUrl,
    token: relayToken,
    client: { name: "lilos-demo28-user", version: "0" },
  });
const user = newUser();
await user.connect().catch((e) => fail(`connect: ${e}`));

// The harness hires a first employee at boot — find it (retry while it
// spawns the engine).
let employees: { id: string; name?: string }[] = [];
{
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await user.request<{ employees: typeof employees }>(
        "employees.list",
        {},
      );
      employees = res.employees;
      if (employees.length > 0) break;
    } catch (e) {
      console.error(`  [demo28!] employees.list: ${e}`);
    }
    if (Date.now() > deadline) fail("no employee appeared");
    await new Promise((r) => setTimeout(r, 500));
  }
}
const emp = employees[0];
if (!emp) fail("employees.list returned an empty slot");
const { channel } = await user.request<{ channel: { id: string } }>(
  "channels.openDm",
  { employeeId: emp.id },
);
out(`dm channel ${channel.id} for employee ${emp.id}`);

// Latest employee-authored message count for a conversation.
const employeeMsgs = async (conversationId: string) => {
  const res = await user.request<{ messages: AppMessage[] }>("messages.list", {
    channelId: channel.id,
    conversationId,
  });
  return res.messages.filter((m) => m.authorKind === "employee");
};

const summaries = () =>
  user.request<{ summaries: ConversationSummary[] }>(
    "conversations.summaries",
    { channelId: channel.id, includeArchived: true },
  );

// Wait until an answer for `convId` shows up in messages.list (polls so the
// check survives the relay restart in the AC-5 leg).
const waitForAnswer = async (convId: string, ms = 90_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const msgs = await employeeMsgs(convId);
      if (msgs.length > 0) return msgs;
    } catch {
      /* socket mid-reconnect */
    }
    if (Date.now() > deadline)
      fail(`no employee answer for ${convId} within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 400));
  }
};

// Turn 1: a plain question — answer arrives while everything is up.
const { conversation: conv } = await user.request<{
  conversation: Conversation;
}>("conversations.open", {
  channelId: channel.id,
  text: "Summarize the repo layout in one line",
});
out(`conversation ${conv.id} opened`);
await waitForAnswer(conv.id);

// AC-5 leg — kill the relay while turn 2 is in flight, restart it, and the
// answer must arrive exactly once.
const { conversation: conv2 } = await user.request<{
  conversation: Conversation;
}>("conversations.open", {
  channelId: channel.id,
  text: "Second turn — survive a relay restart",
});
out(`killing relay mid-turn (conv ${conv2.id})`);
await killProc(relay);
procs.delete(relay);
relay = spawnRelay();
await waitForRelay();
// The user socket reconnects on its own; give the harness a beat to
// re-register and drain its outbox.
const answers2 = await waitForAnswer(conv2.id);
check(
  "AC-5",
  answers2.length === 1,
  `turn output complete after relay restart: ${answers2.length} employee message(s), no duplicates`,
);

// AC-1 leg — after the restart, summaries still list both conversations.
{
  const list = (await summaries()).summaries;
  const s1 = list.find((s) => s.conversation.id === conv.id);
  const s2 = list.find((s) => s.conversation.id === conv2.id);
  check(
    "AC-1",
    !!s1?.root && !!s1?.firstAnswer && !!s2,
    `summaries=${list.length}; conv1 root+answer shown, conv2 listed`,
  );
}

// AC-2 leg — the reopened thread carries user + employee messages.
{
  const res = await user.request<{ messages: AppMessage[] }>("messages.list", {
    channelId: channel.id,
    conversationId: conv.id,
  });
  const kinds = new Set(res.messages.map((m) => m.authorKind));
  check(
    "AC-2",
    res.messages.length >= 2 && kinds.has("user") && kinds.has("employee"),
    `messages.list -> ${res.messages.length} visible messages (user+employee)`,
  );
}

// AC-3 leg — rename + archive persist (and mirror to the engine by
// capability — covered live only as far as the relay rows here).
{
  await user.request("conversations.update", {
    conversationId: conv.id,
    title: "Repo summary thread",
  });
  await user.request("conversations.update", {
    conversationId: conv.id,
    archived: true,
  });
  const s = (await summaries()).summaries.find(
    (x) => x.conversation.id === conv.id,
  );
  check(
    "AC-3",
    s?.conversation.title === "Repo summary thread" &&
      s.conversation.archived === true,
    `rename+archive persisted: title=${s?.conversation.title} archived=${s?.conversation.archived}`,
  );
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks)
  console.log(`RESULT ${c.id}: ${c.ok ? "PASS" : "FAIL"} — ${c.note}`);
console.log(
  `SUMMARY: ${checks.length - failed.length}/${checks.length} legs passed (engine=${engineKind})`,
);
cleanup();
process.exit(failed.length === 0 ? 0 : 1);
