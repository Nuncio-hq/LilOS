/**
 * Issue #106 live leg — approval modes per conversation, real Hermes.
 *
 *   bun scripts/live/106.ts [--seconds 120]
 *
 * Spawns the real relay + harness (same env as scripts/live/105.ts) with
 * LILOS_ENGINE=hermes, then drives the seam end to end:
 *
 *   1. `approvals.setPolicy {policy:"manual"}` crosses the relay
 *      passthrough to the engine host (the global `config.set
 *      approvals.mode` on Hermes) — restored to the describe-reported
 *      value at the end
 *   2. Ask level (the default): the `chmod 777 README.md` prompt parks the
 *      turn on an approval ask carrying Once/This session/Always/Deny
 *      options — the user answers `once` and the turn completes (AC-1/AC-4)
 *   3. `conversations.setAccess {access:"full"}` mid-conversation: the same
 *      prompt completes with NO ask opening — either the harness
 *      auto-answered (`Auto-approved` system note) or the engine's own
 *      hint suppressed the request; both are the contract (AC-2)
 *
 * Engine: LILOS_ENGINE (default hermes) + HERMES_PROVIDER/HERMES_MODEL, set
 * by scripts/live/106.sh (stub provider when no real model is signed in).
 * Prints PASS/FAIL. Exit 0 only on PASS.
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative import: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — the package resolves its own deps internally.
import { RelayClient } from "../../packages/client-runtime/src/index";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(arg("seconds", "120") ?? "120");
const engineKind = arg("engine", process.env.LILOS_ENGINE ?? "hermes");

const out = (line: string) => console.log(`[live-106] ${line}`);
let harnessHome = "";
const fail = (line: string): never => {
  console.error(`[live-106] FAIL ${line}`);
  try {
    console.error(readFileSync(join(harnessHome, "harness.log"), "utf8"));
  } catch {
    /* no log file */
  }
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

const relayPort = await freePort();
const feedPort = await freePort();
const relayHome = mkdtempSync(join(tmpdir(), "lilos106-relay-"));
harnessHome = mkdtempSync(join(tmpdir(), "lilos106-harness-"));

// A real git repo so the chmod lands on a tracked file (same fixture shape
// as 105 — the folder a session works in).
const picked = mkdtempSync(join(tmpdir(), "lilos106-picked-"));
writeFileSync(join(picked, "README.md"), "# repo\n");
execSync(
  "git init -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init",
  { cwd: picked },
);

const procs: ChildProcess[] = [];
const launch = (name: string, cmd: string[], env: Record<string, string>) => {
  const child = spawn(cmd[0] ?? "bun", cmd.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  child.stdout?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => void console.log(`  [${name}] ${l}`)),
  );
  child.stderr?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => void console.error(`  [${name}!] ${l}`)),
  );
  return child;
};
const cleanup = () => {
  for (const p of procs) p.kill("SIGTERM");
  rmSync(relayHome, { recursive: true, force: true });
  rmSync(harnessHome, { recursive: true, force: true });
  rmSync(picked, { recursive: true, force: true });
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

launch("relay", ["bun", "apps/relay/src/index.ts"], {
  LILOS_RELAY_HOME: relayHome,
  LILOS_RELAY_PORT: String(relayPort),
});

const waitForFile = async (path: string, ms = 10_000): Promise<string> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return fail(`timed out waiting for ${path}`);
};

const relayToken = await waitForFile(join(relayHome, "relay-token"));
const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
out(`relay ws ${relayUrl}`);

