/**
 * Issue #95 live leg — engine start verdicts against the real `hermes` on
 * this Mac. Driven by scripts/live/95.sh. This is the real launcher path
 * (`hermes --version` probe -> spawn the adapter -> LISTENING); no stubs.
 *
 *   hermes --version < MIN_HERMES_VERSION  → the launcher must reject
 *     fatally with the exact AC-1 sentence — one attempt, no retry loop.
 *   hermes --version >= MIN_HERMES_VERSION → the adapter must come up
 *     (`hermes serve` really runs; HERMES_PROVIDER/HERMES_MODEL pass through
 *     to `--provider`/`--model` when set).
 *
 * AC-2's signal path (a device policy SIGKILLing the child) cannot be
 * conjured live — it is covered by e2e/ac-95-engine-reasons.spec.ts with a
 * self-SIGKILLing HERMES_BIN stub.
 *
 * Prints RESULT: PASS/FAIL; exits 0 only on PASS.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hermesTooOldMessage,
  isHermesVersionSupported,
  MIN_HERMES_VERSION,
  parseHermesVersion,
} from "@lilos/engine-hermes";
import { resolveHermesBin } from "../src/engine/discover";
import {
  hermesEngineLauncher,
  isFatalEngineStart,
} from "../src/engine/launcher";
import { createMemoryLogger } from "../src/log";

const log = createMemoryLogger();
const fail = (why: string): never => {
  console.log(`RESULT: FAIL (${why})`);
  console.log("--- harness log ---");
  for (const l of log.lines) console.log(l);
  process.exit(1);
};

const hermesBin = resolveHermesBin();
console.log(`hermes: ${hermesBin}`);
const versionOut = spawnSync(hermesBin, ["--version"], {
  encoding: "utf8",
  timeout: 10_000,
});
const found = parseHermesVersion(
  `${versionOut.stdout ?? ""}\n${versionOut.stderr ?? ""}`,
);
console.log(
  `version: ${found ?? "unrecognized"} (minimum ${MIN_HERMES_VERSION})`,
);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const launcher = hermesEngineLauncher({
  repoRoot,
  hermesBin,
  ...(process.env.HERMES_PROVIDER
    ? { provider: process.env.HERMES_PROVIDER }
    : {}),
  ...(process.env.HERMES_MODEL ? { model: process.env.HERMES_MODEL } : {}),
  log,
});

if (found !== undefined && !isHermesVersionSupported(found)) {
  // AC-1 leg: a too-old Hermes must fail fatally — the exact sentence, one
  // attempt, never a retry loop (retries cannot fix an old binary).
  const err = await launcher
    .start()
    .then(() => null)
    .catch((e) => e);
  if (!isFatalEngineStart(err)) {
    fail(`expected a fatal start verdict, got ${String(err)}`);
  }
  const want = `Error: ${hermesTooOldMessage(found)}`;
  if (String(err) !== want) {
    fail(`wrong verdict: ${String(err)} — wanted ${want}`);
  }
  console.log(`verdict: ${String(err)}`);
  console.log(
    `AC-1 leg: PASS — Hermes ${found} < ${MIN_HERMES_VERSION} rejected up front, no retries`,
  );
  process.exit(0);
}

// Supported (or unreadable) version: the adapter must really boot. The
// handshake's own -32601 -> reserved-exit-code path still guards a Hermes
// the version probe could not read.
const launched = await launcher
  .start()
  .catch((e) => fail(`engine-hermes did not start: ${String(e)}`));
if (!launched) process.exit(1); // unreachable — fail() exits
console.log(`adapter listening: ${launched.url}`);
launched.process?.kill();
await launched.process?.exited;
console.log(
  `launch leg: PASS — Hermes ${found ?? "unrecognized"} booted engine-hermes`,
);
process.exit(0);
