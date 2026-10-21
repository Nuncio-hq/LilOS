/**
 * `@lilos/engine-hermes`: the LilOS engine protocol over a live Hermes
 * backend — `hermes serve`'s WS gateway (`/api/ws`) for sessions, `hermes
 * acp` for sessions that carry MCP servers — mapped onto the wire contract
 * in `@lilos/contracts/engine`.
 *
 * Where each concern lives:
 *   version.ts        the minimum Hermes version and the too-old verdict (#95)
 *   engine.ts         `session.create` field negotiation (#50) and describe():
 *                     the `hermes_gateway` capability, `backend.{state,detail}`
 *   catalog.ts        models and agents; setModel validates first (#50)
 *   backend.ts        the `hermes serve` watchdog (#482)
 *   serve.ts          spawning `hermes serve`; the `--isolated` host multiplex
 *                     (#548)
 *   scripts/serve.ts  the WS entry point the harness launches
 *   scripts/live-hermes.ts  `bun run live:hermes`, the live conformance run
 */
export { AcpDriver, type AcpOptions } from "./acp.js";
export { HermesEngine, type HermesEngineOptions } from "./engine.js";
export { RpcError } from "./errors.js";
export { type GatewayLike, HermesGateway } from "./gateway.js";
export {
  PLUGIN_CONTENT_HASH_FILE,
  listPluginFiles,
  pluginContentHash,
  renderPluginHashManifest,
} from "./plugin-hash.js";
export {
  HermesHostConflict,
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
  HERMES_HOST_CONFLICT_EXIT_CODE,
  HERMES_TOO_OLD_EXIT_CODE,
  hermesTooOldMessage,
  isHermesVersionSupported,
  MIN_HERMES_VERSION,
  parseHermesVersion,
} from "./version.js";
