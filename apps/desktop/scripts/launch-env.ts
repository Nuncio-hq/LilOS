/**
 * Environment for `open <LilOS.app>` (#837). `open` hands the caller's
 * environment to the launched app, and a shell inside an Electron app —
 * T3 Code, VS Code, another LilOS — exports Electron-as-Node vars. With
 * `ELECTRON_RUN_AS_NODE` set the LilOS binary boots as plain Node: no
 * window, no relay, and `local.ts` times out on /healthz.
 *
 * Strip every `ELECTRON_*` override (RUN_AS_NODE, NO_ATTACH_CONSOLE,
 * NO_ASAR, debug flags — all dev knobs a packaged build must not inherit)
 * plus `NODE_OPTIONS`, which Node flags the agent harness injects and
 * which Electron honors in run-as-Node mode. Everything else — PATH,
 * HOME, LILOS_* — passes through untouched.
 */
export function launchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !key.startsWith("ELECTRON_") && key !== "NODE_OPTIONS",
    ),
  );
}
