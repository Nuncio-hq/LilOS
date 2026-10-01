#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Issue #339 live check — the Connect seam for real:
 *
 *   - Install the bundled `lilos` plugin onto a Hermes profile exactly like
 *     the harness's HermesConnect does (copy into
 *     <HERMES_HOME>/profiles/<p>/plugins/lilos + `hermes -p <p> plugins
 *     enable lilos`) and prove the CLI reports it enabled (AC-1 mechanism).
 *   - `hermes acp` on that profile WITH the LilOS gateway env +
 *     HERMES_SESSION_SOURCE=lilos: the plugin registers the gateway catalog
 *     as native `lilos_*` tools and a prompt actually drives
 *     `lilos_terminal_run` onto the LilOS session's PTY (AC-2/AC-3).
 *   - `hermes acp` on the SAME profile WITHOUT the env: the plugin is inert
 *     — no lilos_* tools reach the model (AC-2 negative leg).
 *
 * Modes:
 *   stub (default): a scratch HERMES_HOME registers `lilos-stub`, a
 *     deterministic OpenAI-compatible provider in this script — the stub
 *     records offered tools and answers tool calls, so both legs are
 *     deterministic without a real LLM.
 *   real: HERMES_PROVIDER + HERMES_MODEL set -> the real ~/.hermes is used;
 *     the dedicated profile `l339live` is created (never touched: Oscar's
 *     own profiles), the plugin installed+enabled there, and a real model
 *     is asked to call `lilos_terminal_run`. (HERMES_PROFILE overrides the
 *     profile name.)
 *
 * Prints PASS/FAIL per check plus a summary line. Exit 0 = all pass.
 */
import { serveSurfaces } from "../../apps/harness/src/surfaces/server.ts";

const MARKER = `LIVE339-${Math.random().toString(36).slice(2, 8)}`;
const REAL_PROVIDER = (process.env.HERMES_PROVIDER || "").trim();
const REAL_MODEL = (process.env.HERMES_MODEL || "").trim();
const PROFILE = (process.env.HERMES_PROFILE || "l339live").trim();
const PLUGIN_SRC = join(process.cwd(), "packages/engine-hermes/plugin/lilos");
const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";
const HOME = process.env.HOME ?? "/tmp";

