import { z } from "zod";

/**
 * JSON-RPC 2.0 envelope for the engine wire. One frame = one JSON value per
 * WebSocket message (or per call on the in-memory transport). Engine-to-client
 * questions ride the event stream (`request.opened`) and are answered with the
 * `request.respond` method, so a reconnecting client can re-answer what it
 * missed — there are no server-to-client request frames to lose.
 */

export const JsonRpcId = z.union([z.string().min(1), z.int()]);
export type JsonRpcId = z.infer<typeof JsonRpcId>;

export const JsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcId,
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

export const JsonRpcNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotification>;

export const JsonRpcErrorObject = z.object({
  code: z.int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObject>;

export const JsonRpcResponse = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: JsonRpcId, result: z.unknown() }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcId,
    error: JsonRpcErrorObject,
  }),
]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponse>;

/** Any frame a client may send. */
export const ClientFrame = z.union([JsonRpcRequest, JsonRpcNotification]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** Standard JSON-RPC codes plus engine-domain codes in the -320xx range. */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SESSION_NOT_FOUND: -32001,
  REQUEST_NOT_FOUND: -32002,
  INVALID_STATE: -32003,
  AGENT_NOT_FOUND: -32004,
  MODEL_NOT_FOUND: -32005,
  /* #482: the engine's inference backend is down — the adapter is
     restarting it. Distinct from INVALID_STATE: the caller's request was
     well-formed and may succeed once the backend is back (retryable,
     user-visible as the app-code `engine_unavailable`). */
  BACKEND_DOWN: -32006,
} as const;
export type RpcErrorCode = (typeof RPC_ERRORS)[keyof typeof RPC_ERRORS];

export const rpcError = (
  code: RpcErrorCode,
  message: string,
  data?: unknown,
): JsonRpcErrorObject =>
  data === undefined ? { code, message } : { code, message, data };
