import type {
  AppErrorCode,
  EngineHostState,
  HarnessStatusReport,
} from "@lilos/contracts/app";
import type { RelayWsPeer } from "../session";

/** Numeric JSON-RPC error codes; the app-level AppErrorCode rides in `data.code`. */
const JsonRpcCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthenticated: -32001,
  protocolVersionMismatch: -32002,
  forbidden: -32003,
  notFound: -32004,
  unavailable: -32005,
  /* #482: engine RPC_ERRORS.BACKEND_DOWN — the adapter's Hermes backend
     died and it is restarting; callers see engine_unavailable, not a hang. */
  backendDown: -32006,
  conflict: -32009,
  attachmentTooLarge: -32010,
} as const;

export { JsonRpcCode };

/** The peer that has `harness.register`ed — the single engine host. */
export interface HostRecord {
  peer: RelayWsPeer;
  hostId: string;
  /** Claimed build + protocol versions from the register handshake. */
  version: string;
  protocolVersion: number;
  registeredAt: number;
  lastReportAt?: number;
  engine?: { state: EngineHostState; detail?: string };
  /** Latest telemetry payload from harness.report.status. */
  status?: HarnessStatusReport;
}

export class RpcError extends Error {
  constructor(
    readonly numericCode: number,
    readonly appCode: AppErrorCode,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badParams = (issues: unknown) =>
  new RpcError(JsonRpcCode.invalidParams, "invalid_params", "invalid params", {
    issues,
  });
