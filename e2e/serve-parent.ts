/**
 * Worker stand-in for `e2e/ac-347-engine-leak.spec.ts` (#347): spawns the
 * real engine-fake `serve.ts` with stdin ignored — the launch shape whose
 * SIGKILLed runner used to leak `--tick 25` engines — then idles. The spec
 * SIGKILLs THIS process and asserts the tagged engine self-exits on the
 * reparent. Prints `PARENT_READY <serve-pid>`.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { watchOrphanExit } from "./engine-leak";

const tag = process.argv[process.argv.indexOf("--tag") + 1];
if (!tag) throw new Error("serve-parent needs --tag <tag>");

const serve = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/engine-fake/scripts/serve.ts",
);
const engine = spawn(
  "bun",
  [serve, "--port", "0", "--tick", "25", "--tag", tag],
  { stdio: ["ignore", "pipe", "inherit"] },
);
engine.stdout?.once("data", () => console.log(`PARENT_READY ${engine.pid}`));

// Bail out if the engine never prints its LISTENING line.
setTimeout(() => {
  console.error("serve-parent: engine never listened");
  process.exit(1);
}, 30_000).unref();

/* Idle like a busy worker; the watchdog exits us if the spec runner dies
   first. */
watchOrphanExit();
await new Promise(() => {});
