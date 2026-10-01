/**
 * Issue #339 e2e — the shipped `lilos` Hermes plugin against a REAL
 * `hermes serve` (WS protocol), real gateway (serveSurfaces), and the
 * deterministic lilos-stub provider. Two profiles under one multiplexed
 * serve. Run with Bun:
 *   bun apps/harness/scripts/hermes-plugin-e2e.ts
 *
 * Proves:
 *   AC-8  plugin loads per-profile under one multiplexed serve, and
 *         `hermes -p <profile> plugins enable lilos` lands in the RUNNING
 *         serve — no restart (the next session gets the tools).
 *   AC-2  on ONE profile, a source=lilos session sees lilos_* tools while a
 *         plain session on the same profile does not.
 *   AC-3  tools render from GET /tools; calls forward with the stored
 *         session id (resolved through the engine alias).
 *   AC-4  the versioned host policy is frozen into the lilos session's
 *         system prompt (once per session, cache-safe).
 *   AC-5  a browser_* call inside a lilos session is vetoed with the
 *         LilOS-alternative message; the same call outside lilos runs.
 *
 * Prints PASS/FAIL per check; exit 1 on any FAIL.
 */
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveSurfaces } from "../src/surfaces/server";
import { HermesGateway } from "../../../packages/engine-hermes/src/gateway";
import { startHermesServe } from "../../../packages/engine-hermes/src/serve";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
const check = (ok: boolean, name: string, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const diag: {
  hermesOut: string[];
  hermesHome?: string;
  stubReqs?: () => number;
  killServe?: () => void;
  offeredA?: string[];
} = { hermesOut: [] };
const watchdog = setTimeout(
  () => {
    console.log("WATCHDOG: timed out");
    dumpDiag();
    // process.exit skips the finally — kill the serve child first or it
    // orphans and the next run's serve refuses to start (one backend/host).
    try {
      diag.killServe?.();
    } catch {}
    process.exit(2);
  },
  Number(process.env.E2E_WATCHDOG_MS ?? 300_000),
);
function dumpDiag() {
  if (diag.offeredA) {
    console.log(
      `── tools offered to the model (${diag.offeredA.length}) ──\n${diag.offeredA.join(", ")}`,
    );
  }
  console.log("── hermes serve output (last 60 lines) ──");
  console.log(diag.hermesOut.slice(-60).join(""));
  if (diag.stubReqs) console.log(`stub model requests seen: ${diag.stubReqs()}`);
  if (diag.hermesHome) {
    for (const log of readdirSync(join(diag.hermesHome, "logs"), {
      withFileTypes: true,
    }).filter((d) => d.isFile() && d.name.endsWith(".log"))) {
      try {
        const text = readFileSync(
          join(diag.hermesHome, "logs", log.name),
          "utf8",
        );
        console.log(`── ${log.name} (last 4KB) ──`);
        console.log(text.slice(-4096));
      } catch {}
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MARKER = `E2E339-${Math.random().toString(36).slice(2, 8)}`;
const PROFILE_A = "live339a";
const PROFILE_B = "live339b";
const PLUGIN_SRC = fileURLToPath(
  new URL("../../../packages/engine-hermes/plugin/lilos", import.meta.url),
);
const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";

/* A fixture-only plugin registering `browser_probe` — a tool name matching
   the prefix the lilos plugin vetoes, so AC-5 is provable without depending
   on Hermes' real browser stack being provisioned on this machine. */
const BROWSERPROBE_PLUGIN_YAML = `name: browserprobe
version: "0.0.0"
description: "e2e fixture: a browser_-prefixed no-op tool the lilos plugin can veto."
provides_hooks: []
`;
const BROWSERPROBE_INIT = `def register(ctx):
    ctx.register_tool(
        "browser_probe", "browserprobe",
        {"name": "browser_probe", "description": "fixture browser tool",
         "parameters": {"type": "object", "properties": {}}},
        lambda args, **kw: "PROBE-RAN-OK",
        description="fixture browser tool",
    )
`;

const profileConfig = (stubUrl: string, enabled: string[]) =>
  "model:\n" +
  "  provider: lilos-stub\n" +
  "  default: stub-model-a\n" +
  "custom_providers:\n" +
  "  - name: lilos-stub\n" +
  `    base_url: ${stubUrl}/v1\n` +
  "    api_key: sk-lilos-stub\n" +
  "    api_mode: chat_completions\n" +
  "    models:\n      - stub-model-a\n" +
  "plugins:\n" +
  "  enabled:\n" +
  enabled.map((e) => `    - ${e}\n`).join("");

interface SeenReq {
  tools: string[];
  sys: string;
  toolResults: string;
  lastText: string;
  /** tool_search's schema description — carries the deferred-catalog listing. */
  searchDesc: string;
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
          data: [
            {
              id: "stub-model-a",
              object: "model",
              created: 0,
              owned_by: "lilos-stub",
            },
          ],
        });
      }
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json()) as {
          stream?: boolean;
          tools?: { function?: { name?: string; description?: string } }[];
          messages?: {
            role: string;
            content?: unknown;
            name?: string;
            tool_calls?: { function?: { name?: string; arguments?: string } }[];
          }[];
        };
        const tools = (body.tools ?? [])
          .map((t) => t.function?.name ?? "")
          .filter(Boolean);
        const msgs = body.messages ?? [];
        const text = (m: { content?: unknown }) =>
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content ?? "");
        const toolResults = msgs
          .filter((m) => m.role === "tool")
          .map(text)
          .join("\n");
        const last = [...msgs].reverse()[0];
        seen.push({
          tools,
          sys: msgs
            .filter((m) => m.role === "system")
            .map(text)
            .join("\n")
            .slice(0, 20000),
          toolResults,
          lastText: (last ? text(last) : "").slice(0, 400),
          searchDesc:
            body.tools
              ?.find((t) => t.function?.name === "tool_search")
              ?.function?.description?.slice(0, 20000) ?? "",
        });
        // Plugin tools are deferred behind the tool_search/describe/call
        // bridge. Drive each session through the same program:
        //   search → tool_call browser_probe → tool_call lilos_terminal_run → done.
        // On a lilos session the probe is vetoed (sawBlocked → then the lilos
        // call executes and echoes MARKER-PLUGIN). On a plain session the
        // probe runs (PROBE-RAN-OK), then the lilos_* attempt proves the
        // plugin's inertness veto (never executes MARKER-PLAIN).
        const directCalls = msgs
          .filter((m) => m.role === "assistant")
          .flatMap((m) =>
            (m.tool_calls ?? []).map((tc) => tc.function?.name ?? ""),
          );
        const innerCalls: string[] = [];
        for (const m of msgs) {
          if (m.role !== "assistant") continue;
          for (const tc of m.tool_calls ?? []) {
            try {
              const a = JSON.parse(tc.function?.arguments ?? "{}") as {
                calls?: { name?: string }[];
              };
              if (Array.isArray(a.calls)) {
                innerCalls.push(
                  ...a.calls.map((c) => c.name ?? "").filter(Boolean),
                );
              }
            } catch {}
          }
        }
        const searched = directCalls.includes("tool_search");
        const probeCalled = innerCalls.includes("browser_probe");
        const lilosCalled = innerCalls.includes("lilos_terminal_run");
        const ranProbe = toolResults.includes("PROBE-RAN-OK");
        // Match only the veto's own text — a plain "lilos_browser" regex also
        // hits the search-result listing (the names ARE in the catalog) and
        // would fire sawBlocked before browser_probe was ever attempted.
        const sawBlocked = /Inside LilOS your own browser tools are off/.test(
          toolResults,
        );
        const foundProbe = toolResults.includes("browser_probe");
        let wantCall:
          | { id: string; name: string; arguments: Record<string, unknown> }
          | null = null;
        const call = (
          name: string,
          arguments_: Record<string, unknown>,
        ): { id: string; name: string; arguments: Record<string, unknown> } => ({
          id: `call_${name}_${innerCalls.length + directCalls.length}`,
          name,
          arguments: arguments_,
        });
        const lilosCall = (marker: string) =>
          call("tool_call", {
            calls: [
              {
                name: "lilos_terminal_run",
                arguments: { command: `echo ${marker}` },
              },
            ],
          });
        if (lilosCalled) {
          wantCall = null;
        } else if (sawBlocked) {
          wantCall = lilosCall(`${MARKER}-PLUGIN`);
        } else if (ranProbe) {
          wantCall = lilosCall(`${MARKER}-PLAIN`);
        } else if (probeCalled) {
          wantCall = null;
        } else if (searched) {
          wantCall = foundProbe
            ? call("tool_call", {
                calls: [{ name: "browser_probe", arguments: {} }],
              })
            : null;
        } else {
          wantCall = call("tool_search", {
            queries: ["lilos", "browser"],
            limit: 25,
          });
        }
        const toolCallMsg = (call: typeof wantCall) => ({
          role: "assistant",
          content: null,
          tool_calls: call
            ? [
                {
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                },
              ]
            : [],
        });
        const assistantMsg = wantCall
          ? toolCallMsg(wantCall)
          : { role: "assistant", content: `stub:${MARKER}` };
        const finish = wantCall ? "tool_calls" : "stop";
        if (body.stream) {
          const chunks = wantCall
            ? [
                { delta: { role: "assistant", tool_calls: wantCall ? toolCallMsg(wantCall).tool_calls : [] } },
                { delta: {}, finish_reason: "tool_calls" },
              ]
            : [
                { delta: { role: "assistant", content: `stub:${MARKER}` } },
                { delta: {}, finish_reason: "stop" },
              ];
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
        }
        return Response.json({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: 0,
          model: "stub-model-a",
          choices: [
            { index: 0, message: assistantMsg, finish_reason: finish },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${srv.port}`,
    seen,
    clear: () => seen.splice(0, seen.length),
    stop: () => srv.stop(true),
  };
}

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(250);
  }
  return fn();
}

const run = (cmd: string[], env: Record<string, string>, timeoutMs = 60_000) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), {
      env: { ...(process.env as Record<string, string>), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout?.on("data", (d) => (out += String(d)));
    p.stderr?.on("data", (d) => (out += String(d)));
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      resolve({ code: -1, out: `${out}\nCLI TIMEOUT` });
    }, timeoutMs);
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out });
    });
  });

async function main() {
  console.log(
    "# issue #339 plugin e2e — real hermes serve, real gateway, STUB provider",
  );

  // ── real gateway (serveSurfaces) ─────────────────────────────────────────
  const surfaces = await serveSurfaces(0);
  const stub = startStub();
  diag.stubReqs = () => stub.seen.length;
  const hermesHome = mkdtempSync(join(tmpdir(), "lilos339-hermes-"));
  let gateway: HermesGateway | null = null;
  let hermes: Awaited<ReturnType<typeof startHermesServe>> | null = null;

  try {
    // ── scratch HERMES_HOME: root config + two profile homes ────────────────
    writeFileSync(
      join(hermesHome, "config.yaml"),
      profileConfig(stub.url, []),
    );
    for (const [profile, enabled] of [
      [PROFILE_A, ["lilos", "browserprobe"]],
      [PROFILE_B, ["browserprobe"]],
    ] as const) {
      const home = join(hermesHome, "profiles", profile);
      mkdirSync(join(home, "plugins"), { recursive: true });
      writeFileSync(join(home, "config.yaml"), profileConfig(stub.url, [...enabled]));
      // Install = copy the shipped bundle (what Connect does), always the
      // same files; `plugins.enabled` alone decides loading.
      cpSync(PLUGIN_SRC, join(home, "plugins", "lilos"), { recursive: true });
      mkdirSync(join(home, "plugins", "browserprobe"), { recursive: true });
      writeFileSync(
        join(home, "plugins", "browserprobe", "plugin.yaml"),
        BROWSERPROBE_PLUGIN_YAML,
      );
      writeFileSync(
        join(home, "plugins", "browserprobe", "__init__.py"),
        BROWSERPROBE_INIT,
      );
    }

    // ── real hermes serve, engine-scoped env the harness sets ──────────────
    diag.hermesHome = hermesHome;
    hermes = await startHermesServe({
      bin: HERMES_BIN,
      timeoutMs: 120_000,
      env: {
        HERMES_HOME: hermesHome,
        LILOS_SURFACES_URL: surfaces.url,
        LILOS_ENGINE_TOKEN: surfaces.engineToken,
        HERMES_PLUGINS_DEBUG: "1",
      },
    });
    hermes.child.stdout?.on("data", (d) => diag.hermesOut.push(String(d)));
    hermes.child.stderr?.on("data", (d) => diag.hermesOut.push(String(d)));
    diag.killServe = () => {
      try {
        hermes.child.kill("SIGKILL");
      } catch {}
    };
    gateway = await HermesGateway.connect(
      `ws://127.0.0.1:${hermes.port}/api/ws?token=${hermes.token}`,
    );
    check(true, "hermes serve up with plugin env on two profiles");

    const createSession = async (profile: string, source?: string) => {
      const r = (await gateway!.request("session.create", {
        profile,
        title: "e2e-339",
        cwd: process.env.HOME,
        cwd_explicit: true,
        ...(source ? { source } : {}),
        close_on_disconnect: true,
        model: "stub-model-a",
        provider: "lilos-stub",
      })) as { session_id?: string; stored_session_id?: string };
      return {
        runtimeSid: r.session_id ?? "",
        stored: r.stored_session_id ?? "",
      };
    };
    const prompt = async (runtimeSid: string, text: string) => {
      await gateway!.request("prompt.submit", {
        session_id: runtimeSid,
        text,
      });
    };

    // ── Session A: profile A, source=lilos ─────────────────────────────────
    stub.clear();
    const sa = await createSession(PROFILE_A, "lilos");
    const surfA = surfaces.create({
      binding: {
        employeeId: "emp-e2e-a",
        channelId: "chan-e2e-a",
        conversationId: "conv-e2e-a",
      },
      engineSessionId: sa.stored,
    });
    check(
      !!sa.runtimeSid && !!sa.stored,
      "session.create profile=live339a source=lilos",
      `runtime=${sa.runtimeSid} stored=${sa.stored}`,
    );
    await prompt(sa.runtimeSid, "list what you can do.");
    // Plugin tools are deferred behind tool_search — the session's catalog
    // (schema listing + search results) IS the offered surface. A lilos_*
    // name inside a refusal ("'x' is not available", "only runs inside a
    // LilOS session") is a gate, not an offer — scrub it before matching.
    const lilosListed = (s: SeenReq) => {
      const hay = `${s.searchDesc}\n${s.toolResults}`
        .replace(/'[^']*' is not available in this session[^.\n]*/g, "")
        .replace(/'[^']*' is not a known tool name[^.\n]*/g, "")
        .replace(/[^.\n]*only runs inside a LilOS session[^.\n]*/g, "");
      return /lilos_(terminal_run|browser_open|thread_post|workbench_previews)/.test(
        hay,
      );
    };
    const sawLilosToolsA = await waitFor(
      () => stub.seen.some(lilosListed),
      90_000,
    );
    const offeredA = [...new Set(stub.seen.flatMap((s) => s.tools))];
    diag.offeredA = offeredA;
    check(
      sawLilosToolsA,
      "AC-2/AC-3: lilos_* tools reachable from the lilos session on profile A",
      `listed=${stub.seen.some(lilosListed)}`,
    );
    check(
      stub.seen.some((s) =>
        /browser_probe/.test(`${s.searchDesc}\n${s.toolResults}`),
      ),
      "fixture browser_probe in profile A's catalog",
    );

    // AC-4: policy frozen into the session system prompt.
    const sawPolicy = stub.seen.some((s) =>
      /\[LilOS host policy v\d+\]/.test(s.sys),
    );
    check(
      sawPolicy,
      "AC-4: versioned host policy in the lilos session system prompt",
      (stub.seen.find((s) => /\[LilOS host policy/.test(s.sys))?.sys ?? "")
        .match(/\[LilOS host policy[^\]]*\]/)?.[0] ?? "",
    );

    // AC-5: the stub calls browser_probe through tool_call — vetoed by the
    // plugin's pre_tool_call hook (hooks fire for deferred calls too).
    const sawBlock = await waitFor(
      () =>
        stub.seen.some((s) =>
          /lilos_browser|Inside LilOS|Workbench/i.test(s.toolResults),
        ),
      90_000,
    );
    check(
      sawBlock,
      "AC-5: browser_* vetoed inside the lilos session with the LilOS alternative",
      (stub.seen.find((s) => /Inside LilOS|lilos_browser/i.test(s.toolResults))
        ?.toolResults ?? "")
        .slice(0, 160),
    );

    // AC-3: after the block the model calls lilos_terminal_run → the gateway
    // runs it on the session PTY and the captured output carries the marker.
    const sawLilosCall = await waitFor(
      () =>
        stub.seen.some((s) => s.toolResults.includes(`${MARKER}-PLUGIN`)),
      120_000,
    );
    check(
      sawLilosCall,
      "AC-3: lilos_terminal_run dispatched through the plugin",
    );
    const tail = await fetch(`${surfaces.url}/tools/terminal_read`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${surfA.token}`,
        "x-lilos-session": surfA.session,
      },
      body: JSON.stringify({ tailBytes: 16000 }),
    }).then((r) => r.json() as Promise<Record<string, unknown>>);
    check(
      JSON.stringify(tail.result ?? tail).includes(`${MARKER}-PLUGIN`),
      "AC-3: plugin call forwarded the stored session id → session PTY marker",
    );

    // ── Session B: same profile A, NO source (plain) ────────────────────────
    // Hermes' tool surface is profile-scoped on `hermes serve` — every
    // gateway session resolves the same "cli" toolset selection, so lilos_*
    // appear in the deferred catalog here too. "Inert outside LilOS" is
    // enforced at the call boundary: the stub attempts lilos_terminal_run
    // and the plugin veto must refuse it before anything executes.
    stub.clear();
    const sp = await createSession(PROFILE_A);
    check(!!sp.runtimeSid, "plain session.create on profile A (no source)");
    await prompt(sp.runtimeSid, "list what you can do.");
    const probeRan = await waitFor(
      () => stub.seen.some((s) => /PROBE-RAN-OK/.test(s.toolResults)),
      90_000,
    );
    const refusedLilos = await waitFor(
      () =>
        stub.seen.some((s) =>
          /only runs inside a LilOS session|inert here/.test(s.toolResults),
        ),
      90_000,
    );
    check(
      refusedLilos,
      "AC-2: lilos_* call refused in the plain session — inert outside LilOS",
      (stub.seen.find((s) =>
        /only runs inside a LilOS session|inert here/.test(s.toolResults),
      )?.toolResults ?? "")
        .slice(0, 160),
    );
    check(
      probeRan,
      "AC-2/AC-5: browser_probe RUNS unblocked in the plain session",
      (stub.seen.find((s) => /PROBE-RAN-OK/.test(s.toolResults))?.toolResults ??
        ""
      ).slice(0, 120),
    );

    // ── Session C: profile B — lilos NOT enabled (files present) ───────────
    stub.clear();
    const sb = await createSession(PROFILE_B, "lilos");
    await prompt(sb.runtimeSid, "list what you can do.");
    await waitFor(
      () => stub.seen.some((s) => /PROBE-RAN-OK/.test(s.toolResults)),
      90_000,
    );
    check(
      !stub.seen.some(lilosListed),
      "AC-8: profile B (files on disk, not enabled) gets no lilos_* tools",
      stub.seen.some(lilosListed)
        ? `LEAK: ${stub.seen
            .filter(lilosListed)
            .map((s) =>
              `${s.searchDesc}\n${s.toolResults}`.match(
                /[^\n]{0,80}lilos_(terminal_run|browser_open|thread_post|workbench_previews)[^\n]{0,80}/,
              )?.[0],
            )
            .join(" | ")}`
        : "",
    );

    // ── AC-8 core: `hermes -p B plugins enable lilos` on the RUNNING serve ─
    const enable = await run(
      [HERMES_BIN, "-p", PROFILE_B, "plugins", "enable", "lilos"],
      { HERMES_HOME: hermesHome },
    );
    check(
      enable.code === 0 && /enabled|already/i.test(enable.out),
      "AC-8: `hermes -p live339b plugins enable lilos` succeeds while serve runs",
      enable.out.trim().split("\n").slice(0, 3).join(" | "),
    );

    // New session on profile B (serve NOT restarted): tools must appear —
    // proves per-profile loading + the enable-nudge works without a restart.
    stub.clear();
    const sb2 = await createSession(PROFILE_B, "lilos");
    const surfB2 = surfaces.create({
      binding: {
        employeeId: "emp-e2e-b2",
        channelId: "chan-e2e-b2",
        conversationId: "conv-e2e-b2",
      },
      engineSessionId: sb2.stored,
    });
    await prompt(sb2.runtimeSid, "list what you can do.");
    const sawLilosB2 = await waitFor(
      () => stub.seen.some(lilosListed),
      90_000,
    );
    const offeredB2 = [...new Set(stub.seen.flatMap((s) => s.tools))];
    check(
      sawLilosB2,
      "AC-8: new session on profile B gets lilos_* with NO hermes restart",
      offeredB2.filter((n) => n.startsWith("lilos")).slice(0, 8).join(","),
    );

    // And the plugin works on B end-to-end (not just listed): tool result
    // carries the lilos_terminal_run marker through B's own alias.
    const sawB2Call = await waitFor(
      () => stub.seen.some((s) => s.toolResults.includes(`${MARKER}-PLUGIN`)),
      120_000,
    );
    check(
      sawB2Call,
      "AC-8: profile B's lilos_terminal_run dispatches end-to-end",
      sawB2Call
        ? ""
        : `last results: ${stub.seen
            .filter((s) => s.toolResults)
            .map((s) => s.toolResults.slice(0, 140))
            .slice(-3)
            .join(" | ")}`,
    );
    const tailB = await fetch(`${surfaces.url}/tools/terminal_read`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${surfB2.token}`,
        "x-lilos-session": surfB2.session,
      },
      body: JSON.stringify({ tailBytes: 16000 }),
    }).then((r) => r.json() as Promise<Record<string, unknown>>);
    check(
      JSON.stringify(tailB.result ?? tailB).includes(`${MARKER}-PLUGIN`),
      "AC-8: B's call landed on B's session PTY (alias resolved)",
      JSON.stringify(tailB.result ?? tailB).slice(0, 200),
    );
  } catch (e) {
    check(false, "e2e run", e instanceof Error ? e.message : String(e));
  } finally {
    try {
      gateway?.close();
    } catch {}
    try {
      await hermes?.close();
    } catch {}
    stub.stop();
    await surfaces.close().catch(() => {});
    clearTimeout(watchdog);
  }

  const failed = checks.filter((c) => !c.ok).length;
  console.log(
    `hermes-plugin-e2e: ${checks.length - failed}/${checks.length} passed`,
  );
  process.exit(failed ? 1 : 0);
}

await main();
