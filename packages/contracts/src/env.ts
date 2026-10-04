/**
 * Spawn-boundary env contract (#412, widened by #507): the LILOS_* names a
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
 */
export const LILOS_ENV_ALLOW_LIST: readonly string[] = [
  "LILOS_SURFACES_URL", // surfaces.baseUrl — gateway URL the lilos plugin reads
  "LILOS_ENGINE_TOKEN", // surfaces.engineToken — engine-scoped credential
];

/** `env` minus every LILOS_* outside the allow-list above. */
export const scrubLilosEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const keep = new Set<string>(LILOS_ENV_ALLOW_LIST);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env))
    if (!key.startsWith("LILOS_") || keep.has(key)) out[key] = value;
  return out;
};
