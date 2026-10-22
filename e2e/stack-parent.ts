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
import { parseListeningPort } from "../packages/contracts/src/ready";
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

/* Drain stdout or the pipe fills and the stack blocks before it can
   serve. The same buffer is how port 0 reports the feed (#825): the
   harness prints the port it bound, and probing :0 is not a server.
   The old loop was 300 × 500ms. Discovery shares that budget. */
const BUDGET_MS = 150_000;
const started = Date.now();
const left = () => BUDGET_MS - (Date.now() - started);
let buf = "";
stack.stdout?.on("data", (chunk) => {
  buf += String(chunk);
  if (buf.length > 300_000) buf = buf.slice(-150_000);
});
const fail = (msg: string): never => {
  console.error(msg);
  try {
    process.kill(-(stack.pid ?? 0), "SIGKILL");
  } catch {}
  process.exit(1);
};

let port = feedPort;
if (port === 0) {
  while (left() > 0) {
    const found = parseListeningPort(buf, "harness");
    if (found) {
      port = found;
      break;
    }
    if (stack.exitCode !== null)
      fail(
        `stack-parent: stack exited (${stack.exitCode}) before the harness reported its port\n${buf.slice(-1200)}`,
      );
    await Bun.sleep(50);
  }
  if (!port)
    fail(
      `stack-parent: timed out waiting for the harness to report its port\n${buf.slice(-1200)}`,
    );
}

/* Ready when the feed socket answers — it is last in the boot chain, so
   relay + harness + engine-fake are all up by then. */
const feedUp = async (): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) })
    .then((r) => r.ok)
    .catch(() => false);
let up = false;
while (left() > 0 && !up) {
  if (stack.exitCode !== null)
    fail(
      `stack-parent: stack exited (${stack.exitCode}) before the feed was up\n${buf.slice(-1200)}`,
    );
  up = await feedUp();
  if (!up) await Bun.sleep(Math.min(500, Math.max(left(), 0)));
}
if (!up)
  fail(`stack-parent: feed never came up on :${port}\n${buf.slice(-1200)}`);
console.log(`PARENT_READY ${stack.pid}`);

/* Idle like a busy worker. If the spec runner (our parent) dies first, the
   watchdog exits us — and the children's own watchdogs take the tree down. */
watchOrphanExit();
await new Promise(() => {});
