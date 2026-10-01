import { type ChildProcess, spawn } from "node:child_process";
import type { McpServerHttp, McpServerStdio } from "@lilos/contracts/engine";

/**
 * The smallest real MCP clients — JSON-RPC 2.0 over newline-delimited
 * stdin/stdout (`startMcpServer`) and over streamable HTTP (`startMcpHttp`,
 * JSON responses, no SSE — the shape engines perform when they accept
 * `session.start { mcpServers }` (ACP `session/new`). engine-fake uses them
 * to actually spawn/connect and call each attached server, so the
 * conformance tests exercise the real wire path — not a mocked "we stored
 * the config".
 *
 * No MCP SDK here on purpose: engine packages depend only on contracts, and
 * the protocol surface we need is initialize / tools/list / tools/call.
 */
export interface McpClient {
  readonly name: string;
  readonly tools: string[];
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): void;
}

export function startMcpServer(spec: McpServerStdio): Promise<McpClient> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  for (const v of spec.env) env[v.name] = v.value;
  const child: ChildProcess = spawn(spec.command, spec.args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const onData = (d: Buffer) => {
    buf += d.toString();
    for (;;) {
      const i = buf.indexOf("\n");
      if (i < 0) break;
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p || msg.id === undefined) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const request = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`,
      );
    });
  const notify = (method: string) =>
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);

  return (async () => {
    try {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "engine-fake", version: "0.0.0" },
      });
    } catch (e) {
      child.kill();
      throw new Error(
        `mcp server '${spec.name}' initialize failed: ${e instanceof Error ? e.message : e}; stderr: ${stderr.slice(-400)}`,
      );
    }
    notify("notifications/initialized");
    const list = (await request("tools/list")) as {
      tools?: { name: string }[];
    };
    return {
      name: spec.name,
      tools: (list.tools ?? []).map((t) => t.name),
      async callTool(name, args) {
        const res = (await request("tools/call", {
          name,
          arguments: args,
        })) as {
          content?: { type: string; text?: string }[];
          isError?: boolean;
        };
        const text = (res.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
        if (res.isError) throw new Error(text || `tool ${name} failed`);
        return text;
      },
      close() {
        child.kill();
      },
    } satisfies McpClient;
  })();
}

/**
 * The same client against an MCP streamable-HTTP endpoint (issue #337):
 * one JSON-RPC request per POST, `application/json` responses (the gateway
 * answers JSON, not SSE). Spec-declared headers (e.g. the session bearer)
 * ride on every call.
 */
export async function startMcpHttp(spec: McpServerHttp): Promise<McpClient> {
  let nextId = 1;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  for (const h of spec.headers) headers[h.name] = h.value;
  const post = async (method: string, params?: unknown, id?: number) => {
    const res = await fetch(spec.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(id === undefined ? {} : { id }),
        method,
        params: params ?? {},
      }),
    });
    if (!res.ok && res.status !== 202) {
      throw new Error(
        `mcp http ${method} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    const text = await res.text();
    if (!text) return undefined;
    const contentType = res.headers.get("content-type") ?? "";
    const payload = contentType.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("")
      : text;
    const msg = JSON.parse(payload) as {
      result?: unknown;
      error?: { message: string };
    };
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  };
  const request = (method: string, params?: unknown) =>
    post(method, params, nextId++);

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "engine-fake", version: "0.0.0" },
  });
  await post("notifications/initialized");
  const list = (await request("tools/list")) as {
    tools?: { name: string }[];
  };
  return {
    name: spec.name,
    tools: (list.tools ?? []).map((t) => t.name),
    async callTool(name, args) {
      const res = (await request("tools/call", {
        name,
        arguments: args,
      })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = (res.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      if (res.isError) throw new Error(text || `tool ${name} failed`);
      return text;
    },
    close() {},
  } satisfies McpClient;
}
