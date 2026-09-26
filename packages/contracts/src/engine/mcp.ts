import { z } from "zod";

/**
 * ACP-shaped `mcpServers` entries for `session.start` — the LilOS MCP server a
 * session attaches is passed through this shape (see #23). stdio is the
 * baseline transport every engine must accept; `http`/`sse` are declared via
 * the `mcp_servers` capability detail.
 */
const EnvVar = z.strictObject({ name: z.string().min(1), value: z.string() });
export type EnvVar = z.infer<typeof EnvVar>;

export const McpServerStdio = z.strictObject({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.array(EnvVar),
});
export type McpServerStdio = z.infer<typeof McpServerStdio>;

export const McpServerHttp = z.strictObject({
  type: z.literal("http"),
  name: z.string().min(1),
  url: z.string().min(1),
  headers: z.array(EnvVar),
});
export type McpServerHttp = z.infer<typeof McpServerHttp>;

export const McpServerSse = z.strictObject({
  type: z.literal("sse"),
  name: z.string().min(1),
  url: z.string().min(1),
  headers: z.array(EnvVar),
});
export type McpServerSse = z.infer<typeof McpServerSse>;

export const McpServer = z.union([McpServerStdio, McpServerHttp, McpServerSse]);
export type McpServer = z.infer<typeof McpServer>;
