/**
 * Machine-readable "I bound this port" lines, and the per-worker port
 * slice for a child that cannot bind 0 (#825).
 *
 * Parallel e2e stacks used to probe a free port, close it, and hand the
 * number to a child that bound it later. Two workers can both observe the
 * same port free in that gap and one ends up talking to the other's server.
 * A child that can `listen(0)` prints the port the kernel actually assigned;
 * the parent reads it here instead of choosing one. The line is the whole
 * contract — relay, harness feed, vite, and engine-fake each print their
 * own. `apps/web/dev/stack.ts` and the e2e helpers parse with this. It
 * lives next to the dev stack, not in `@lilos/contracts`: that package is
 * the Zod boundary, and this is process-output parsing plus the slice.
 *
 * Vite 8.3.4 does not honour `server.port: 0`. A listen trace was
 * `0@0.0.0.0`, then the concrete port on `::` and `127.0.0.1`.
 * `address()` and `resolvedUrls` report that port only after the rebind,
 * so engine-fake's `listen(0)` can take it in the gap (#689). A spec that
 * kills a server and rebinds the same port (ac-28, ac-130, ac-557) has the
 * same need: the number is in the page before the new process binds.
 * Those ports come from `PORT_SLICE`, not from a lock file.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createServer } from "node:net";

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

/**
 * Ports that must be known before the process binds (#825).
 *
 * `port = base + workerIndex * stride + offset`.
 *
 * Playwright's `TEST_PARALLEL_INDEX` is unique among workers that are
 * actually running (0 .. workers-1). Vitest's `VITEST_POOL_ID` is the
 * same kind of id for a vitest worker (1 .. maxWorkers; the only vitest
 * file that boots a stack today passes concrete ports and does not take
 * a slice). One index, one block of `stride` ports. Workers cannot land
 * on each other's numbers, so nothing has to lock the port.
 *
 * The base is 30000, not 33000. Linux `ip_local_port_range` starts at
 * 32768, so 33000 is a port `listen(0)` will hand out and engine-fake
 * can take it between the probe and vite's rebind (#689). macOS and
 * Windows start at 49152. 30000 keeps every offset, for every index up
 * to `maxIndex`, strictly below 32768. `probeLo`–`probeHi` is the band
 * `probeFreePort` / `freePort` still draw from, under the slice, so a
 * probe cannot return a slice port.
 *
 * Offsets:
 * - `relay` — ac-28 / ac-130 / ac-557 / `bootParts` rebind this port
 *   while the page already holds the URL.
 * - `feed` — the same specs, and a `bootParts` boot with no harness
 *   (the page must not be baked with :0 or with another stack's feed).
 * - `web`, `web2`, `web3`, `web4` — vite. One worker can have more than
 *   one stack up (a second `bootStack` beside the first). Each live
 *   stack takes the next name. The name is chosen first; if that port
 *   is held, the boot fails. It does not try the next name.
 *
 * A worker index past `maxIndex` does not fit below the floor. That
 * throws. It does not step into the ephemeral range.
 */
export const PORT_SLICE = {
  base: 30_000,
  stride: 16,
  floor: 32_768,
  maxIndex: 172,
  probeLo: 20_000,
  probeHi: 29_999,
  probeTries: 100,
  offsets: {
    relay: 0,
    feed: 1,
    web: 2,
    web2: 3,
    web3: 4,
    web4: 5,
  },
  viteSlots: ["web", "web2", "web3", "web4"],
} as const;

export type SliceUse = keyof typeof PORT_SLICE.offsets;

/** Playwright's parallel index, else vitest's pool id, else no runner.
    `LILOS_PORT_SHIFT` slides the whole run's slice band: on a machine where
    a sibling worktree's suite already holds the low slices, a run can dodge
    it (`LILOS_PORT_SHIFT=6` sends workers 0,1 to slices 6,7) instead of
    waiting the sibling out. */
export function workerIndex(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.TEST_PARALLEL_INDEX ?? env.VITEST_POOL_ID;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `worker index ${JSON.stringify(raw)} is not a whole number >= 0`,
    );
  }
  const shift = Number(env.LILOS_PORT_SHIFT ?? "0");
  if (!Number.isInteger(shift) || shift < 0) {
    throw new Error(
      `LILOS_PORT_SHIFT ${JSON.stringify(env.LILOS_PORT_SHIFT)} is not a whole number >= 0`,
    );
  }
  return n + shift;
}

