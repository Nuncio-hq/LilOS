import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * On-disk updater state under `<appSupport>/LilOS/update/` (issue #35).
 * Everything the applier script and the next boot need lives here so the
 * swap survives the app process exiting mid-update.
 */
export interface UpdatePaths {
  root: string;
  /** Downloaded payload zips. */
  downloads: string;
  /** Freshly unpacked candidate .app lives directly under `staging/`. */
  stagingDir: string;
  /** Where the running app is parked while the new build proves itself. */
  rollbackApp: string;
  /** A rejected staged build is moved here instead of deleting outright. */
  junkDir: string;
  /** Written before quit: what the applier should install. */
  pendingFile: string;
  /** Written by the NEW app once its post-update checks pass. */
  bootOkFile: string;
  /** Human/tooling-readable last outcome. */
  statusFile: string;
  applyScript: string;
  logFile: string;
  skippedFile: string;
}

export function updatePaths(baseDir: string): UpdatePaths {
  const root = join(baseDir, "update");
  return {
    root,
    downloads: join(root, "downloads"),
    stagingDir: join(root, "staging"),
    rollbackApp: join(root, "rollback", "LilOS.app"),
    junkDir: join(root, "junk"),
    pendingFile: join(root, "pending.json"),
    bootOkFile: join(root, "boot-ok"),
    statusFile: join(root, "status.json"),
    applyScript: join(root, "apply.sh"),
    logFile: join(root, "update.log"),
    skippedFile: join(root, "skipped-builds.json"),
  };
}

export interface PendingUpdate {
  build: number;
  /** Release marketing version the new app must report (CFBundleShortVersionString). */
  version: string;
  installPath: string;
  stagedApp: string;
}

type UpdatePhase =
  | "downloading"
  | "applying"
  | "verifying"
  | "updated"
  | "rolled-back"
  | "failed"
  | "skipped";

export interface UpdateStatus {
  phase: UpdatePhase;
  version?: string;
  build?: number;
  detail?: string;
  /* #539: set once the shell has shown the rollback dialog, so the message
     fires once per failed build instead of on every launch. */
  notified?: boolean;
  at: number;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeStatus(paths: UpdatePaths, s: Omit<UpdateStatus, "at">) {
  writeJson(paths.statusFile, { ...s, at: Date.now() } satisfies UpdateStatus);
}

/** Builds this app will never try again (rollback already proved them bad). */
export function readSkippedBuilds(baseDir: string): number[] {
  return readJson<number[]>(updatePaths(baseDir).skippedFile) ?? [];
}

export function addSkippedBuild(baseDir: string, build: number): void {
  const paths = updatePaths(baseDir);
  const skipped = new Set(readSkippedBuilds(baseDir));
  skipped.add(build);
  writeJson(paths.skippedFile, [...skipped]);
}

/* #539: "Retry" on the rollback notice lets the feed offer a rolled-back
   build again — without this the skip is permanent and Retry could never
   reach it. */
export function removeSkippedBuild(baseDir: string, build: number): void {
  const paths = updatePaths(baseDir);
  writeJson(
    paths.skippedFile,
    readSkippedBuilds(baseDir).filter((b) => b !== build),
  );
}

/**
 * Boot-time settlement. Called by every start while a `pending.json` exists:
 * - the NEW build (its version matches pending.version) runs `verify()` —
 *   services re-registration + relay handshake + version convergence — and
 *   only then writes `boot-ok`, which releases the applier's watchdog.
 * - the OLD build (mismatch) knows it was rolled back: the failed build is
 *   skipped permanently and the leftover marker is cleared.
 */
export async function settlePendingUpdate(
  baseDir: string,
  myVersion: string,
  verify: () => Promise<boolean>,
): Promise<"none" | "settled" | "failed" | "rolled-back"> {
  const paths = updatePaths(baseDir);
  const pending = readJson<PendingUpdate>(paths.pendingFile);
  if (!pending) return "none";
  if (pending.version !== myVersion) {
    addSkippedBuild(baseDir, pending.build);
    rmSync(paths.pendingFile, { force: true });
    writeStatus(paths, {
      phase: "rolled-back",
      build: pending.build,
      version: pending.version,
      detail: `back on ${myVersion}`,
    });
    return "rolled-back";
  }
  writeStatus(paths, {
    phase: "verifying",
    build: pending.build,
    version: pending.version,
  });
  const ok = await verify().catch(() => false);
  if (!ok) {
    writeStatus(paths, {
      phase: "failed",
      build: pending.build,
      version: pending.version,
      detail: "post-update verification failed",
    });
    return "failed";
  }
  writeFileSync(paths.bootOkFile, `${new Date().toISOString()}\n`);
  rmSync(paths.pendingFile, { force: true });
  writeStatus(paths, {
    phase: "updated",
    build: pending.build,
    version: pending.version,
  });
  return "settled";
}