const results: [boolean, string, string][] = [];
const check = (ok: boolean, name: string, detail = "") => {
  results.push([ok, name, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── MCP streamable-HTTP client (reads back the session PTY) ─────────────────

class HttpMcp {
  private nextId = 0;
  constructor(
    private base: string,
    private token: string,
    private session?: string,
  ) {}
  private async post(msg: Record<string, unknown>) {
    return fetch(`${this.base}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.token}`,
        ...(this.session ? { "x-lilos-session": this.session } : {}),
      },
      body: JSON.stringify(msg),
    });
  }
  async request(method: string, params: Record<string, unknown> = {}) {
    const res = await this.post({
      jsonrpc: "2.0",
      id: ++this.nextId,
      method,
      params,
    });
    const text = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    const payload = ct.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("")
      : text;
    return { status: res.status, body: payload ? JSON.parse(payload) : null };
  }
}

// ── tiny stdio JSON-RPC client (ACP) ─────────────────────────────────────────

class StdioRpc {
  private buf = "";
  private waiters = new Map<number, (v: unknown) => void>();
  private nextId = 0;
  constructor(private proc: ReturnType<typeof spawn>) {
    this.proc.stdout?.on("data", (d) => {
      this.buf += d.toString();
      for (;;) {
        const i = this.buf.indexOf("\n");
        if (i < 0) break;
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.id === "number" && this.waiters.has(msg.id)) {
          this.waiters.get(msg.id)!(msg);
          this.waiters.delete(msg.id);
        }
      }
    });
  }
  request(
    method: string,
    params: unknown,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    this.proc.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${method} timed out`)),
        timeoutMs,
      );
      this.waiters.set(id, (v) => {
        clearTimeout(t);
        resolve(v as Record<string, unknown>);
      });
    });
  }
}

// ── deterministic OpenAI-compatible stub provider (same shape as live-337) ──
// Records offered tool names per request; calls lilos_terminal_run (native
// hermes tool here — no mcp__ prefix) or routes through tool_search when
// that is what the engine offers.

interface SeenReq {
  tools: string[];
  lastText: string;
}

function startStub() {
  const seen: SeenReq[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: ["stub-model-a"].map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "lilos-stub",
          })),
        });
      }
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json()) as {
          stream?: boolean;
          tools?: { function?: { name?: string } }[];
          messages?: { role: string; content?: unknown; name?: string }[];
        };
        const tools = (body.tools ?? [])
          .map((t) => t.function?.name ?? "")
          .filter(Boolean);
        const last = [...(body.messages ?? [])].reverse()[0];
        const lastText =
          typeof last?.content === "string"
            ? last.content
            : JSON.stringify(last?.content ?? "");
        seen.push({ tools, lastText: lastText.slice(0, 400) });
        const msgs = body.messages ?? [];
        const toolMsgs = msgs.filter((m) => m.role === "tool");
        const toolText = (m: { content?: unknown }) =>
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content ?? "");
        const termTool = tools.find((n) =>
          /^(lilos_terminal_run|.*lilos.*terminal_run)$/.test(n),
        );
        const searched = toolMsgs.some((m) =>
          /lilos_terminal_run/.test(toolText(m)),
        );
        const ranLilos = toolMsgs.some((m) => /FROM-MODEL/.test(toolText(m)));
        // The plugin's call-boundary refusal — the exact pre_tool_call
        // phrase, not just "refus" (our own tool description says "refused
        // elsewhere" and lands in tool_search results).
        const refused = toolMsgs.some((m) =>
          /only runs inside a LilOS session|was not created by LilOS|inert here/i.test(
            toolText(m),
          ),
        );
        // tool_search can never find a tool that isn't registered (the
        // plain-session leg) — stop searching after a few misses instead of
        // looping until the context compacts.
        const searchedOut = toolMsgs.length >= 8;
        const searchTool = tools.find((n) => /^tool_search$/i.test(n));
        const callTool = tools.find((n) => /^tool_call$/i.test(n));
        const wantCall = ranLilos || refused || searchedOut
          ? null
          : termTool
            ? {
                id: "call_lilos_1",
                name: termTool,
                arguments: { command: `echo ${MARKER}-FROM-MODEL` },
              }
            : searched && callTool
              ? {
                  id: "call_lilos_2",
                  name: callTool,
                  arguments: {
                    calls: [
                      {
                        name: "lilos_terminal_run",
                        arguments: { command: `echo ${MARKER}-FROM-MODEL` },
                      },
                    ],
                  },
                }
              : searchTool
                ? {
                    id: `call_search_${toolMsgs.length}`,
                    name: searchTool,
                    arguments: { queries: ["terminal_run"] },
                  }
                : null;
        const toolCallDelta = (call: {
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        }) => ({
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              },
            ],
          },
        });
        const toolCallMsg = (call: {
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        }) => ({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            },
          ],
        });
        const sse = (chunks: Record<string, unknown>[]) => {
          const payload =
            chunks
              .map(
                (c) =>
                  `data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 0, model: "stub-model-a", choices: [{ index: 0, ...c }] })}\n\n`,
              )
              .join("") + "data: [DONE]\n\n";
          return new Response(payload, {
            headers: { "content-type": "text/event-stream" },
          });
        };
        if (body.stream) {
          if (wantCall) {
            return sse([
              toolCallDelta(wantCall),
              { delta: {}, finish_reason: "tool_calls" },
            ]);
          }
          return sse([
            { delta: { role: "assistant", content: `stub:${MARKER}` } },
            { delta: {}, finish_reason: "stop" },
          ]);
        }
        if (wantCall) {
          return Response.json({
            id: "chatcmpl-stub",
            object: "chat.completion",
            created: 0,
            model: "stub-model-a",
            choices: [
              {
                index: 0,
                message: toolCallMsg(wantCall),
                finish_reason: "tool_calls",
              },
            ],
          });
        }
        return Response.json({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: 0,
          model: "stub-model-a",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `stub:${MARKER}` },
              finish_reason: "stop",
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${srv.port}`,
    seen,
    stop: () => srv.stop(true),
  };
}

// ── hermes CLI helper ────────────────────────────────────────────────────────

const hermes = (args: string[], env: Record<string, string>) =>
  spawnSync(HERMES_BIN, args, {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...(process.env as Record<string, string>), ...env },
  });

