import process from "node:process";
import { LILOS_TOOLS } from "@lilos/contracts/harness";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";
import type { SurfaceBackend } from "./backend.js";
import { toolBackend } from "./client.js";
import { surfacesEnv } from "./config.js";
import { callTool } from "./dispatch.js";

/**
 * The LilOS MCP server (AC-2): every entry in the contracts' LILOS_TOOLS
 * table becomes an MCP tool; the harness spawns this per engine session via
 * `session.start { mcpServers }` (AC-3), so engines see them as
 * `mcp__lilos__*` (server name `lilos` — spike #23's mapping).
 *
 * The server is a thin client of the harness's tool API — the browser/PTY
 * live in the harness process, scoped by the session env it sets.
 */
export async function serveMcpStdio(backend: SurfaceBackend): Promise<void> {
  const server = new McpServer({ name: "lilos", version: "0.1.0" });
  for (const [name, contract] of Object.entries(LILOS_TOOLS)) {
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
  const resolved = surfacesEnv(env);
  if ("error" in resolved) {
    process.stderr.write(`lilos mcp: ${resolved.error}\n`);
    process.exitCode = 2;
    return;
  }
  await serveMcpStdio(toolBackend(resolved));
}
