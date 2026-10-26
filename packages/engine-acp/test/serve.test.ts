import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * D-#845 — the serve entry point end to end: `--command` launches a
 * verified local command, `/ws` gates on the per-launch protocol token,
 * and the socket speaks the engine protocol (describe, session.start,
 * prompt). The agent under test is the deterministic fake — no LLM.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVE = join(HERE, "..", "scripts", "serve.ts");
const FAKE_AGENT = join(HERE, "..", "scripts", "fake-agent.ts");
const TOKEN = "serve-test-token-845";

interface Proc {
  child: ChildProcess;
  url: string;
  out: () => string;
}

const listen = (
  args: string[],
  env: Record<string, string | undefined> = {},
  timeoutMs = 30_000,
): Promise<Proc> =>
  new Promise((resolve, reject) => {
    const child = spawn("bun", [SERVE, ...args], {
      env: {
        ...process.env,
        LILOS_ENGINE_PROTOCOL_TOKEN: TOKEN,
        ...env,
      } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`serve did not print LISTENING:\n${out}`));
    }, timeoutMs);
    child.stderr?.on("data", (c) => {
      out += c.toString();
    });
    child.stdout?.on("data", (c) => {
      out += c.toString();
      const m = /LISTENING (ws:\/\/\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1], out: () => out });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(`serve exited ${code} before LISTENING:\n${out}`),
      );
    });
  });

/** Minimal ws client for the engine protocol (Node 26 global WebSocket). */
const wsClient = async (url: string) => {
  const ws = new WebSocket(url);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  let id = 0;
  const pending = new Map<number, (v: unknown) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (m.id !== undefined && pending.has(m.id)) {
      const r = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) r(Promise.reject(new Error(m.error.message)));
      else r(m.result);
    }
  };
  return {
    request: (method: string, params: unknown = {}) =>
      new Promise<unknown>((resolve) => {
        const i = ++id;
        pending.set(i, resolve);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }));
      }),
    close: () => ws.close(),
  };
};

describe("serve.ts entry point (D-#845)", () => {
  test("--command launches a local ACP agent and serves the protocol", async () => {
    const proc = await listen(["--command", `bun ${FAKE_AGENT}`]);
    try {
      const ws = await wsClient(`${proc.url}?token=${TOKEN}`);
      try {
        const desc = (await ws.request("describe")) as {
          name: string;
          capabilities: { id: string }[];
        };
        expect(desc.name).toBe("engine-acp-command");
        expect(desc.capabilities.map((c) => c.id)).toContain("acp");

        const started = (await ws.request("session.start", {
          agent: "tester",
          cwd: process.cwd(),
        })) as { sessionId: string };
        expect(started.sessionId).toMatch(/^s-/);

        /* "read or search tool" is the fake agent's non-mutating leg —
           one tool call + LILOS_OK, deterministically. */
        const result = (await ws.request("prompt", {
          sessionId: started.sessionId,
          content: [{ type: "text", text: "read or search tool please" }],
        })) as { turnId: string; stopReason: string };
        expect(result.stopReason).toBe("end_turn");

        const events = (await ws.request("events.since", {
          sessionId: started.sessionId,
          after: 0,
        })) as { events: { type: string }[] };
        const types = events.events.map((e) => e.type);
        expect(types).toContain("turn.started");
        expect(types).toContain("tool.completed");
        expect(types).toContain("turn.completed");
      } finally {
        ws.close();
      }
    } finally {
      proc.child.kill("SIGTERM");
    }
  }, 45_000);

  test("--agent picks the registry entry; unknown ids fail plainly", async () => {
    /* bogus entry: exits 2 with the registry list on stderr. */
    await expect(
      listen(["--agent", "bogus"], {}, 10_000),
    ).rejects.toThrow(/exited 2|unknown agent/);
  }, 20_000);

  test("/ws without the protocol token is refused", async () => {
    const proc = await listen(["--command", `bun ${FAKE_AGENT}`]);
    try {
      /* no token: the upgrade is denied — the socket never opens. */
      await expect(wsClient(proc.url)).rejects.toThrow(/ws connect/);
      /* wrong token: same. */
      await expect(
        wsClient(`${proc.url}?token=wrong`),
      ).rejects.toThrow(/ws connect/);
    } finally {
      proc.child.kill("SIGTERM");
    }
  }, 45_000);

  test("the agent child never sees LILOS_* internals (D-#412)", async () => {
    /* The harness scrubs before spawning serve; the seam scrubs again
       before the agent — an internal var set on the serve env must not
       reach the agent. The fake agent echoes env probes via its
       read/search path: `env-check NAME` replies with printenv output. */
    const proc = await listen(["--command", `bun ${FAKE_AGENT}`], {
      LILOS_RELAY_TOKEN: "relay-secret-845",
      LILOS_HARNESS_HOME: "/tmp/acp-test-home-845",
    });
    try {
      const ws = await wsClient(`${proc.url}?token=${TOKEN}`);
      try {
        const started = (await ws.request("session.start", {
          agent: "tester",
          cwd: process.cwd(),
        })) as { sessionId: string };
        /* The fake agent's `env NAME` probe reports the child's view. */
        const envOf = async (name: string) => {
          await ws.request("prompt", {
            sessionId: started.sessionId,
            content: [{ type: "text", text: `env ${name}` }],
          });
          const events = (await ws.request("events.since", {
            sessionId: started.sessionId,
            after: 0,
          })) as {
            events: { type: string; payload: { output?: string } }[];
          };
          return (
            events.events
              .filter((e) => e.type === "tool.completed")
              .at(-1)?.payload?.output ?? ""
          );
        };
        /* Internal state never crosses the scrub… */
        expect(await envOf("LILOS_RELAY_TOKEN")).toBe("<unset>");
        expect(await envOf("LILOS_HARNESS_HOME")).toBe("<unset>");
        expect(await envOf("LILOS_ENGINE_PROTOCOL_TOKEN")).toBe("<unset>");
        /* …while the login env a signed-in CLI needs passes (HOME, PATH). */
        expect(await envOf("HOME")).toBe(process.env.HOME);
        expect(await envOf("PATH")).toBe(process.env.PATH);
      } finally {
        ws.close();
      }
    } finally {
      proc.child.kill("SIGTERM");
    }
  }, 45_000);
});