/** `base + index * stride + offset`. Throws when the index does not fit. */
export function slicePort(use: SliceUse, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index > PORT_SLICE.maxIndex) {
    throw new Error(
      `worker index ${index} does not fit in the port slice ` +
        `(base ${PORT_SLICE.base}, stride ${PORT_SLICE.stride}, ` +
        `max index ${PORT_SLICE.maxIndex}, floor ${PORT_SLICE.floor})`,
    );
  }
  const offset = PORT_SLICE.offsets[use];
  const port = PORT_SLICE.base + index * PORT_SLICE.stride + offset;
  if (port < PORT_SLICE.base || port >= PORT_SLICE.floor) {
    throw new Error(
      `port ${port} (${use}) is outside ${PORT_SLICE.base}..${PORT_SLICE.floor - 1}`,
    );
  }
  return port;
}

const bindProbe = (port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    const fail = (err: unknown) => {
      server.close(() => reject(err));
    };
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve());
    });
  });

/** Who listens on `port`, from `lsof`: macOS has no `/proc`, and the Mac
    is where parallel stacks collided (#825). `lsof` exits 1 on no match. */
const lsofHolder = (port: number): string | undefined => {
  let out = "";
  try {
    out = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
      { encoding: "utf8", timeout: 5_000 },
    );
  } catch {
    return undefined;
  }
  const pid = /^p(\d+)$/m.exec(out)?.[1];
  if (!pid) return undefined;
  const cmd = /^c(.+)$/m.exec(out)?.[1];
  return cmd ? `pid ${pid}: ${cmd}` : `pid ${pid}`;
};

/** Who is listening on `port`: `/proc` where the host has it, else `lsof`. */
const portHolder = (port: number): string | undefined => {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  let inode: string | undefined;
  let sawTable = false;
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(table, "utf8");
    } catch {
      continue;
    }
    sawTable = true;
    for (const line of text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      const local = parts[1];
      const state = parts[3];
      if (!local?.toUpperCase().endsWith(`:${hex}`)) continue;
      if (state !== "0A") continue;
      inode = parts[9];
      break;
    }
    if (inode && inode !== "0") break;
  }
  if (!sawTable) return lsofHolder(port);
  if (!inode || inode === "0") return undefined;
  const needle = `socket:[${inode}]`;
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return `socket inode ${inode}`;
  }
  for (const pid of pids) {
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) !== needle) continue;
      } catch {
        continue;
      }
      let cmd = "";
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .replace(/\0/g, " ")
          .trim();
      } catch {
        // The process can exit between the fd read and cmdline.
      }
      return cmd ? `pid ${pid}: ${cmd.slice(0, 180)}` : `pid ${pid}`;
    }
  }
  return `socket inode ${inode}`;
};

/**
 * The slice port for `use` on this worker. Probes it first. A holder
 * fails the call: the error names the port, the use, and the listener
 * when `/proc` or `lsof` can see one. No second port is tried.
 *
 * With no worker index (a shell, not Playwright or vitest), this is
 * `probeFreePort` — the same below-slice probe `freePort` uses.
 */
export async function requireSlicePort(
  use: SliceUse,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const index = workerIndex(env);
  if (index === undefined) return probeFreePort();
  const port = slicePort(use, index);
  try {
    await bindProbe(port);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") throw err;
    const holder = portHolder(port);
    throw new Error(
      `port ${port} (${use}, offset ${PORT_SLICE.offsets[use]}, worker ${index}) is already held` +
        (holder ? ` by ${holder}` : ""),
    );
  }
  return port;
}

/** One free loopback port in the probe band. Steps only inside that band. */
export async function probeFreePort(): Promise<number> {
  const span = PORT_SLICE.probeHi - PORT_SLICE.probeLo + 1;
  for (let attempt = 0; attempt < PORT_SLICE.probeTries; attempt++) {
    const port = PORT_SLICE.probeLo + Math.floor(Math.random() * span);
    try {
      await bindProbe(port);
      return port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw new Error(
    `no free port in ${PORT_SLICE.probeLo}-${PORT_SLICE.probeHi} after ${PORT_SLICE.probeTries} tries`,
  );
}