async function main() {
  const mode = REAL_PROVIDER
    ? `real provider ${REAL_PROVIDER}/${REAL_MODEL || "(default)"}`
    : "STUB provider lilos-stub (deterministic; no real LLM completing turns)";
  console.log(`# issue #339 live check — mode: ${mode}`);

  const surfaces = await serveSurfaces(0);
  let stub: ReturnType<typeof startStub> | null = null;
  const acps: ReturnType<typeof spawn>[] = [];

  try {
    // 1. A bound LilOS session — the PTY `lilos_terminal_run` lands on.
    const a = await surfaces.create({
      cwd: HOME,
      binding: {
        employeeId: "emp-ada",
        channelId: "chan-ada",
        conversationId: "conv-ada",
      },
    });
    check(
      a.mcpServerHttp?.type === "http" && a.mcpServerHttp.url.endsWith("/mcp"),
      "gateway session create returns the HTTP MCP spec",
      JSON.stringify(a.mcpServerHttp),
    );
    const mcpA = new HttpMcp(`${surfaces.url}/mcp`, a.token);

    // 2. HERMES_HOME: scratch+stub provider, or the real one (only the
    //    dedicated profile is created there — Oscar's profiles untouched).
    let hermesHome = process.env.HERMES_HOME;
    if (!REAL_PROVIDER) {
      stub = startStub();
      hermesHome = mkdtempSync(join(tmpdir(), "lilos339-hermes-"));
      writeFileSync(
        join(hermesHome, "config.yaml"),
        "model:\n" +
          "  provider: lilos-stub\n" +
          "  default: stub-model-a\n" +
          "custom_providers:\n" +
          "  - name: lilos-stub\n" +
          `    base_url: ${stub.url}/v1\n` +
          "    api_key: sk-lilos-stub\n" +
          "    api_mode: chat_completions\n" +
          "    models:\n      - stub-model-a\n",
      );
    }
    const hEnv: Record<string, string> = hermesHome
      ? { HERMES_HOME: hermesHome }
      : {};

    // 3. AC-1 mechanism on the real binary: profile + plugin copy +
    //    `plugins enable` — the same steps HermesConnect.reconcile runs.
    const listed = hermes(["profile", "list"], hEnv);
    if (!`${listed.stdout}${listed.stderr}`.includes(PROFILE)) {
      const created = hermes(["profile", "create", PROFILE], hEnv);
      check(
        created.status === 0,
        `hermes profile create ${PROFILE}`,
        `${created.stdout}${created.stderr}`.slice(-120).trim(),
      );
    } else {
      check(true, `profile ${PROFILE} already present`);
    }
    const pluginsDir = join(hermesHome ?? "", "profiles", PROFILE, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    cpSync(PLUGIN_SRC, join(pluginsDir, "lilos"), { recursive: true });
    const enabled = hermes(
      ["-p", PROFILE, "plugins", "enable", "lilos"],
      hEnv,
    );
    check(
      enabled.status === 0,
      `hermes -p ${PROFILE} plugins enable lilos (AC-1)`,
      `${enabled.stdout}${enabled.stderr}`.slice(-160).trim(),
    );
    const plist = hermes(["-p", PROFILE, "plugins", "list"], hEnv);
    check(
      /lilos/.test(`${plist.stdout}${plist.stderr}`),
      "plugins list shows lilos enabled on the profile",
      `${plist.stdout}${plist.stderr}`.split("\n").find((l) => /lilos/i.test(l))?.trim() ?? "",
    );

    // The gateway env the harness sets on `hermes serve` (and that an acp
    // spawn inherits) + the session source the adapter stamps.
    const lilosEnv = {
      LILOS_SURFACES_URL: surfaces.url,
      LILOS_ENGINE_TOKEN: surfaces.engineToken,
      HERMES_SESSION_SOURCE: "lilos",
      ...hEnv,
    };
    const spawnAcp = (env: Record<string, string>) => {
      const p = spawn(HERMES_BIN, ["-p", PROFILE, "acp"], {
        env: { ...(process.env as Record<string, string>), ...env },
        cwd: HOME,
        stdio: ["pipe", "pipe", "inherit"],
      });
      acps.push(p);
      return new StdioRpc(p);
    };
    const acpInit = async (rpc: StdioRpc) => {
      await rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "lilos-live-339", version: "0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        180_000,
      );
      const snew = await rpc.request(
        "session/new",
        { cwd: HOME, mcpServers: [] },
        90_000,
      );
      return (snew.result as { sessionId?: string })?.sessionId;
    };

    // ── LilOS session leg: model sees and calls lilos_terminal_run ────────
    try {
      const rpc = spawnAcp(lilosEnv);
      const sessionId = await acpInit(rpc);
      check(!!sessionId, "hermes acp session/new on the connected profile");
      if (sessionId) {
        surfaces.bindEngineSession(a.session, sessionId);
        const stubToolsBefore = stub ? stub.seen.length : 0;
        const pr = (await rpc
          .request(
            "session/prompt",
            {
              sessionId,
              prompt: [
                {
                  type: "text",
                  text: `Call the lilos_terminal_run tool with command "echo ${MARKER}-FROM-MODEL" then say done.`,
                },
              ],
            },
            150_000,
          )
          .catch((e) => ({ error: String(e) }))) as Record<string, unknown>;
        check(
          !("error" in pr),
          "session/prompt completes (lilos session)",
          JSON.stringify(pr).slice(0, 160),
        );
        if (stub) {
          const offered = [
            ...new Set(
              stub.seen.slice(stubToolsBefore).flatMap((s) => s.tools),
            ),
          ];
          // Native tools may sit behind hermes' deferred catalog
          // (tool_search → tool_call) — either surface counts; the PTY
          // marker below is the end-to-end proof the call ran.
          check(
            offered.some((n) => /lilos_terminal_run/.test(n)) ||
              (offered.includes("tool_search") &&
                offered.includes("tool_call")),
            "hermes gave the model a path to lilos_terminal_run (AC-3)",
            offered
              .filter((n) => /lilos|tool_search|tool_call/.test(n))
              .join(","),
          );
        }
        // The marker on the session's PTY is the end-to-end proof.
        let saw = false;
        for (let i = 0; i < 40 && !saw; i++) {
          const tail = await mcpA.request("tools/call", {
            name: "terminal_read",
            arguments: { tailBytes: 8192 },
          });
          saw = JSON.stringify(tail.body ?? {}).includes(
            `${MARKER}-FROM-MODEL`,
          );
          if (!saw) await new Promise((r) => setTimeout(r, 750));
        }
        check(
          saw,
          "model-driven lilos_terminal_run landed on the session PTY (AC-3)",
        );
      }
    } catch (e) {
      check(false, "lilos-session acp leg", String(e));
    }

    // ── Plain-session leg: same profile, no LilOS env → plugin inert ──────
    try {
      const rpc = spawnAcp(hEnv); // no LILOS_*, no HERMES_SESSION_SOURCE
      const sessionId = await acpInit(rpc);
      check(!!sessionId, "hermes acp session/new (plain session)");
      if (sessionId && stub) {
        const before = stub.seen.length;
        const pr = (await rpc
          .request(
            "session/prompt",
            {
              sessionId,
              prompt: [
                {
                  type: "text",
                  text: `Call the lilos_terminal_run tool with command "echo ${MARKER}-OUTSIDE" then say done.`,
                },
              ],
            },
            120_000,
          )
          .catch((e) => ({ error: String(e) }))) as Record<string, unknown>;
        check(!("error" in pr), "session/prompt completes (plain session)");
        const offered = [
          ...new Set(stub.seen.slice(before).flatMap((s) => s.tools)),
        ];
        check(
          !offered.some((n) => /lilos_/.test(n)),
          "no lilos_* tool reaches a plain session (AC-2)",
          offered.filter((n) => /lilos|tool_search/.test(n)).join(",") ||
            "none offered",
        );
      } else if (sessionId) {
        // Real provider: ask for the tool anyway — unregistered, so no call
        // can land; the absence of the marker is the honest check.
        await rpc
          .request(
            "session/prompt",
            {
              sessionId,
              prompt: [
                {
                  type: "text",
                  text: `Call the lilos_terminal_run tool with command "echo ${MARKER}-OUTSIDE" then say done.`,
                },
              ],
            },
            120_000,
          )
          .catch(() => ({}));
        const tail = await mcpA.request("tools/call", {
          name: "terminal_read",
          arguments: { tailBytes: 8192 },
        });
        check(
          !JSON.stringify(tail.body ?? {}).includes(`${MARKER}-OUTSIDE`),
          "plain session could not run lilos_terminal_run (AC-2)",
        );
      }
    } catch (e) {
      check(false, "plain-session acp leg", String(e));
    }
  } finally {
    for (const p of acps) {
      try {
        p.kill();
      } catch {}
    }
    stub?.stop();
    await surfaces.close().catch(() => {});
  }

  const fails = results.filter(([ok]) => !ok);
  console.log(
    `\nlive-339: ${results.length - fails.length}/${results.length} passed` +
      (fails.length
        ? ` — FAILURES: ${fails.map((f) => f[1]).join(" | ")}`
        : "") +
      (!REAL_PROVIDER
        ? "\nLIVE_ENGINE_UNAVAILABLE: stub provider; set HERMES_PROVIDER+HERMES_MODEL for a real model run"
        : ""),
  );
  process.exit(fails.length ? 1 : 0);
}

await main();
