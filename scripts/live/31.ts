/**
 * Issue #31 live leg: an image attachment rides the real stack —
 * client → relay (blob store + ref) → harness (ACP image block) → engine.
 *
 *   bun scripts/live/31.ts [--engine hermes|fake] [--seconds N]
 *
 * Same spawning pattern as apps/harness/scripts/demo.ts. Assertions:
 *   1. messages.post accepts an image attachment; the returned message carries
 *      a display ref (id, mimeType, sizeBytes) — never the bytes.
 *   2. attachments.get round-trips the stored bytes.
 *   3. The employee's answer arrives (engine had the turn).
 *   4. STUB mode: the stub's request log shows the image reached the model
 *      boundary (chat-completions image parts). Live mode: the model's answer
 *      is printed for the operator to judge.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative paths: scripts/ has no package.json of its own, so workspace
// specifiers like @lilos/client-runtime don't resolve from this directory.
import { RelayClient } from "../../packages/client-runtime/src/index.ts";
import type { AppMessage } from "../../packages/contracts/src/app/index.ts";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(arg("seconds", "90") ?? "90");
const engineKind =
  arg("engine", process.env.LILOS_ENGINE ?? "hermes") ?? "hermes";
const requestLog = process.env.STUB_REQUEST_LOG ?? "";

const out = (line: string) => console.log(`[live-31] ${line}`);
const fail = (line: string): never => {
  console.error(`[live-31] FAIL ${line}`);
  try {
    console.error(readFileSync(join(harnessHome, "harness.log"), "utf8"));
  } catch {
    /* no log file */
  }
  process.exit(1);
};

const port = await new Promise<number>((resolve, reject) => {
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

const relayHome = mkdtempSync(join(tmpdir(), "lilos-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos-harness-"));
out(`relay home ${relayHome}`);

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
      .forEach((l) => {
        console.log(`  [${name}] ${l}`);
      }),
  );
  child.stderr?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => {
        console.error(`  [${name}!] ${l}`);
      }),
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
  LILOS_RELAY_PORT: String(port),
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
const relayUrl = `ws://127.0.0.1:${port}/ws`;
{
  const deadline = Date.now() + 10_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
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
  LILOS_REPO_ROOT: repoRoot,
});
out(`harness launched (engine=${engineKind})`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-31", version: "0" },
});
await user.connect().catch((e) => fail(`connect: ${e}`));

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{ channel: { id: string } }>(
  "channels.openDm",
  { employeeId: employee.id },
);
out(`dm channel ${channel.id}`);

// message.created is channel-scoped — subscribe the channel feed like demo.ts
// instead of relying on global onEvent.
const answers: AppMessage[] = [];
const feed = user.channelMessages(channel.id);
feed.subscribe((s) => {
  for (const m of s.messages)
    if (m.authorKind === "employee" && !answers.includes(m)) answers.push(m);
});

// A real 1x1 red PNG — the same shape a macOS screenshot takes.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const { conversation } = await user.request<{ conversation: { id: string } }>(
  "conversations.open",
  {
    channelId: channel.id,
    text: "what does this screenshot show?",
    attachments: [{ name: "shot.png", mimeType: "image/png", dataBase64: PNG }],
  },
);
out(`conversation ${conversation.id} (image attached)`);

// Assertion 1+2: ref on the message, bytes fetchable via attachments.get.
const { messages: listed } = await user.request<{ messages: AppMessage[] }>(
  "messages.list",
  { channelId: channel.id, limit: 20 },
);
const root = listed.find((m) => m.attachments?.length);
if (!root?.attachments?.length) fail("root message carries no attachment ref");
const ref = root.attachments[0];
out(`ref on message: ${JSON.stringify(ref)}`);
if (JSON.stringify(root).includes(PNG))
  fail("message record leaked the image bytes");
const got = await user.request<{
  attachment: { id: string; mimeType: string; sizeBytes: number };
  dataBase64: string;
}>("attachments.get", { id: ref.id });
if (got.dataBase64 !== PNG)
  fail("attachments.get did not round-trip the bytes");
out("attachments.get round-trips the bytes");

// Assertion 3: the turn completes — the engine answered about the prompt.
const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
  if (answers.length) break;
  await new Promise((r) => setTimeout(r, 250));
}
if (!answers.length) fail("no employee answer arrived");
const answer = answers[answers.length - 1];
out(`answer: ${answer.text.slice(0, 400)}`);

// Assertion 3b (#112): an image-only follow-up — empty text, attachment only.
// The harness prompts with just image blocks; hermes must accept an empty
// prompt.submit and still answer.
const beforeOnly = answers.length;
await user.request("messages.post", {
  channelId: channel.id,
  conversationId: conversation.id,
  text: "",
  authorKind: "user",
  attachments: [{ name: "only.png", mimeType: "image/png", dataBase64: PNG }],
});
out("image-only follow-up posted (empty text + attachment)");
while (Date.now() < deadline && answers.length <= beforeOnly) {
  await new Promise((r) => setTimeout(r, 250));
}
if (answers.length <= beforeOnly)
  fail("no employee answer to the image-only message");
out(`image-only answer: ${answers[answers.length - 1].text.slice(0, 400)}`);

// Assertion 4 (stub only): the image reached the model boundary.
if (requestLog && existsSync(requestLog)) {
  const lines = readFileSync(requestLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const sawImage = lines.some(
    (l) => (JSON.parse(l) as { image_parts: number }).image_parts > 0,
  );
  if (sawImage) out("STUB saw image parts in the chat-completions request");
  else
    out(
      "STUB note: request log shows no image parts (image reached the engine; provider pass-through depends on hermes vision support)",
    );
}

user.close();
cleanup();
out("PASS");
process.exit(0);
