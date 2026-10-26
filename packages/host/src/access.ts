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
 *  macOS too; read lazily so a test can set it before the first probe. */
const homeDir = () => process.env.LILOS_HOME ?? homedir();

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
   "still walled" record: while it pends the folder counts as blocked — a
   repeat probe fails at once instead of parking another syscall on the
   same unanswered prompt. Whatever the readdir answers — a grant's names,
   a denial's EPERM — deletes the record, so the next probe asks afresh.
   A walled folder costs the process exactly one hanging readdir; a pile
   of repeated confirms can't exhaust the fs worker pool (D-#875). */
const stuck = new Map<ProtectedFolder, Promise<boolean>>();

function folderRead(folder: ProtectedFolder): Promise<boolean> {
  let w = stuck.get(folder);
  if (!w) {
    w = fsp.readdir(join(homeDir(), folder)).then(
      () => {
        if (stuck.get(folder) === w) stuck.delete(folder);
        return true;
      },
      () => {
        if (stuck.get(folder) === w) stuck.delete(folder);
        return false;
      },
    );
    stuck.set(folder, w);
  }
  return w;
}

/** Throw FOLDER_ACCESS for `abs` while its protected folder's confirm read
 *  is still out — a repeat probe doesn't park behind the same prompt. */
export function assertFolderReadable(abs: string): void {
  const folder = protectedFolder(abs);
  if (folder && stuck.has(folder)) throw folderAccessError(abs);
}

/** Post-failure classification (D-#875): is the protected folder `abs`
 *  sits in really unreadable right now? The 1 s confirm readdir separates
 *  a consent wait (the read stays out, the folder flags blocked) from an
 *  ordinary slow op — and its late answer clears the flag on a grant. */
export async function confirmFolderBlocked(abs: string): Promise<boolean> {
  const folder = protectedFolder(abs);
  if (!folder) return false;
  if (stuck.has(folder)) return true; // the unanswered confirm is still out
  const read = await Promise.race([
    folderRead(folder),
    new Promise<null>((r) => setTimeout(() => r(null), CONFIRM_MS)),
  ]);
  return read !== true;
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
