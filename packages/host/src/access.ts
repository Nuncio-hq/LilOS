import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  folderAccessMessage,
  type ProtectedFolder,
  protectedFolderOf,
} from "@lilos/contracts/host";
import { HOST_ERRORS, HostError } from "./errors.js";

/**
 * D-#875: macOS TCC blocks `open()`/`readdir()` inside ~/Desktop,
 * ~/Documents and ~/Downloads until LilOS.app is granted — and under
 * launchd the consent prompt can't be answered, so an unbounded read hangs
 * the harness forever (27 Oct: Claude Code never answered `session/new`,
 * `git rev-parse` children froze the same way). The probes that hit those
 * paths — cwd checks, folder scans, `git rev-parse` — race a bound here
 * and report FOLDER_ACCESS instead of hanging.
 *
 * A timeout alone does NOT prove consent is the blocker (a slow `git
 * status` on a big repo times out too): before crying FOLDER_ACCESS the
 * bound confirms the protected folder itself is unreadable — a 1 s readdir
 * of `~/Desktop` that only a real TCC wall can stall. If that read lands,
 * the caller gets its own honest timeout instead.
 */

export const probeTimeoutMs = () =>
  Number(process.env.LILOS_PROBE_TIMEOUT_MS ?? 15_000);

/** The confirmation read's bound: a granted folder answers in ms, a walled
 *  one never does. */
const CONFIRM_MS = 1_000;

/** Tests point the protected-folder check at a temp home so it runs off
 *  macOS too; read lazily so a test can set it before the first probe.
 *  Dedicated knob — LILOS_HOME already means the app state dir elsewhere
 *  (a probe home of `~/.lilos-dev` would miss every real protected path). */
const homeDir = () => process.env.LILOS_TCC_HOME ?? homedir();

/** `abs`'s protected folder under the probe's home. */
export const protectedFolder = (abs: string): ProtectedFolder | undefined =>
  protectedFolderOf(abs, homeDir());

export const folderAccessError = (abs: string): HostError =>
  new HostError(
    HOST_ERRORS.FOLDER_ACCESS,
    folderAccessMessage(abs, homeDir()),
    {
      folder: protectedFolder(abs) ?? null,
      path: abs,
    },
  );

/** execFile killed by its own `timeout`, a read refused by TCC
 *  (EPERM/EACCES), or the launchd signature — the syscall returning EINTR
 *  when the prompt can't be answered. Git says the same on its stderr. */
export function isAccessError(e: unknown): boolean {
  const err = e as { code?: unknown; killed?: boolean; stderr?: string };
  if (err?.killed === true) return true;
  if (err?.code === "EPERM" || err?.code === "EACCES" || err?.code === "EINTR")
    return true;
  return (
    typeof err?.stderr === "string" &&
    /operation not permitted|interrupted system call/i.test(err.stderr)
  );
}

/** `e` as a FOLDER_ACCESS error when it looks like a consent wait on a
 *  protected path; else undefined so the caller keeps its own
 *  classification. */
export const asAccessError = (
  e: unknown,
  abs: string,
): HostError | undefined =>
  isAccessError(e) && protectedFolder(abs) ? folderAccessError(abs) : undefined;

/* One readdir per protected folder doubles as the confirm probe AND the
   late-grant watcher: while it pends the folder counts as blocked — a
   repeat probe fails at once instead of parking another syscall on the
   same unanswered prompt. Whatever it answers — a grant's names, a
   denial's EPERM — deletes the record, so the next probe asks afresh.
   A walled folder costs the process one hanging readdir at a time; a
   pile of repeated confirms can't exhaust the fs worker pool (D-#875).

   The blocked flag expires after STUCK_TTL_MS so probes keep re-checking
   the real op instead of gating forever — but expiry re-arms on the
   still-pending read rather than starting another: a truly stuck folder
   (iCloud) otherwise parks one more fs thread every 30 s. At most one
   in-flight read per folder, ever. */
const STUCK_TTL_MS = 30_000;
const watchers = new Map<ProtectedFolder, Promise<boolean>>();
const blockedUntil = new Map<ProtectedFolder, number>();

