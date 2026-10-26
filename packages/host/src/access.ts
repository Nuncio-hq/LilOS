import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { folderAccessMessage, protectedFolderOf } from "@lilos/contracts/host";
import { HOST_ERRORS, HostError } from "./errors.js";

/**
 * D-#875: macOS TCC blocks `open()`/`readdir()` inside ~/Desktop,
 * ~/Documents and ~/Downloads until LilOS.app is granted — and under
 * launchd the consent prompt can't be answered, so an unbounded read hangs
 * the harness forever (27 Oct: Claude Code never answered `session/new`,
 * `git rev-parse` children froze the same way). Every read that can reach
 * a user folder races this bound and answers FOLDER_ACCESS with the one
 * sentence — `waiting on macOS folder access for <folder>` — instead of
 * hanging. The bound is generous for a real probe (15 s) so it only ever
 * fires on a true consent wait; `LILOS_PROBE_TIMEOUT_MS` shortens it in
 * tests.
 */
export const probeTimeoutMs = () =>
  Number(process.env.LILOS_PROBE_TIMEOUT_MS ?? 15_000);

/** Protected-folder names that have already timed out once this process —
 *  a second read is still waiting on the same unanswered prompt, so it
 *  reports immediately rather than parking another worker in a blocked
 *  syscall. Clears when a read on that folder finally lands. */
const stuck = new Map<string, Promise<unknown>>();

export const folderAccessError = (abs: string): HostError =>
  new HostError(HOST_ERRORS.FOLDER_ACCESS, folderAccessMessage(abs, HOME), {
    folder: protectedFolderOf(abs, HOME) ?? null,
    path: abs,
  });

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

/** `e` as a FOLDER_ACCESS error when it looks like a consent wait; else
 *  undefined so the caller keeps its own classification. */
export const asAccessError = (
  e: unknown,
  abs: string,
): HostError | undefined =>
  isAccessError(e) ? folderAccessError(abs) : undefined;

const HOME = homedir();

/**
 * Race a read on `abs` against the probe bound; timeout and the TCC
 * signatures above answer `folderAccessError`, everything else propagates.
 * A folder that already timed out reports fast — its prompt is still up.
 */
export async function bounded<T>(
  p: Promise<T>,
  abs: string,
  ms = probeTimeoutMs(),
): Promise<T> {
  const key = protectedFolderOf(abs, HOME);
  if (key && stuck.has(key)) throw folderAccessError(abs);
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        t = setTimeout(() => {
          if (key && !stuck.has(key)) {
            /* The first wait's promise still lands one day (the user granted
               late) — drop the flag then so fresh reads try again. */
            stuck.set(key, p);
            p.then(
              () => {
                if (stuck.get(key) === p) stuck.delete(key);
              },
              () => {
                if (stuck.get(key) === p) stuck.delete(key);
              },
            );
          }
          reject(folderAccessError(abs));
        }, ms);
      }),
    ]);
  } catch (e) {
    throw asAccessError(e, abs) ?? e;
  } finally {
    clearTimeout(t);
  }
}

/** `existsSync` that can't freeze the loop on a consent wait — the stat is
 *  bounded; ENOENT/ENOTDIR answer false, access failures report. */
export async function exists(abs: string): Promise<boolean> {
  return bounded(
    fsp.stat(abs).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
        throw e;
      },
    ),
    abs,
  );
}
