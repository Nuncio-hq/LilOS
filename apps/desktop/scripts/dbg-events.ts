import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
const token = readFileSync(join(homedir(), ".lilos", "relay-token"), "utf8").trim();
const state = JSON.parse(readFileSync(join(homedir(), ".lilos", "drive-turn.json"), "utf8"));
const ws = new WebSocket("ws://127.0.0.1:4577/ws");
let id = 0;
const call = (method: string, params: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }));
ws.on("message", (d) => console.log("<<", d.toString().slice(0, 300)));
ws.on("open", () => {
  call("session.hello", { protocolVersion: 1, token, client: { name: "dbg", version: "0" } });
  setTimeout(() => call("channel.subscribe", { channelId: state.channelId }), 300);
  setTimeout(() => call("messages.post", { channelId: state.channelId, conversationId: state.conversationId, text: "ping", authorKind: "user" }), 800);
  setTimeout(() => ws.close(), 2500);
});
