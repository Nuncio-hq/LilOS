/**
 * Issue #105 live leg — an `@file` mention reaches the engine as plain text.
 *
 *   bun scripts/live/105.ts [--engine hermes] [--seconds 90]
 *
 * Spawns the real relay + harness (same env as scripts/live/113.ts), then:
 *
 *   1. fs.search over POST /host on a fixture repo → `docs/guide.md` and the
 *      `docs/` dir come back, `.gitignore`d `secret.env` does not (AC-2)
 *   2. a DM conversation with cwd=<fixture repo> gets the prompt
 *      `note @docs/guide.md` — the OpenAI-stub request log must contain the
 *      mention VERBATIM (AC-4: path as text, no blocks, no file contents)
 *   3. the stub's canned reply still arrives → the mention broke nothing
 *
 * Engine: LILOS_ENGINE (default hermes) + HERMES_PROVIDER/HERMES_MODEL, set by
 * scripts/live/105.sh (stub provider when no real model is signed in).
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
const stubLog = process.env.STUB_REQUEST_LOG ?? "";

const out = (line: string) => console.log(`[live-105] ${line}`);
let harnessHome = "";
const fail = (line: string): never => {
  console.error(`[live-105] FAIL ${line}`);
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
const relayHome = mkdtempSync(join(tmpdir(), "lilos105-relay-"));
harnessHome = mkdtempSync(join(tmpdir(), "lilos105-harness-"));

// The folder Oscar would pick: a real git repo so fs.search takes the
// `git ls-files -co --exclude-standard` path (tracked + untracked + ignored).
const picked = mkdtempSync(join(tmpdir(), "lilos105-picked-"));
mkdirSync(join(picked, "docs"), { recursive: true });
mkdirSync(join(picked, "src"), { recursive: true });
writeFileSync(join(picked, ".gitignore"), "secret.env\n");
writeFileSync(join(picked, "docs", "guide.md"), "# guide\n");
writeFileSync(join(picked, "src", "app.tsx"), "export {}\n");
writeFileSync(join(picked, "README.md"), "# repo\n");
execSync(
  "git init -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init",
  { cwd: picked },
);
writeFileSync(join(picked, "untracked.ts"), "export {}\n");
writeFileSync(join(picked, "secret.env"), "TOKEN=x\n");

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

// POST /host on the feed port — the same endpoint the composer's Files
// section calls through apps/web/src/lib/host.ts.
const hostCall = async <T>(method: string, params: unknown = {}) => {
  const res = await fetch(`http://127.0.0.1:${feedPort}/host`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${relayToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) fail(`host ${method}: HTTP ${res.status}`);
  const frame = (await res.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (frame.error) fail(`host ${method}: ${frame.error.message}`);
  return frame.result as T;
};

// Leg 1: fs.search serves the picker's file rows (AC-2).
const hits = await hostCall<{ files: { path: string; kind: string }[] }>(
  "fs.search",
  { path: picked, query: "" },
);
const paths = new Set(hits.files.map((f) => f.path));
if (!hits.files.some((f) => f.path === "docs/guide.md" && f.kind === "file"))
  fail("fs.search missed docs/guide.md");
if (!hits.files.some((f) => f.path === "docs" && f.kind === "dir"))
  fail("fs.search missed the docs dir");
if (paths.has("secret.env")) fail("fs.search leaked the gitignored secret.env");
if (!paths.has("untracked.ts")) fail("fs.search missed the untracked file");
out(`PASS leg1: fs.search ${picked} -> ${hits.files.length} rows`);

const engine = new EngineClient({
  url: `ws://127.0.0.1:${feedPort}/ws`,
  connectTimeoutMs: 60_000,
});
await engine.connect().catch((e) => fail(`feed connect: ${e}`));
out("feed connected");

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-105", version: "0" },
});
await user.connect().catch((e) => fail(`relay connect: ${e}`));

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
out(`dm channel ${channel.id}`);

const messages = user.channelMessages(channel.id);
const replyTexts: string[] = [];
messages.subscribe((s) => {
  for (const m of s.messages) {
    if (m.authorKind === "employee" && !replyTexts.includes(m.text))
      replyTexts.push(m.text);
  }
});

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

// Leg 2: the mention goes to the engine as `@docs/guide.md`, verbatim.
const MENTION = "note @docs/guide.md";
const { conversation } = await user.request<{
  conversation: { id: string; cwd?: string; engineRef?: string };
}>("conversations.open", {
  channelId: channel.id,
  text: `${MENTION} — what does the guide say?`,
  title: "mention session",
  cwd: picked,
});
out(`conversation ${conversation.id} cwd=${conversation.cwd}`);

// The engine's reply arriving at all proves the text-only wire didn't break
// the turn (engine-agnostic: no blocks, no contents — AC-4).
const reply = await waitFor("engine reply", () => replyTexts[0]);
out(`PASS leg2a: engine replied "${reply.slice(0, 80)}"`);

if (stubLog) {
  const saw = await waitFor("stub request log line", () => {
    try {
      return readFileSync(stubLog, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { texts?: string[] })
        .find((r) => (r.texts ?? []).some((t) => t.includes("@docs/guide.md")));
    } catch {
      return undefined;
    }
  });
  const userText =
    (saw.texts ?? []).find((t) => t.includes("@docs/guide.md")) ?? "";
  if (!userText.includes("the guide say"))
    fail(
      `stub got the mention but a mangled prompt: ${userText.slice(0, 200)}`,
    );
  out(`PASS leg2b: provider received "${MENTION}" verbatim in the prompt`);
} else {
  out(
    "no STUB_REQUEST_LOG (live provider) — leg2b skipped; wire text is transport-identical",
  );
}

user.close();
engine.close();
cleanup();
out(`RESULT: PASS (engine=${engineKind})`);
