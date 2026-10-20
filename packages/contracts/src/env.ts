/**
 * Spawn-boundary env contract (D-#412, widened by #507): the LILOS_* names a
 * spawned process may see. One allow-list guards every harness-owned child —
 * the engine spawn, the surfaces PTY and workbench browser, the host
 * package's exec calls (`git`/`gh`/`id`/`open` — repo hooks and editor CLIs
 * run agent-influenced code), and the Connect reconciler's engine CLI.
 *
 * Everything else in the LILOS_ namespace is LilOS-internal
 * (`LILOS_RELAY_TOKEN`, harness/relay home dirs, `LILOS_WORKDIR`, ...) and
 * never crosses a spawn boundary: agent-influenced code must not be handed
 * the relay token or pointers into ~/.lilos. Entries a child legitimately
 * needs ride the caller's explicit env — merged AFTER this scrub, so an
 * explicit grant always wins. Non-LILOS_* env (PATH, HOME, proxies, provider
 * keys) passes through untouched: that's the process environment, not LilOS
 * state.
 *
 * Lives in contracts because both `apps/harness` and `packages/host` spawn —
 * and `packages/*` can only see packages (`apps/*` is off-limits by the
 * one-way-deps rule). The names mirror `SURFACES_ENV` in `@lilos/surfaces`;
 * a harness test binds the two so they can't drift.
 *
 * Same decision: a session with no folder runs in `~`, and the harness's
 * `hasFolder` gates checkpoints/rewind so home is never snapshotted or
 * restored. Not: passing the whole harness env (hands `LILOS_RELAY_TOKEN`
 * and state dirs to agent shells, repo hooks and engine plugin code), a
 * per-session temp folder (rejected 2026-10-04), or Workbench/rewind
 * treating `~` as a session folder.
 */
export const LILOS_ENV_ALLOW_LIST: readonly string[] = [
  "LILOS_SURFACES_URL", // surfaces.baseUrl — gateway URL the lilos plugin reads
  "LILOS_ENGINE_TOKEN", // surfaces.engineToken — engine-scoped credential
];

/**
 * Per-launch credential for the engine adapter's `/ws` (D-#564, #752).
 * The harness mints one per engine spawn and passes it as an explicit
 * grant — merged after `scrubLilosEnv`, which is how D-#412 hands a child
 * a credential it needs without inheriting the harness env. It is not on
 * `LILOS_ENV_ALLOW_LIST`: that list is what agent-influenced code may see,
 * and this secret is what drives the protocol socket. The adapter reads it
 * once (`takeEngineProtocolToken`) and drops it before it spawns
 * the vendor engine, ACP, or MCP, so those children never inherit it.
 */
export const ENGINE_PROTOCOL_TOKEN_ENV = "LILOS_ENGINE_PROTOCOL_TOKEN";

/** Read the protocol credential and remove it from `env` (default
 *  `process.env`) so later child spawns do not inherit it. */
export function takeEngineProtocolToken(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const token = env[ENGINE_PROTOCOL_TOKEN_ENV] ?? "";
  delete env[ENGINE_PROTOCOL_TOKEN_ENV];
  return token;
}

/** `env` minus every LILOS_* outside the allow-list above. */
export const scrubLilosEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const keep = new Set<string>(LILOS_ENV_ALLOW_LIST);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env))
    if (!key.startsWith("LILOS_") || keep.has(key)) out[key] = value;
  return out;
};
