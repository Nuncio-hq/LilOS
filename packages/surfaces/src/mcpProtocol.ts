/**
 * Minimal MCP (Model Context Protocol) JSON-RPC handling for the LilOS agent
 * gateway — the stateless subset of the streamable-HTTP transport the
 * gateway needs: `initialize`, `ping`, `tools/list`, `tools/call`, plus
 * notification acknowledgement. Every POST gets one JSON response body (the
 * spec allows `application/json` answers instead of an SSE stream), so no
 * MCP session state is kept server-side.
 *
 * Ported from Synara's `apps/server/src/agentGateway/protocol.ts` +
 * `mcpTransport.ts` (MIT) — same wire semantics, no Effect layer.
 */
export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MCP_SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface JsonRpcNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface McpToolCallResult {
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "image";
        readonly data: string;
        readonly mimeType: string;
      }
  >;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

export function mcpToolResultError(text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function jsonRpcResult(
  id: JsonRpcId,
  result: unknown,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export type ParsedMcpMessage =
  | { readonly kind: "request"; readonly request: JsonRpcRequest }
  | {
      readonly kind: "notification";
      readonly notification: JsonRpcNotification;
    }
  | { readonly kind: "response" }
  | { readonly kind: "invalid"; readonly id: JsonRpcId };

/**
 * Classify one raw JSON-RPC message. Responses and notifications need no
 * reply body; invalid entries produce an error bound to whatever id could be
 * recovered.
 */
export function parseMcpMessage(raw: unknown): ParsedMcpMessage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "invalid", id: null };
  }
  const record = raw as Record<string, unknown>;
  const rawId = record.id;
  const id: JsonRpcId =
    typeof rawId === "string" || typeof rawId === "number" || rawId === null
      ? rawId
      : null;
  if (record.jsonrpc !== "2.0") return { kind: "invalid", id };
  if (typeof record.method !== "string" || record.method.length === 0) {
    // No method: a client->server response (has result/error) or garbage.
    if ("result" in record || "error" in record) return { kind: "response" };
    return { kind: "invalid", id };
  }
  if (
    rawId !== undefined &&
    rawId !== null &&
    typeof rawId !== "string" &&
    typeof rawId !== "number"
  ) {
    return { kind: "invalid", id: null };
  }
  const params =
    typeof record.params === "object" &&
    record.params !== null &&
    !Array.isArray(record.params)
      ? (record.params as Record<string, unknown>)
      : {};
  if (rawId === undefined) {
    return {
      kind: "notification",
      notification: { method: record.method, params },
    };
  }
  return {
    kind: "request",
    request: { jsonrpc: "2.0", id, method: record.method, params },
  };
}

export function negotiateMcpProtocolVersion(requested: unknown): string {
  if (
    typeof requested === "string" &&
    MCP_SUPPORTED_PROTOCOL_VERSIONS.has(requested)
  ) {
    return requested;
  }
  return MCP_DEFAULT_PROTOCOL_VERSION;
}

export function buildMcpInitializeResult(input: {
  readonly requestedProtocolVersion: unknown;
  readonly serverVersion: string;
  readonly instructions: string;
}): Record<string, unknown> {
  return {
    protocolVersion: negotiateMcpProtocolVersion(
      input.requestedProtocolVersion,
    ),
    capabilities: { tools: { listChanged: false } },
    serverInfo: {
      name: "lilos",
      title: "LilOS Agent Gateway",
      version: input.serverVersion,
    },
    instructions: input.instructions,
  };
}
