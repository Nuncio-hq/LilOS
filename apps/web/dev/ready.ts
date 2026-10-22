/**
 * Machine-readable "I bound this port" lines, and the one lock for a
 * child that cannot bind 0 (#825).
 *
 * Parallel e2e stacks used to probe a free port, close it, and hand the
 * number to a child that bound it later. Two workers can both observe the
 * same port free in that gap and one ends up talking to the other's server.
 * A child that can `listen(0)` prints the port the kernel actually assigned;
 * the parent reads it here instead of choosing one. The line is the whole
 * contract — relay, harness feed, vite, and engine-fake each print their
 * own. `apps/web/dev/stack.ts` and the e2e helpers parse with this. It
 * lives next to the dev stack, not in `@lilos/contracts`: that package is
 * the Zod boundary, and this is process-output parsing plus a lock file.
 *
 * Vite 8.3.4 is the exception, and the only one. `server.port: 0` does
 * not stay bound: a trace of `httpServerStart` listened
 * `0@0.0.0.0`, then the concrete port on `::` and on `127.0.0.1`.
 * `httpServer.address()` and `resolvedUrls` report that number only after
 * the later bind, so another `listen(0)` (engine-fake) can take the port
 * in the probe→bind gap (#689). Callers that must pin a port — vite, and
 * a spec that kills a server and rebinds it while a client still holds
 * the address — use `reserveLoopbackPort` instead. The reservation sits
 * below the kernel ephemeral floor (Linux `ip_local_port_range` starts at
 * 32768), which `listen(0)` never hands out, and a cross-process lock
 * keeps a second reservation off the same port until the holder releases
 * it. Not a substitute for `listen(0)` on a child that can bind 0 itself.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ListeningKind = "relay" | "harness" | "web" | "engine-fake";

/* The terminator is part of the match. `:(\d+)\b` treats end-of-string as
   a boundary, so a chunk split mid-port ("…:23" then "456\n") would report
   23. Only a finished line counts; callers keep appending until `\n`. */
const LISTENING_LINE: Record<Exclude<ListeningKind, "engine-fake">, RegExp> = {
  relay: /\[relay\] listening on http:\/\/127\.0\.0\.1:(\d+)[^\n]*\n/g,
  // The surfaces line is `[harness] surfaces listening` — it must not
  // count as the feed socket.
  harness: /\[harness\] listening on http:\/\/127\.0\.0\.1:(\d+)[^\n]*\n/g,
  web: /\[web\] listening on http:\/\/127\.0\.0\.1:(\d+)[^\n]*\n/g,
};

const ENGINE_LINE = /LISTENING ws:\/\/127\.0\.0\.1:(\d+)\/ws[^\n]*\n/g;

/** Text up to and including the last `\n`. A trailing partial line is
    buffered, not parsed. */
const completeLines = (text: string): string => {
  const end = text.lastIndexOf("\n");
  return end < 0 ? "" : text.slice(0, end + 1);
};

/** The port from the last complete ready line in `text`, if one has landed. */
export function parseListeningPort(
  text: string,
  kind: ListeningKind,
): number | undefined {
  const re = kind === "engine-fake" ? ENGINE_LINE : LISTENING_LINE[kind];
  re.lastIndex = 0;
  let port: number | undefined;
  for (const match of completeLines(text).matchAll(re)) {
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

/** True when a reservation lock exists for `port`, live or dead.
    `freePort` skips those: a dead lock is reclaimed by the next claim,
    not by a probe that would hand the number to another stack. */
export function portLockHeld(port: number): boolean {
  return existsSync(join(lockDir, String(port)));
}

/* The directory entry appears only once the inode already holds `${pid}\n`.
   `openSync` + `writeSync` leaves an empty file in between, and a reader
   that sees "" parses it as pid 0, decides the owner is dead, and unlinks
   a lock this process still holds. */
const publishLock = (file: string): boolean => {
  const tmp = join(
    lockDir,
    `.${process.pid}.${randomBytes(6).toString("hex")}`,
  );
  writeFileSync(tmp, `${process.pid}\n`);
  try {
    linkSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp name is already gone.
    }
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    unlinkSync(tmp);
  } catch {
    // The port name already points at the inode.
  }
  return true;
};

/* Only after our own link hit EEXIST on this port. Rename takes the name
   so two reclaimers cannot both delete it; then look. Non-numeric content
   (including an empty file) and a live pid go back under the port name.
   A dead pid is removed so the caller can publish. */
const reclaimDeadLock = (file: string): boolean => {
  const claim = join(
    lockDir,
    `.reclaim.${process.pid}.${randomBytes(6).toString("hex")}`,
  );
  try {
    renameSync(file, claim);
  } catch {
    return false;
  }
  let raw = "";
  try {
    raw = readFileSync(claim, "utf8").trim();
  } catch {
    return false;
  }
  const dead = /^\d+$/.test(raw) && !pidAlive(Number(raw));
  if (!dead) {
    try {
      renameSync(claim, file);
    } catch {
      // Someone published the port name while we held the inode. The
      // copy under `claim` is not a port name, so it does not block them.
    }
    return false;
  }
  try {
    unlinkSync(claim);
  } catch {
    // Already gone.
  }
  return true;
};

const releaseLock = (file: string): void => {
  try {
    const raw = readFileSync(file, "utf8").trim();
    if (raw === String(process.pid)) unlinkSync(file);
  } catch {
    // Already released, or a successor holds it.
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
 * Claim `port` if it is inside the reservation band and no live lock
 * holds it. `undefined` means "not ours" — a live lock, a non-numeric
 * lock, or the port is already bound. A dead owner's lock is reclaimed
 * here and only here, and only because this claim hit EEXIST.
 */
export async function claimLoopbackPort(
  port: number,
): Promise<ReservedPort | undefined> {
  if (!Number.isInteger(port) || port < RESERVE_LO || port > RESERVE_HI) {
    return undefined;
  }
  mkdirSync(lockDir, { recursive: true });
  const file = join(lockDir, String(port));
  if (!publishLock(file)) {
    if (!reclaimDeadLock(file) || !publishLock(file)) return undefined;
  }
  if (!(await probeFree(port))) {
    releaseLock(file);
    return undefined;
  }
  let released = false;
  return {
    port,
    release: () => {
      if (released) return;
      released = true;
      releaseLock(file);
    },
  };
}

/**
 * Claim one loopback port below the ephemeral floor and hold it against
 * every other reservation until `release`. The claim is a lock file, not
 * a socket: the caller closes nothing the child needs, and `listen(0)`
 * will not be assigned this port.
 */
export async function reserveLoopbackPort(): Promise<ReservedPort> {
  mkdirSync(lockDir, { recursive: true });
  for (let attempt = 0; attempt < RESERVE_TRIES; attempt++) {
    const port =
      RESERVE_LO + Math.floor(Math.random() * (RESERVE_HI - RESERVE_LO + 1));
    const held = await claimLoopbackPort(port);
    if (held) return held;
  }
  throw new Error(
    `no reserved port in ${RESERVE_LO}-${RESERVE_HI} after ${RESERVE_TRIES} tries`,
  );
}
