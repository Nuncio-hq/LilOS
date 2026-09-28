/**
 * Issue #137 live leg — the engine names a new session itself.
 *
 *   bun scripts/live/137.ts [--engine hermes] [--seconds N]
 *
 * Spawns the real relay + harness (engine=hermes → real `hermes serve`),
 * then drives a scripted user over `@lilos/client-runtime`:
 *
 *   1. conversations.open with no title → the placeholder is the opener's
 *      first ~6 words immediately (AC-3)
 *   2. Hermes writes its instant derived title → session.titled flows to
 *      the conversation (AC-1/AC-2)
 *   3. Hermes' small-model upgrade lands → conversation title again (AC-2)
 *      — on the stub provider, scripts/live/openai-stub.ts answers the
 *      `session_title` json_schema call
 *   4. a user rename then proves provenance: titleSource flips to `user`
 *      and no late engine title can overwrite it (AC-2)
 *
 * Engine: LILOS_ENGINE (default hermes) + HERMES_PROVIDER/HERMES_MODEL, set
 * by scripts/live/137-auto-title.sh (stub provider when no real model is
 * signed in). Prints PASS/FAIL. Exit 0 only on PASS.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative import: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — the package resolves its own deps internally.
import {
  EngineClient,
  RelayClient,
} from "../../packages/client-runtime/src/index";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(arg("seconds", "90") ?? "90");
const engineKind = arg("engine", process.env.LILOS_ENGINE ?? "hermes");

const out = (line: string) => console.log(`[live-137] ${line}`);
let harnessHome = "";
const fail = (line: string): never => {
  console.error(`[live-137] FAIL ${line}`);
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
const relayHome = mkdtempSync(join(tmpdir(), "lilos137-relay-"));
harnessHome = mkdtempSync(join(tmpdir(), "lilos137-harness-"));

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

launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: join(harnessHome, "work"),
  LILOS_ENGINE: engineKind,
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});
out(`harness launched (engine=${engineKind})`);

{
  const deadline = Date.now() + 15_000;
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

const titledEvents: { title: string; source: string }[] = [];
const engine = new EngineClient({
  url: `ws://127.0.0.1:${feedPort}/ws`,
  connectTimeoutMs: 60_000,
});
engine.onEvent((e) => {
  if (e.type === "session.titled")
    titledEvents.push(e.payload as { title: string; source: string });
});
await engine.connect().catch((e) => fail(`feed connect: ${e}`));
out("feed connected");

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-137", version: "0" },
});
await user.connect().catch((e) => fail(`relay connect: ${e}`));

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
// conversation.updated only fans out to channel subscribers.
user.channelMessages(channel.id);

const PROMPT = "Plan the release checklist for the mobile app";
const { conversation } = await user.request<{
  conversation: { id: string; title: string; titleSource?: string };
}>("conversations.open", { channelId: channel.id, text: PROMPT });

/* AC-3: the placeholder is the opener's first ~6 words, from the moment the
   row exists — before any engine work lands. */
const PLACEHOLDER = "Plan the release checklist for the…";
if (conversation.title !== PLACEHOLDER)
  fail(
    `placeholder title ${JSON.stringify(conversation.title)} != ${JSON.stringify(PLACEHOLDER)}`,
  );
if (conversation.titleSource !== "auto")
  fail(`placeholder titleSource ${conversation.titleSource} != "auto"`);
out(`PASS placeholder: "${conversation.title}" (auto)`);

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

const titleOf = async () => {
  const r = await user
    .request<{
      conversations: { id: string; title: string; titleSource?: string }[];
    }>("conversations.list", {})
    .catch(() => undefined);
  return r?.conversations.find((c) => c.id === conversation.id);
};

/* AC-1/AC-2 leg 1 — derived: Hermes' instant title (≤48 chars of the opener)
   beats the model upgrade to the wire. */
const derived = await waitFor("derived title on the conversation", async () => {
  const c = await titleOf();
  return c && c.title !== PLACEHOLDER ? c : undefined;
});
out(`PASS derived title: "${derived.title}" (source=${derived.titleSource})`);
if (derived.titleSource !== "auto")
  fail(`derived titleSource ${derived.titleSource} != "auto"`);

/* AC-2 leg 2 — llm: the small-model upgrade replaces the derived title
   (on the stub provider the session_title call is answered by
   scripts/live/openai-stub.ts). */
const llm = await waitFor("llm title on the conversation", async () => {
  const c = await titleOf();
  return c && c.title !== derived.title ? c : undefined;
});
out(`PASS llm title: "${llm.title}" (source=${llm.titleSource})`);

/* The wire trace on the engine feed must show the two stages in order. */
const sources = titledEvents.map((t) => t.source);
if (!(sources[0] === "derived" && sources.at(-1) === "llm"))
  fail(`session.titled order ${JSON.stringify(sources)} != derived..llm`);
out(`PASS session.titled order: ${sources.join(" -> ")}`);

/* AC-2 leg 3 — a user rename flips provenance and outlives late titles. */
await user.request("conversations.update", {
  conversationId: conversation.id,
  title: "Release naming session",
});
const renamed = await waitFor("user rename lands", async () => {
  const c = await titleOf();
  return c && c.title === "Release naming session" ? c : undefined;
});
if (renamed.titleSource !== "user")
  fail(`rename titleSource ${renamed.titleSource} != "user"`);
await new Promise((r) => setTimeout(r, 3_000)); // settle window for strays
const after = await titleOf();
if (after?.title !== "Release naming session" || after.titleSource !== "user")
  fail(
    `late title overwrote the rename: ${JSON.stringify(after?.title)} source=${after?.titleSource}`,
  );
out(`PASS rename kept: "${after.title}" (user)`);

user.close();
engine.close();
cleanup();
out(`RESULT: PASS (engine=${engineKind})`);
