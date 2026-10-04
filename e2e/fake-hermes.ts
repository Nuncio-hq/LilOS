/**
 * e2e-only `hermes` stand-in for the engine-death watchdog specs (#482).
 *
 * Serves the Hermes gateway protocol over WebSocket so the real
 * `packages/engine-hermes` adapter + real harness + real relay run end to
 * end. The spec kills THIS process to simulate `hermes serve` dying —
 * it writes its pid to `HERMES_FAKE_PID_FILE` so the test only ever kills
 * the process it spawned (never pgrep/pkill: on a dev Mac other hermes
 * processes are real engines).
 *
 * Usage (through the adapter's `HERMES_BIN` path):
 *   fake-hermes.ts --version            → prints a supported version
 *   fake-hermes.ts serve --host H --port N --skip-build
 *        → serves /api/health + /api/ws (token query ignored), prints
 *          `HERMES_BACKEND_READY port=<bound>` on stdout.
 *
 * Env:
 *   HERMES_FAKE_PID_FILE    — the serve child writes its own pid here.
 *   HERMES_FAKE_STATE_FILE  — JSON {sessions:{ref:row}, resumes:[], next}
 *                             persisted across kills so session.resume
 *                             survives a backend restart (AC-2 memory).
 *   FAKE_SERVE_FAIL_FILE    — while this file exists `serve` exits 1 —
 *                             the adapter's relaunch loop keeps retrying so
 *                             the spec can hold the outage open for the
 *                             System-status screenshot (AC-3).
 *   FAKE_COMPLETE_DELAY_MS  — delay before message.complete (default 200).
 *
 * Behaviors the specs lean on:
 *   - `model.options` with `refresh:true` never answers (held in-flight).
 *   - a prompt containing `HOLD_TURN` never completes (held turn).
 *   - `session.resume` accepts a stored ref OR a previous runtime sid and
 *     returns a NEW sid bound to the same stored ref (memory continuity).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Json = Record<string, unknown>;

interface StoredRow {
  ref: string;
  profile: string;
  sids: string[];
  message_count: number;
  title?: string;
}
interface FakeState {
  sessions: Record<string, StoredRow>;
  resumes: { at: string; requested: string; ref: string }[];
  created: { at: string; ref: string; profile: string }[];
  next: number;
}

const stateFile = process.env.HERMES_FAKE_STATE_FILE;
const readState = (): FakeState => {
  if (stateFile && existsSync(stateFile)) {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8")) as FakeState;
    } catch {
      /* corrupt → start clean */
    }
  }
  return { sessions: {}, resumes: [], created: [], next: 1 };
};
const writeState = (s: FakeState) => {
  if (stateFile) writeFileSync(stateFile, JSON.stringify(s, null, 2));
};

const completeDelayMs = Number(process.env.FAKE_COMPLETE_DELAY_MS ?? 200);

/* One socket per connection; events broadcast to every connected client —
   the adapter keeps a single gateway socket, so this just reaches it. */
const clients = new Set<{ send(d: string): void }>();
const emit = (frame: Json) => {
  const data = JSON.stringify(frame);
  for (const ws of clients) ws.send(data);
};

const PROVIDER = {
  slug: "fake-stub",
  name: "Fake Stub",
  models: ["fake-model-1", "fake-model-2"],
  capabilities: {},
};

