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

/**
 * Largest WebSocket message any LilOS socket accepts — `maxPayloadLength` on
 * every Bun.serve websocket server (#551). Sized so a maximal attachment send
 * always fits: `MAX_ATTACHMENTS_PER_MESSAGE` images at `MAX_ATTACHMENT_BYTES`
 * each travel as inline base64 (~140 MB on the wire) both on the app's
 * `messages.post`/`conversations.open` and on the engine's `prompt` image
 * blocks. Bun's 16 MiB default sat under that and dropped the socket on big
 * screenshot sends — the app could only read it as "reconnecting". A frame
 * past this cap still dies at the transport; the schema caps
 * (`attachment_too_large`, `invalid_params`) are the readable bounds.
 */
export const MAX_FRAME_BYTES = 160 * 1024 * 1024;

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
  /* The turn's prompt could not be served because the session's context
     window is full/exhausted (#560) — the caller can compact or start a
     fresh session; retrying the same prompt fails the same way. */
  CONTEXT_LIMIT: -32007,
} as const;
export type RpcErrorCode = (typeof RPC_ERRORS)[keyof typeof RPC_ERRORS];

/** Provider error text that means the context window was exhausted (#560)
    — engines stamp turn.completed.errorCode CONTEXT_LIMIT on a match; the
    harness falls back to this when an engine reports no typed code. */
export const CONTEXT_LIMIT_TEXT =
  /context.{0,40}(length|limit|window|exceed|too (long|large|big)|full)|maximum context|prompt is too long|context_length_exceeded|tokens.{0,20}(exceed|limit)|out of (context|token) (room|space|budget)/i;

/** Compact token count for the compaction note — 245k / 38.2k / 900. */
export const fmtTokens = (n: number): string =>
  n >= 100_000
    ? `${Math.round(n / 1000)}k`
    : n >= 10_000
      ? `${(Math.round(n / 100) / 10).toFixed(1)}k`
      : n >= 1000
        ? `${(Math.round(n / 100) / 10).toFixed(1)}k`.replace(/\.0k$/, "k")
        : `${n}`;

export const rpcError = (
  code: RpcErrorCode,
  message: string,
  data?: unknown,
): JsonRpcErrorObject =>
  data === undefined ? { code, message } : { code, message, data };
