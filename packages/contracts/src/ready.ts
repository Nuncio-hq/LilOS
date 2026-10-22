/**
 * Machine-readable "I bound this port" lines (#825).
 *
 * Parallel e2e stacks used to probe a free port, close it, and hand the
 * number to a child that bound it later. Two workers can both observe the
 * same port free in that gap and one ends up talking to the other's server.
 * A child that can `listen(0)` prints the port the kernel actually assigned;
 * the parent reads it here instead of choosing one. The line is the whole
 * contract — relay, harness feed, vite, and engine-fake each print their
 * own, and both `apps/web/dev/stack.ts` and the e2e helper parse with this.
 *
 * Vite is the exception, and the only one: its dev server treats port 0 as
 * "probe an ephemeral port, close the probe, bind that number"
 * (`httpServerStart` → `getAvailableEphemeralPort`), so another `listen(0)`
 * (engine-fake) can take the port in the probe→bind gap. Callers that must
 * pin a port — vite, and a spec that kills a server and rebinds it while a
 * client still holds the address — use `reserveLoopbackPort` instead.
 * The reservation sits below the kernel ephemeral floor (Linux
 * `ip_local_port_range` starts at 32768), which `listen(0)` never hands
 * out, and a cross-process lock keeps a second reservation off the same
 * port until the holder releases it. Not a substitute for `listen(0)` on a
 * child that can bind 0 itself.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ListeningKind = "relay" | "harness" | "web" | "engine-fake";

const LISTENING_LINE: Record<Exclude<ListeningKind, "engine-fake">, RegExp> = {
  relay: /\[relay\] listening on http:\/\/127\.0\.0\.1:(\d+)\b/g,
  // The surfaces line is `[harness] surfaces listening` — it must not
  // count as the feed socket.
  harness: /\[harness\] listening on http:\/\/127\.0\.0\.1:(\d+)\b/g,
  web: /\[web\] listening on http:\/\/127\.0\.0\.1:(\d+)\b/g,
};

const ENGINE_LINE = /LISTENING ws:\/\/127\.0\.0\.1:(\d+)\/ws/g;

/** The port from the last matching ready line in `text`, if one has landed. */
export function parseListeningPort(
  text: string,
  kind: ListeningKind,
): number | undefined {
  const re = kind === "engine-fake" ? ENGINE_LINE : LISTENING_LINE[kind];
  re.lastIndex = 0;
  let port: number | undefined;
  for (const match of text.matchAll(re)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0 && n <= 65535) port = n;
  }
  return port;
}

/* Same band e2e used to probe (#689): strictly under the ephemeral floor
   on Linux, macOS, and Windows, so a `listen(0)` cannot be handed it. */
const RESERVE_LO = 20_000;
const RESERVE_HI = 32_767;
const RESERVE_TRIES = 100;
const lockDir = join(tmpdir(), "lilos-port-locks");

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists and we may not signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Drop locks whose owner has exited, so a crashed worker cannot pin a
    port for the life of the machine. */
const sweepDeadLocks = (): void => {
  let names: string[] = [];
  try {
    names = readdirSync(lockDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const file = join(lockDir, name);
    let pid = Number.NaN;
    try {
      pid = Number(readFileSync(file, "utf8").trim());
    } catch {
      continue;
    }
    if (!pidAlive(pid)) {
      try {
        unlinkSync(file);
      } catch {
        // Another sweeper won the race.
      }
    }
  }
};

const probeFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    const done = (free: boolean) => {
      server.close(() => resolve(free));
    };
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => done(true));
  });

export interface ReservedPort {
  port: number;
  /** Idempotent. The port stays bound only as long as a listener holds it
      after this returns — release once that listener is up, or on failure
      if it never bound. */
  release: () => void;
}

/**
 * Claim one loopback port below the ephemeral floor and hold it against
 * every other reservation until `release`. The claim is a lock file, not
 * a socket: the caller closes nothing the child needs, and `listen(0)`
 * will not be assigned this port. A dead owner's lock is swept first.
 */
export async function reserveLoopbackPort(): Promise<ReservedPort> {
  mkdirSync(lockDir, { recursive: true });
  sweepDeadLocks();
  for (let attempt = 0; attempt < RESERVE_TRIES; attempt++) {
    const port =
      RESERVE_LO + Math.floor(Math.random() * (RESERVE_HI - RESERVE_LO + 1));
    const file = join(lockDir, String(port));
    let fd: number;
    try {
      fd = openSync(file, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    if (!(await probeFree(port))) {
      try {
        unlinkSync(file);
      } catch {
        // Already released.
      }
      continue;
    }
    let released = false;
    return {
      port,
      release: () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(file);
        } catch {
          // Swept or already released.
        }
      },
    };
  }
  throw new Error(
    `no reserved port in ${RESERVE_LO}-${RESERVE_HI} after ${RESERVE_TRIES} tries`,
  );
}