const ok = (id: unknown, result: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

function handleRequest(method: string, params: Json, sessionIds: Set<string>) {
  switch (method) {
    case "client.capabilities":
      return {
        server_requests: [
          "client.question",
          "client.user_question",
          "client.secret",
          "client.commands",
          "client.approval",
          "client.edit_approval",
          "client.interactive_bash",
          "client.display_content",
          "client.patch",
        ],
      };
    case "profiles.list":
      return {
        profiles: [
          {
            name: "default",
            description: "Fake backend profile",
            soul: "You are a fake e2e backend.",
            skills: [],
            model: { provider: PROVIDER.slug, default: PROVIDER.models[0] },
          },
        ],
      };
    case "profiles.describe":
      return {
        name: "default",
        description: "Fake backend profile",
        soul: "You are a fake e2e backend.",
        model: { provider: PROVIDER.slug, default: PROVIDER.models[0] },
        skills: [],
        toolsets: [],
        mcp_servers: [],
      };
    case "profiles.create":
    case "profiles.configure":
      return params;
    case "model.options":
      /* Held request — the watchdog spec's in-flight leg (AC-1). */
      if (params.refresh === true) return "__hold__";
      return {
        providers: [PROVIDER],
        model: PROVIDER.models[0],
        provider: PROVIDER.slug,
      };
    case "config.get":
      if (params.key === "approvals.mode")
        return { key: "approvals.mode", value: "smart" };
      return "__err__4002_unknown config key__";
    case "config.set":
      return { key: params.key, value: params.value, scope: params.scope };
    case "session.create": {
      const st = readState();
      const n = st.next++;
      const ref = `fake-ref-${n}`;
      const sid = `fake-sid-${n}`;
      st.sessions[ref] = {
        ref,
        profile: String(params.profile ?? "default"),
        sids: [sid],
        message_count: 0,
      };
      st.created.push({
        at: new Date().toISOString(),
        ref,
        profile: String(params.profile ?? "default"),
      });
      writeState(st);
      sessionIds.add(sid);
      return {
        session_id: sid,
        stored_session_id: ref,
        message_count: 0,
        messages: [],
        info: { version: "v0.21.5+482fake", release_date: "2026.10.1" },
      };
    }
    case "session.resume": {
      const st = readState();
      const want = String(params.session_id ?? "");
      /* accept the stored ref OR any earlier runtime sid for it */
      let row = st.sessions[want];
      if (!row)
        row = Object.values(st.sessions).find((r) => r.sids.includes(want));
      if (!row) return "__err__4040_no such session__";
      const sid = `fake-sid-${st.next++}`;
      row.sids.push(sid);
      st.resumes.push({
        at: new Date().toISOString(),
        requested: want,
        ref: row.ref,
      });
      writeState(st);
      sessionIds.add(sid);
      return {
        session_id: sid,
        stored_session_id: row.ref,
        message_count: row.message_count,
        messages: [],
        messages_omitted: true,
        info: { version: "v0.21.5+482fake", release_date: "2026.10.1" },
      };
    }
    case "session.close":
      return { closed: true };
    case "session.title": {
      const st = readState();
      const ref = String(params.session_key ?? "");
      if (st.sessions[ref]) {
        st.sessions[ref].title = String(params.title ?? "");
        writeState(st);
      }
      return { title: params.title ?? "", session_key: ref };
    }
    case "session.steer":
      return { status: "queued", text: params.text ?? "" };
    case "session.interrupt":
      return { status: "interrupted" };
    case "session.undo":
      return { ok: true };
    case "session.set_hidden":
      return { ok: true };
    case "prompt.submit": {
      const sid = String(params.session_id ?? "");
      const text = String(params.text ?? "");
      emit({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "session.info",
          session_id: sid,
          payload: { model: PROVIDER.models[0], effort: null },
        },
      });
      if (!text.includes("HOLD_TURN")) {
        const st = readState();
        const row = Object.values(st.sessions).find((r) =>
          r.sids.includes(sid),
        );
        if (row) {
          row.message_count += 1;
          writeState(st);
        }
        setTimeout(() => {
          const answer = `fake answer: ${text.slice(0, 80)}`;
          /* The engine builds the posted answer from message.delta streams —
             message.complete's own `text` is display data only. */
          emit({
            jsonrpc: "2.0",
            method: "event",
            params: {
              type: "message.delta",
              session_id: sid,
              payload: { text: answer },
            },
          });
          emit({
            jsonrpc: "2.0",
            method: "event",
            params: {
              type: "message.complete",
              session_id: sid,
              payload: {
                text: answer,
                status: "complete",
                usage: {
                  prompt_tokens: 4,
                  completion_tokens: 7,
                  total_tokens: 11,
                },
              },
            },
          });
        }, completeDelayMs);
      }
      return { status: "streaming", user_row_id: "u1" };
    }
    case "process.list":
      return { processes: [] };
    case "process.kill":
      return "__err__4044_no such process__";
    case "image.attach_bytes":
      return { attached: true, count: 1 };
    case "slash.exec":
      return { output: "" };
    default:
      return `__err__-32601_unknown method ${method}__`;
  }
}

function onFrame(data: string, sessionIds: Set<string>): string | undefined {
  let frame: Json;
  try {
    frame = JSON.parse(data) as Json;
  } catch {
    return err(null, -32700, "parse error");
  }
  if (typeof frame.method !== "string") return undefined; // reply frames ignored
  const method = frame.method;
  if (method === "request.cancel") return undefined;
  const result = handleRequest(
    method,
    (frame.params as Json) ?? {},
    sessionIds,
  );
  if (result === "__hold__") return undefined;
  if (typeof result === "string" && result.startsWith("__err__")) {
    const m = /^__err__(-?\d+)_(.*)$/.exec(result);
    return err(frame.id, Number(m?.[1] ?? -32603), m?.[2] ?? "error");
  }
  return ok(frame.id, result);
}

function serve(argv: string[]): void {
  const failFile = process.env.FAKE_SERVE_FAIL_FILE;
  if (failFile && existsSync(failFile)) {
    process.stderr.write(
      "fake-hermes: FAKE_SERVE_FAIL_FILE set — refusing to serve\n",
    );
    process.exit(1);
  }
  const at = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const host = at("--host") ?? "127.0.0.1";
  const port = Number(at("--port") ?? 0);

  const server = Bun.serve<{ sid: Set<string> }>({
    hostname: host,
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health")
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === "/api/ws") {
        const upgraded = srv.upgrade(req, { data: { sid: new Set() } });
        return upgraded
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      return new Response("fake hermes", { status: 200 });
    },
    websocket: {
      open(ws) {
        clients.add(ws as unknown as { send(d: string): void });
        (ws as unknown as { send(d: string): void }).send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "event",
            params: { type: "gateway.ready", session_id: "", payload: {} },
          }),
        );
      },
      message(ws, message) {
        const reply = onFrame(
          typeof message === "string" ? message : String(message),
          (ws.data as { sid: Set<string> }).sid,
        );
        if (reply) ws.send(reply);
      },
      close(ws) {
        clients.delete(ws as unknown as { send(d: string): void });
      },
    },
  });

  const pidFile = process.env.HERMES_FAKE_PID_FILE;
  if (pidFile) writeFileSync(pidFile, `${process.pid}\n`);
  process.stdout.write(`HERMES_BACKEND_READY port=${server.port}\n`);
}

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv[0] === "--version") {
  process.stdout.write("Hermes Agent v0.21.5+482fake (2026.10.1)\n");
  process.exit(0);
}
if (argv[0] === "serve") serve(argv.slice(1));
else {
  process.stderr.write(`fake-hermes: unknown args ${argv.join(" ")}\n`);
  process.exit(2);
}
