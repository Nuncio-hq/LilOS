export { HOST_ERRORS } from "@lilos/contracts/host";

/** Transport-agnostic host failure; the wire layer maps `code` to JSON-RPC. */
export class HostError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
