export { AcpDriver, type AcpOptions } from "./acp.js";
export { HermesEngine, type HermesEngineOptions } from "./engine.js";
export { RpcError } from "./errors.js";
export { type GatewayLike, HermesGateway } from "./gateway.js";
export {
  type HermesServeHandle,
  type HermesServeOptions,
  startHermesServe,
} from "./serve.js";
export type { PendingAsk, Session } from "./session.js";
export {
  connectInMemory,
  eventFrame,
  type HermesConnection,
  handleJsonRpc,
} from "./transport.js";
export {
  HERMES_TOO_OLD_EXIT_CODE,
  hermesTooOldMessage,
  isHermesVersionSupported,
  MIN_HERMES_VERSION,
  parseHermesVersion,
} from "./version.js";
