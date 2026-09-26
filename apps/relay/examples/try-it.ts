/**
 * Demo: drives the running relay end to end (employee → DM → conversation →
 * messages), then shows reconnect-without-gaps. Run with Bun:
 *
 *   bun run --cwd apps/relay start          # terminal 1 — prints the token path
 *   bun run apps/relay/examples/try-it.ts   # terminal 2
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";

const home = process.env.LILOS_RELAY_HOME ?? join(homedir(), ".lilos");
const host = process.env.LILOS_RELAY_HOST ?? "127.0.0.1";
const port = process.env.LILOS_RELAY_PORT ?? "4577";
const token = readFileSync(join(home, "relay-token"), "utf8").trim();

const say = (s: string) => console.log(`\n=== ${s}`);

const client = new RelayClient({ url: `ws://${host}:${port}/ws`, token });
await client.connect();
say("connected + handshook");

const { employee } = await client.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer", model: "codex", status: "online" },
);
say(`employee: ${JSON.stringify(employee)}`);

const { channel } = await client.request<{ channel: { id: string } }>(
  "channels.openDm",
  { employeeId: employee.id },
);
say(`dm channel: ${JSON.stringify(channel)}`);

const feed = client.channelMessages(channel.id);
feed.listen((state) => {
  console.log(
    `[feed] synced=${state.synced} lastSeq=${state.lastSeq} msgs=${state.messages.length}`,
  );
});

await new Promise((r) => setTimeout(r, 300));

const { conversation } = await client.request<{ conversation: { id: string } }>(
  "conversations.open",
  { channelId: channel.id, text: "ship the release", title: "release" },
);
say(`conversation: ${JSON.stringify(conversation)}`);

await client.request("messages.post", {
  channelId: channel.id,
  conversationId: conversation.id,
  authorId: employee.id,
  authorKind: "employee",
  text: "on it — building now",
});
await new Promise((r) => setTimeout(r, 200));

const { messages } = await client.request<{
  messages: { seq: number; text: string }[];
}>("messages.list", { channelId: channel.id });
say("channel history");
for (const m of messages) console.log(`  seq ${m.seq}: ${m.text}`);

say("killing my own socket to prove seq-resume…");
// @ts-expect-error reaching into the client to simulate a dropped wire
(client as { socket?: { close(): void } }).socket?.close();
await new Promise((r) => setTimeout(r, 400));

// While "disconnected", another process posts — this session will replay it.
const other = new RelayClient({ url: `ws://${host}:${port}/ws`, token });
await other.connect();
await other.request("messages.post", {
  channelId: channel.id,
  authorId: employee.id,
  authorKind: "employee",
  text: "missed you while you were gone",
});
other.close();

await client.connect();
await new Promise((r) => setTimeout(r, 400));

const final = feed.get();
say(
  `resumed — ${final.messages.length} messages, seqs ${final.messages.map((m) => m.seq).join(",")}`,
);
console.log(`  last: "${final.messages.at(-1)?.text}"`);
client.close();
process.exit(0);
