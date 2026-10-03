/**
 * End-to-end demo of the workspace harness against real processes:
 *
 *   bun apps/harness/scripts/demo.ts [--engine fake|hermes|url] [--seconds N]
 *
 * Spawns the real relay (fresh home, free port) and the real harness
 * (`apps/harness/src/index.ts`), then drives a scripted user over
 * `@lilos/client-runtime`: open a DM with a new employee, post a message,
 * stream the turn back, auto-approve any asks, send a follow-up, and print a
 * transcript. Exit 0 when the employee's answer arrives, 1 on timeout.
 *
 * The engine selection is the same env the harness uses:
 *   LILOS_ENGINE=fake (default) | hermes | url + LILOS_ENGINE_URL
 *   HERMES_PROVIDER / HERMES_MODEL for the hermes leg.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";
import type { AppMessage, Ask } from "@lilos/contracts/app";
import {
  cleanup,
  freePort,
  launch,
  waitForFile,
} from "../../../scripts/live/lib/helpers";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(arg("seconds", "60") ?? "60");
const engineKind = arg("engine", process.env.LILOS_ENGINE ?? "fake") ?? "fake";

const out = (line: string) => console.log(`[demo] ${line}`);
const fail = (line: string): never => {
  console.error(`[demo] FAIL ${line}`);
  try {
    console.error(readFileSync(join(harnessHome, "harness.log"), "utf8"));
  } catch {
    /* no log file */
  }
  process.exit(1);
};

const port = await freePort();
// The harness feed port defaults to 4581 — pick a free one so the demo
// doesn't collide with another harness on a shared machine.
const feedPort = await freePort();

const relayHome = mkdtempSync(join(tmpdir(), "lilos-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos-harness-"));
out(`relay home ${relayHome}`);

process.on("SIGINT", () => {
  cleanup(relayHome, harnessHome);
  process.exit(130);
});

launch("relay", ["bun", "apps/relay/src/index.ts"], {
  LILOS_RELAY_HOME: relayHome,
  LILOS_RELAY_PORT: String(port),
});

const relayToken = await waitForFile(join(relayHome, "relay-token")).catch(
  (e) => fail(String(e)),
);
const relayUrl = `ws://127.0.0.1:${port}/ws`;
out(`relay ws ${relayUrl}`);

// Wait until the WS endpoint answers before starting the harness.
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
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});
out(`harness launched (engine=${engineKind})`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-demo-user", version: "0" },
});
const welcome = await user.connect().catch((e) => fail(`connect: ${e}`));
out(`connected; engineHost=${JSON.stringify(welcome.engineHost ?? null)}`);

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
out(`dm channel ${channel.id}`);

const messages = user.channelMessages(channel.id);
const transcript: string[] = [];
const printMsg = (m: AppMessage) => {
  const who =
    m.authorId === "user" ? "you" : m.authorId === "system" ? "sys" : "ada";
  const line = `${who}> ${m.text}`;
  transcript.push(line);
  console.log(`    ${line}`);
};
messages.subscribe((s) => {
  for (const m of s.messages) {
    if (!transcript.includes(`${m.authorId}:${m.id}`)) {
      transcript.push(`${m.authorId}:${m.id}`);
      printMsg(m);
    }
  }
});

const seenAsks = new Set<string>();
user.onEvent((method, params) => {
  if (method === "ask.opened") {
    const ask = (params as { ask?: Ask }).ask;
    if (ask && !seenAsks.has(ask.id)) {
      seenAsks.add(ask.id);
      const req = ask.request;
      const what =
        req.kind === "approval"
          ? req.command
          : req.kind === "question"
            ? req.question
            : `plan ${req.planId}`;
      const outcome =
        req.kind === "question"
          ? "answer"
          : req.kind === "plan"
            ? "approve"
            : "once";
      out(`ask.opened ${req.kind} ${what}`);
      void user
        .request("asks.respond", {
          askId: ask.id,
          outcome,
          ...(req.kind === "question" ? { answer: "go ahead" } : {}),
        })
        .then(() => out(`ask ${ask.id} answered`));
    }
  }
});

const { conversation } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "add a line to notes.txt saying hello from lilos",
  title: "first task",
});
out(`conversation ${conversation.id}`);

const answerSeen = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("no employee answer in time")),
    seconds * 1000,
  );
  const unsub = messages.subscribe((s) => {
    if (
      s.messages.some(
        (m) => m.authorKind === "employee" && m.authorId !== "system",
      )
    ) {
      clearTimeout(timer);
      unsub();
      resolve();
    }
  });
});

await answerSeen.catch((e) => fail(String(e)));
out("employee answer received");

// Interrupt path: post a second prompt then interrupt the turn.
await user.request("messages.post", {
  channelId: channel.id,
  conversationId: conversation.id,
  text: "actually change the whole file",
});
await new Promise((r) => setTimeout(r, 800));
await user.request("turns.interrupt", { conversationId: conversation.id });
out("turns.interrupt sent");

await new Promise((r) => setTimeout(r, 2_000));
user.close();
cleanup(relayHome, harnessHome);
out("PASS");
process.exit(0);