/** Test seam: swap the confirm read — a chmod can REFUSE a readdir but
 *  can't hold it pending; only the OS (or this fake) does that. Module
 *  state has no ctor for an opts seam, so a setter it is. */
let confirmRead: (abs: string) => Promise<unknown> = (abs) => fsp.readdir(abs);
export function setConfirmRead(
  fn: ((abs: string) => Promise<unknown>) | null,
): void {
  confirmRead = fn ?? ((abs) => fsp.readdir(abs));
}

function folderRead(folder: ProtectedFolder): Promise<boolean> {
  let w = watchers.get(folder);
  if (!w) {
    w = confirmRead(join(homeDir(), folder)).then(
      () => true,
      () => false,
    );
    watchers.set(folder, w);
    void w.then((ok) => {
      if (watchers.get(folder) === w) watchers.delete(folder);
      if (ok) blockedUntil.delete(folder); // a granted read re-opens it
    });
  }
  return w;
}

/** Throw FOLDER_ACCESS for `abs` while its protected folder is flagged
 *  blocked — a repeat probe fails at once, not behind the same prompt. */
export function assertFolderReadable(abs: string): void {
  const folder = protectedFolder(abs);
  if (folder && (blockedUntil.get(folder) ?? 0) > Date.now()) {
    throw folderAccessError(abs);
  }
}

/** Post-failure classification (D-#875): is the protected folder `abs`
 *  sits in really unreadable right now? The 1 s confirm readdir separates
 *  a consent wait from an ordinary slow op. A read still pending after
 *  the second flags the folder for STUCK_TTL_MS — repeat probes fail fast
 *  while the watcher listens for the late grant; a refused read needs no
 *  flag (probes fail fast on their own and the next one sees a grant).
 *  An expired flag on a still-pending read just re-arms — that read IS
 *  the unanswered wall, and a second one would only park another fs
 *  thread on the same stuck syscall. */
export async function confirmFolderBlocked(abs: string): Promise<boolean> {
  const folder = protectedFolder(abs);
  if (!folder) return false;
  if ((blockedUntil.get(folder) ?? 0) > Date.now()) return true;
  if (watchers.has(folder)) {
    /* The earlier read is still out — re-arm on it, never a second read. */
    blockedUntil.set(folder, Date.now() + STUCK_TTL_MS);
    return true;
  }
  const read = await Promise.race([
    folderRead(folder),
    new Promise<null>((r) => setTimeout(() => r(null), CONFIRM_MS)),
  ]);
  if (read === true) return false;
  if (read === null) blockedUntil.set(folder, Date.now() + STUCK_TTL_MS);
  return true;
}

const TIMED_OUT = Symbol("timed-out");

/**
 * Race a read on `abs` against the probe bound. A timeout or a TCC-style
 * refusal reports FOLDER_ACCESS only when the protected folder itself
 * confirms blocked; a slow-but-granted op reports its own real timeout or
 * error instead (D-#875).
 */
export async function bounded<T>(
  p: Promise<T>,
  abs: string,
  ms = probeTimeoutMs(),
): Promise<T> {
  const folder = protectedFolder(abs);
  if (folder) assertFolderReadable(abs);
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(TIMED_OUT), ms);
      }),
    ]);
  } catch (e) {
    if (
      folder &&
      (e === TIMED_OUT || isAccessError(e)) &&
      (await confirmFolderBlocked(abs))
    ) {
      throw folderAccessError(abs);
    }
    if (e === TIMED_OUT) throw new Error(`timed out after ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** `existsSync` that can't freeze a loop on a consent wait: the stat is
 *  bounded; any failure answers false (the meaning callers already have),
 *  except a confirmed folder-access wait, which reports. */
export async function exists(abs: string): Promise<boolean> {
  try {
    return await bounded(
      fsp.stat(abs).then(
        () => true,
        (e: NodeJS.ErrnoException) => {
          /* A refusal inside a protected folder is the TCC signature — let
             bounded classify it; every other miss is "not there". */
          if (isAccessError(e) && protectedFolder(abs)) throw e;
          return false;
        },
      ),
      abs,
    );
  } catch (e) {
    if (e instanceof HostError && e.code === HOST_ERRORS.FOLDER_ACCESS) throw e;
    return false;
  }
}
