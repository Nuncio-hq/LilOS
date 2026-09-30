/**
 * Issue #160 live leg — engine-fake with REAL provider slugs on its models.
 *
 * The stock fake catalog reports one provider ("fake") which renders the
 * generic chip; that can't exercise the picker's models.dev logos or the
 * per-provider groups. This shim is serve.ts verbatim except the
 * `models.list` result is rewritten: each fake model keeps its id (so
 * `session.setModel`'s catalog validation still passes — provider is a
 * passthrough field end to end) but reports a real provider slug, and the
 * providers list advertises the same real slugs.
 *
 *   bun scripts/live/160-engine.ts [--port N] [--watch-stdin]
 *
 * Drives through the harness's `LILOS_ENGINE=command` seam:
 *   LILOS_ENGINE_COMMAND="bun scripts/live/160-engine.ts"
 */
import { FakeEngine } from "../../packages/engine-fake/src/engine.js";
import {
  eventFrame,
  handleJsonRpc,
} from "../../packages/engine-fake/src/transport.js";

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

/* Model id -> the provider slug the demo catalog reports. Chosen so every
   ladder shape lands on a different real logo: a fast+ladder model, a
   long-ladder model, a no-ladder model, and a "/" id. */
const PROVIDER_OF: Record<string, string> = {
  "fake-large": "anthropic",
  "fake-reasoning": "openai",
  "fake/opus-2": "google",
  "fake-fresh": "zai",
  "fake-small": "xai",
};
const PROVIDERS = [
  { id: "anthropic", name: "Anthropic" },
  { id: "google", name: "Google" },
  { id: "openai", name: "OpenAI" },
  { id: "xai", name: "xAI" },
  { id: "zai", name: "Z.AI" },
];

const engine = new FakeEngine({ tick: arg("tick", 25) });
const clients = new Set<{ send: (s: string) => void }>();
engine.onEvent((e) => {
  const frame = eventFrame(e);
  for (const ws of clients) ws.send(frame);
});

if (flag("watch-stdin")) {
  process.stdin.resume();
  process.stdin.once("end", () => process.exit(0));
  process.stdin.once("close", () => process.exit(0));
  process.stdin.once("error", () => process.exit(0));
}

/* Rewrite only a models.list RESULT; everything else passes through. */
const rewrite = (raw: string): string => {
  let msg: { id?: unknown; result?: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    return raw;
  }
  const res = msg.result as
    | {
        models?: { id: string; provider?: string }[];
        providers?: { id: string; name: string }[];
        defaultProvider?: string;
      }
    | undefined;
  if (res?.models && res.providers) {
    for (const m of res.models) m.provider = PROVIDER_OF[m.id] ?? m.provider;
    res.providers = PROVIDERS;
    const def = (res as { default?: string }).default;
    res.defaultProvider = (def && PROVIDER_OF[def]) || "anthropic";
  }
  return JSON.stringify(msg);
};

const server = Bun.serve({
  port: arg("port", 0),
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" && srv.upgrade(req)) return;
    return new Response("engine-fake (#160 real-provider shim): /ws", {
      status: 404,
    });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
    },
    async message(ws, message) {
      const res = await handleJsonRpc(
        engine,
        typeof message === "string" ? message : Buffer.from(message).toString(),
      );
      if (res !== null) ws.send(rewrite(res));
    },
    close(ws) {
      clients.delete(ws);
    },
  },
});

console.log(`LISTENING ws://127.0.0.1:${server.port}/ws`);
