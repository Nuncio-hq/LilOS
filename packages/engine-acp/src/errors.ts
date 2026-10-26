import type { RpcErrorCode } from "@lilos/contracts/engine";

/** Engine JSON-RPC error — `code` survives the transport onto the wire. */
export class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode | number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
