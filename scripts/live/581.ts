/**
 * Issue #581 live leg — "Add a folder" on a folder-less DM thread really
 * re-homes the session: `conversations.moveFolder` lands
 * `session.moveWorkspace` on the engine (`workspace_move` capability), the
 * conversation row's cwd updates, and the NEXT TURN runs its shell in the
 * moved folder (`pwd` proof — AC-2).
 *
 *   bun scripts/live/581.ts [--seconds N]
 *
 * Same shape as the #412 leg: real relay + real harness — the harness
 * launches `hermes serve` itself, so the seam under test is exactly what
 * ships. HOME / HERMES_HOME / LILOS_HOME isolation and provider config are
 * the caller's job (581.sh); nothing here kills or touches a process it did
 * not spawn — on Oscar's Mac the other `hermes serve`s are real engines.
 *
 * Assertions:
 *   1. the move call returns the conversation carrying the new cwd;
 *   2. the thread's system note says the running session moved — Hermes
 *      declares workspace_move, so anything else would have failed the
 *      call rather than stamp a fake;
 *   3. turn 2's `terminal` output prints $PWD inside the moved folder;
 *   4. a move to a missing folder is refused, not stamped.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
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
const seconds = Number(arg("seconds", "240") ?? "240");
const engineKind =
  arg("engine", process.env.LILOS_ENGINE ?? "hermes") ?? "hermes";
const HOME = process.env.HOME ?? "";

const out = (line: string) => console.log(`[live-581] ${line}`);
let harnessHome = "";
const fail = (line: string): never => {
  console.error(`[live-581] FAIL ${line}`);
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
const relayHome = mkdtempSync(join(tmpdir(), "lilos581-relay-"));
harnessHome = mkdtempSync(join(tmpdir(), "lilos581-harness-"));

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

launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_ENGINE: engineKind,
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});
{
  const deadline = Date.now() + 60_000;
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
out(`harness up (engine=${engineKind})`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-581", version: "0" },
});
await user.connect().catch((e) => fail(`relay connect: ${e}`));

const deadline = Date.now() + seconds * 1000;
const waitFor = async <T>(
  what: string,
  fn: () => T | undefined | Promise<T | undefined>,
  until = deadline,
): Promise<T> => {
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fail(`timed out waiting for ${what}`);
};

/* Every `terminal` tool result the session reports — the agent shell's
   own pwd under test. engine.event fans out to channel subscribers. */
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
       line-anchored check below sees real newlines. */
    try {
      const parsed = JSON.parse(raw) as { output?: unknown };
      termOutputs.push(typeof parsed.output === "string" ? parsed.output : raw);
    } catch {
      termOutputs.push(raw);
    }
  }
});

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
await user.request("channel.subscribe", { channelId: channel.id });
out(`dm channel ${channel.id}`);

/* ----------------- turn 1: a folder-less session lands ----------------- */

const { conversation } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "LILOS581 hello",
  access: "full",
  title: `581 move leg ${Date.now().toString(36)}`,
});
out(`conversation ${conversation.id}`);

const messages = user.channelMessages(channel.id);
await waitFor("turn 1 answer", () =>
  messages
    .get()
    .messages.some(
      (m) =>
        m.authorKind === "employee" && m.conversationId === conversation.id,
    )
    ? true
    : undefined,
);
out("turn 1 answered — session live");

const convRow = async () => {
  const r = await user.request<{
    conversations: { id: string; cwd?: string | null; engineRef?: string }[];
  }>("conversations.list", { channelId: channel.id });
  return r.conversations.find((c) => c.id === conversation.id);
};
await waitFor("conversation.engineRef bound", async () => {
  const row = await convRow();
  return row?.engineRef ? true : undefined;
});

/* ----------- move: folder-less thread → a real folder ------------------- */

/* The move target must sit under HOME — the harness refuses anything
   outside the Mac's home folder (resolveUnderHome). */
const movedDir = join(HOME, "lilos581-moved");
mkdirSync(movedDir, { recursive: true });
const { conversation: movedConv } = await user.request<{
  conversation: { id: string; cwd?: string | null };
}>("conversations.moveFolder", {
  conversationId: conversation.id,
  path: movedDir,
});
const landed = movedConv.cwd ?? "";
out(`conversation.cwd now ${landed}`);

/* cwd comes back collapsed (`~/…`) when it sits under the harness home —
   compare against both spellings. */
const wanted = new Set([movedDir, `~/lilos581-moved`]);
if (!wanted.has(landed))
  fail(`conversation.cwd did not land the moved folder: ${landed}`);

/* The honest note: engineMoved true means the running session re-homed —
   Hermes' workspace_move is declared, so a fake stamp would have been an
   error instead. */
await waitFor("move system note", () =>
  messages
    .get()
    .messages.some(
      (m) =>
        m.authorKind === "system" &&
        m.conversationId === conversation.id &&
        m.text.includes("the running session moved too"),
    )
    ? true
    : undefined,
);
out("system note reports the running session moved (engineMoved)");

/* ---- turn 2: the NEXT turn's shell pwd is the moved folder (AC-2) ------ */

/* The instruction is explicit so a real model runs the shell (the stub
   matches the same substring below and answers with a scripted terminal
   call — one text works for both engines). */
await user.request("messages.post", {
  channelId: channel.id,
  conversationId: conversation.id,
  authorId: "user",
  authorKind: "user",
  text: "Use the terminal tool to run exactly: echo LILOS581_PWD=$PWD — then reply with its output.",
});
/* Turn 2 gets its own budget from the post: a real model needs the full
   think → call → answer cycle, not whatever the global deadline has left
   after turn 1 and the move. */
const pwd = await waitFor(
  "terminal pwd output",
  () => {
    const hit = termOutputs.find((o) => o.includes("LILOS581_PWD="));
    return hit?.match(/LILOS581_PWD=(\S+)/)?.[1];
  },
  Date.now() + 180_000,
);
out(`agent shell pwd: ${pwd}`);
/* macOS may realpath /tmp-style dirs under /private — compare resolved. */
if (pwd !== movedDir && pwd !== realpathSync(movedDir))
  fail(`turn 2 ran in ${pwd}, expected ${movedDir}`);
out("turn 2 ran in the moved folder — session really re-homed");

/* ---------------- missing dir is refused, not stamped ------------------ */

try {
  await user.request("conversations.moveFolder", {
    conversationId: conversation.id,
    path: join(HOME, "lilos581-does-not-exist"),
  });
  fail("move to a missing folder was accepted");
} catch {
  out("move to a missing folder refused as expected");
}

out("PASS — conversations.moveFolder re-homed the session's folder");
/* Close the client BEFORE teardown kills the relay: its reconnect
   supervisor would otherwise schedule retries on the dead socket and hold
   the event loop — a live leg must never leave a process behind. */
user.close();
stub?.kill();
teardown();
console.log("[live-581] PASS");
/* Children die on SIGTERM asynchronously and undici/WS keep-alive sockets
   can linger past their close — exit explicitly. */
process.exit(0);
