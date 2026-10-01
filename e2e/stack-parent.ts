/**
 * Playwright-worker stand-in for `e2e/ac-347-engine-leak.spec.ts` (#347): the
 * spec spawns this script, and this script boots the real dev stack exactly
 * the way a spec's `bootStack` does — `bun run dev` in a detached process
 * group with stdin ignored — then idles. The spec SIGKILLs THIS process the
 * way a dying worker would, then asserts nothing tagged outlived it and the
 * whole detached group is empty: proof a killed runner can no longer leak
 * relay/harness/engine/vite.
 *
 * Env in (same shape a spec's bootStack sets): LILOS_HOME, LILOS_ENGINE_TAG,
 * LILOS_RELAY_PORT, LILOS_FEED_PORT, LILOS_WEB_PORT, --web-dir <path> argv.
 * Prints `PARENT_READY <shim-pid>` once the feed socket is up, so the spec
 * knows the full tree (shim → stack → children) is live before it fires.
 */
import { spawn } from "node:child_process";
import { watchOrphanExit } from "./engine-leak";

const flag = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`stack-parent needs --${name} <value>`);
  return v;
};
const webDir = flag("web-dir");
const feedPort = Number(process.env.LILOS_FEED_PORT ?? "4581");

/* Same shape as a spec's bootStack: detached group leader, stdin ignored —
   the exact spawn that used to orphan everything beneath it. */
const stack = spawn("bun", ["run", "dev"], {
  cwd: webDir,
  detached: true,
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env },
});

/* Ready when the feed socket answers — it is last in the boot chain, so
   relay + harness + engine-fake are all up by then. */
const feedUp = async (): Promise<boolean> =>
  fetch(`http://127.0.0.1:${feedPort}/`, { signal: AbortSignal.timeout(1_000) })
    .then((r) => r.ok)
    .catch(() => false);
let up = false;
for (let i = 0; i < 300 && !up; i++) {
  up = await feedUp();
  if (!up) await Bun.sleep(500);
}
if (!up) {
  console.error("stack-parent: feed never came up");
  try {
    process.kill(-(stack.pid ?? 0), "SIGKILL");
  } catch {}
  process.exit(1);
}
console.log(`PARENT_READY ${stack.pid}`);

/* Idle like a busy worker. If the spec runner (our parent) dies first, the
   watchdog exits us — and the children's own watchdogs take the tree down. */
watchOrphanExit();
await new Promise(() => {});