{
  const deadline = Date.now() + 10_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${relayPort}/health`);
      if (res.ok || res.status === 404) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) fail("relay did not come up");
}

const workdir = join(harnessHome, "work");
launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: workdir,
  LILOS_ENGINE: engineKind,
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});
out(`harness launched (engine=${engineKind}, workdir=${workdir})`);

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
  client: { name: "lilos-live-106", version: "0" },
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

interface CapabilityShape {
  id: string;
  detail?: { options?: string[]; current?: string };
}
const currentPolicy = async (): Promise<string | undefined> => {
  const { engine } = await user.request<{
    engine?: { capabilities?: CapabilityShape[] };
  }>("system.status", { logLines: 0 });
  return engine?.capabilities?.find((c) => c.id === "approval_policy")?.detail
    ?.current;
};

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
out(`dm channel ${channel.id}`);

const asksList = async (convId: string, state?: string) =>
  (
    await user.request<{
      asks: { id: string; request: { kind: string; options?: string[] } }[];
    }>("asks.list", { conversationId: convId, ...(state ? { state } : {}) })
  ).asks;

const convState = async (convId: string) =>
  (
    await user.request<{ conversations: { id: string; state: string }[] }>(
      "conversations.list",
      { channelId: channel.id },
    )
  ).conversations.find((c) => c.id === convId)?.state;

const messagesText = async (convId: string) =>
  (
    await user.request<{
      messages: {
        authorKind: string;
        text: string;
        conversationId?: string | null;
      }[];
    }>("messages.list", { channelId: channel.id, limit: 200 })
  ).messages.filter((m) => m.conversationId === convId);

/* The stub script keys each leg's tool_call on a unique marker — the
   post-tool-result request still carries the same last user message, so a
   shared match would re-fire the call instead of answering with text. */
const PROMPT1 =
  "LILOS_FIRST — run this terminal command verbatim: `chmod 777 README.md` — then reply with exactly: LILOS_OK";
const PROMPT2 =
  "LILOS_SECOND — run this terminal command verbatim: `chmod 777 README.md` — then reply with exactly: LILOS_OK";

/* ── Leg 0: the engine policy round-trips through the relay passthrough ── */
/* Passthrough calls need a registered host AND a running engine — `hermes
   serve` takes a few seconds after the feed endpoint is up. */
await waitFor("engine host running", async () => {
  const { components } = await user.request<{
    components: { id: string; state: string }[];
  }>("system.status", { logLines: 0 });
  return components.find((c) => c.id === "engine")?.state === "ok"
    ? true
    : undefined;
});
out("engine running");

const before = await currentPolicy();
out(`policy before: ${before ?? "(unreported)"}`);
const set = await user.request<{ policy?: string }>("approvals.setPolicy", {
  policy: "manual",
});
if (set.policy !== "manual")
  fail(`approvals.setPolicy echo was ${JSON.stringify(set)}`);
out("PASS leg0: approvals.setPolicy manual echoed by the engine");

try {
  /* ── Leg 1 — Ask (the default): the gated turn parks on a card ── */
  const { conversation } = await user.request<{
    conversation: { id: string; access?: string };
  }>("conversations.open", {
    channelId: channel.id,
    text: PROMPT1,
    title: "approval modes",
    cwd: picked,
  });
  if (conversation.access !== "ask")
    fail(`new conversation access=${conversation.access}, expected ask`);

  const ask = await waitFor("open approval ask", async () =>
    (await asksList(conversation.id, "open")).find(
      (a) => a.request.kind === "approval",
    ),
  );
  const options = ask.request.options ?? [];
  for (const o of ["once", "session", "always", "deny"])
    if (!options.includes(o))
      fail(`approval options missing "${o}": ${options.join(",")}`);
  out(`PASS leg1a: card opened with options [${options.join(", ")}]`);

  await user.request("asks.respond", { askId: ask.id, outcome: "once" });
  await waitFor("turn to complete after the once answer", async () => {
    const s = await convState(conversation.id);
    return s === "idle" || s === "closed" ? s : undefined;
  });
  out("PASS leg1b: answering Once let the turn complete");

  /* ── Leg 2 — Full: the switch applies to the next approval ── */
  const { conversation: flipped } = await user.request<{
    conversation: { id: string; access: string };
  }>("conversations.setAccess", {
    conversationId: conversation.id,
    access: "full",
  });
  if (flipped.access !== "full")
    fail(`setAccess returned access=${flipped.access}`);

  const asksBefore = (await asksList(conversation.id)).length;
  await user.request("messages.post", {
    channelId: channel.id,
    conversationId: conversation.id,
    text: PROMPT2,
    authorKind: "user",
  });
  await waitFor("full-access turn to complete", async () => {
    const s = await convState(conversation.id);
    return s === "idle" || s === "closed" ? s : undefined;
  });
  const asksAfter = await asksList(conversation.id);
  if (asksAfter.length !== asksBefore)
    fail(
      `a card opened under Full access (${asksBefore} asks before, ${asksAfter.length} after)`,
    );
  const auto = (await messagesText(conversation.id)).some(
    (m) => m.authorKind === "system" && /Auto-approved/.test(m.text),
  );
  out(
    `PASS leg2: no card under Full access; turn completed ` +
      `(${auto ? "harness auto-answer logged" : "engine hint suppressed the request"})`,
  );
} finally {
  /* approvals.mode is Hermes global config — leave it as found. */
  if (before && before !== "manual") {
    await user
      .request("approvals.setPolicy", { policy: before })
      .catch(() => {});
    out(`policy restored to ${before}`);
  }
}

user.close();
for (const p of procs) p.kill("SIGTERM");
console.log("[live-106] PASS all legs");
process.exit(0);
