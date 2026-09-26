/**
 * Drive a real turn through the *installed* relay + harness for the macOS
 * verification legs (AC-3/AC-4/AC-5). Talks the same app protocol as the web
 * app — nothing here touches internals, so the engine under test can be the
 * bundled fake or Hermes unchanged.
 *
 *   bun apps/desktop/scripts/drive-turn.ts open    "Add a footer to the page"
 *   bun apps/desktop/scripts/drive-turn.ts approve <conversationId>
 *   bun apps/desktop/scripts/drive-turn.ts messages <channelId>
 *
 * Reads the relay token from ~/.lilos/relay-token (written by the relay
 * agent). Prints JSON so check.sh can assert on it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";

const LILOS_HOME = process.env.LILOS_HOME ?? join(homedir(), ".lilos");
const TOKEN_PATH = join(LILOS_HOME, "relay-token");
const STATE_PATH = join(LILOS_HOME, "drive-turn.json");
const RELAY_URL = process.env.LILOS_RELAY_URL ?? "ws://127.0.0.1:4577/ws";

interface State {
  employeeId: string;
  channelId: string;
  conversationId?: string;
}

const readState = (): State => {
  if (!existsSync(STATE_PATH))
    throw new Error("no drive state — run `open` first");
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
};

const connect = async (): Promise<RelayClient> => {
  const token = readFileSync(TOKEN_PATH, "utf8").trim();
  const client = new RelayClient({
    url: RELAY_URL,
    token,
    client: { name: "drive-turn", version: "0" },
  });
  await client.connect();
  return client;
};

const [cmd, arg1] = process.argv.slice(2);
const client = await connect();
try {
  if (cmd === "open") {
    const { employee } = await client.request<{
      employee: { id: string };
    }>("employees.create", {
      name: `Ada ${Date.now() % 10_000}`,
      role: "engineer",
      profile: "builder",
    });
    const { channel } = await client.request<{
      channel: { id: string };
    }>("channels.openDm", { employeeId: employee.id });
    const { conversation } = await client.request<{
      conversation: { id: string };
    }>("conversations.open", {
      channelId: channel.id,
      text: arg1 ?? "Summarize the repo layout",
    });
    const state: State = {
      employeeId: employee.id,
      channelId: channel.id,
      conversationId: conversation.id,
    };
    writeFileSync(STATE_PATH, JSON.stringify(state));
    console.log(JSON.stringify(state));
  } else if (cmd === "approve") {
    const { conversationId } = readState();
    const { asks } = await client.request<{
      asks: { id: string; state: string }[];
    }>("asks.list", { conversationId, state: "open" });
    for (const ask of asks) {
      await client.request("asks.respond", { askId: ask.id, outcome: "once" });
    }
    console.log(JSON.stringify({ approved: asks.length }));
  } else if (cmd === "messages") {
    const { channelId } = readState();
    const { messages } = await client.request<{
      messages: { id: string; authorKind: string; text: string }[];
    }>("messages.list", { channelId, limit: 50 });
    console.log(
      JSON.stringify(
        messages.map((m) => ({ author: m.authorKind, text: m.text })),
        null,
        1,
      ),
    );
  } else if (cmd === "state") {
    const { conversationId } = readState();
    const { conversations } = await client.request<{
      conversations: { id: string; state: string; engineRef: string | null }[];
    }>("conversations.list", {});
    console.log(
      JSON.stringify(conversations.find((c) => c.id === conversationId)),
    );
  } else {
    console.error("usage: drive-turn.ts open|approve|messages|state");
    process.exit(2);
  }
} finally {
  client.close();
}
