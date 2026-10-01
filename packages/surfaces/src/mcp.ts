import { appendFileSync } from "node:fs";
import process from "node:process";
import { LILOS_TOOLS } from "@lilos/contracts/harness";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";
import type { SurfaceBackend } from "./backend.js";
import { listSessionTools, toolBackend } from "./client.js";
import { surfacesEnv } from "./config.js";
import { callTool } from "./dispatch.js";

/**
 * The LilOS MCP server over stdio (AC-2): entries in the contracts'
 * LILOS_TOOLS catalog become MCP tools — only the ones the session's bound
 * areas actually have (`tools/list` never advertises `browser_*` to a
 * session with no browser attached). The harness attaches this per engine
 * session via `session.start { mcpServers }`, so engines see
 * `mcp__lilos__*` (server name `lilos` — spike #23's mapping).
 *
 * The server is a thin client of the gateway's tool API — the browser/PTY
 * live in the harness process, scoped by the session env it sets.
 */
export async function serveMcpStdio(
  backend: SurfaceBackend,
  opts?: { toolNames?: readonly string[] },
): Promise<void> {
  const server = new McpServer({ name: "lilos", version: "0.1.0" });
  const names = opts?.toolNames ?? Object.keys(LILOS_TOOLS);
  for (const name of names) {
    const contract = LILOS_TOOLS[name];
    if (!contract) continue;
    server.registerTool(
      name,
      {
        description: contract.doc,
        inputSchema: (
          contract.params as unknown as { shape: Record<string, z.ZodType> }
        ).shape,
      },
      async (args) => {
        try {
          const result = await callTool(backend, name, args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: e instanceof Error ? e.message : String(e),
              },
            ],
          };
        }
      },
    );
  }
  await server.connect(new StdioServerTransport());
}

/** Same server over the env the harness injects — used by `lilos mcp` and engine spawns. */
export async function serveMcpStdioFromEnv(
  env: Record<string, string | undefined>,
): Promise<void> {
  // Optional spawn marker: when set, append one line proving this process was
  // spawned (by whom + which session). The live check uses it to confirm an
  // engine really launched `lilos mcp` from session.start's mcpServers.
  const markerLog = env.LILOS_MCP_SPAWN_LOG;
  if (markerLog) {
    try {
      appendFileSync(
        markerLog,
        `${new Date().toISOString()} session=${env.LILOS_SESSION ?? "?"} pid=${process.pid}\n`,
      );
    } catch {
      // best-effort marker only
    }
  }
  const resolved = surfacesEnv(env);
  if ("error" in resolved) {
    process.stderr.write(`lilos mcp: ${resolved.error}\n`);
    process.exitCode = 2;
    return;
  }
  // Advertise only the areas this session really has; fail closed — never
  // fall back to the whole catalog when the gateway can't be asked.
  const toolNames = await listSessionTools(resolved);
  await serveMcpStdio(toolBackend(resolved), { toolNames });
}
