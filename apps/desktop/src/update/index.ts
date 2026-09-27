import { spawn } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { renderApplyScript, stageRelease, writeApplier } from "./apply";
import { inspectSignature, signatureBlock } from "./codesign";
import { fetchLatestRelease, pickUpdate, resolveFeedUrl } from "./feed";
import {
  type PendingUpdate,
  readSkippedBuilds,
  updatePaths,
  writeJson,
  writeStatus,
} from "./state";

/**
 * Update orchestration (issue #35): fetch feed → pick newer build → download
 * + checksum + unpack → signature policy → write pending + detached applier.
 * The caller quits the app on `"apply-ready"`; the applier swaps, relaunches,
 * and the new build's `settlePendingUpdate` proves the handshake.
 */
export interface UpdateEnv {
  /** `app.getVersion()` — the release version this build reports. */
  appVersion: string;
  /** Numeric CFBundleVersion of the running bundle. */
  currentBuild: number;
  /** Path of the running .app (e.g. /Applications/LilOS.app). */
  installPath: string;
  /** App-support dir (the update/ subtree lives under it). */
  baseDir: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export type CheckOutcome = "disabled" | "none" | "apply-ready" | "failed";

export async function checkForUpdate(e: UpdateEnv): Promise<CheckOutcome> {
  const paths = updatePaths(e.baseDir);
  const url = resolveFeedUrl(e.env ?? process.env);
  if (!url) return "disabled";

  let release: Awaited<ReturnType<typeof fetchLatestRelease>>;
  try {
    release = await fetchLatestRelease(url, e.fetchImpl);
  } catch (err) {
    writeStatus(paths, {
      phase: "failed",
      detail: `feed: ${(err as Error).message}`,
    });
    return "failed";
  }
  const update = pickUpdate(
    release,
    e.currentBuild,
    readSkippedBuilds(e.baseDir),
  );
  if (!update) return "none";

  writeStatus(paths, {
    phase: "downloading",
    build: update.build,
    version: update.version,
  });
  let stagedApp: string;
  try {
    stagedApp = await stageRelease(update, paths, e.fetchImpl);
  } catch (err) {
    writeStatus(paths, {
      phase: "failed",
      build: update.build,
      version: update.version,
      detail: `stage: ${(err as Error).message}`,
    });
    return "failed";
  }

  const [current, staged] = await Promise.all([
    inspectSignature(e.installPath),
    inspectSignature(stagedApp),
  ]);
  const block = signatureBlock(current, staged);
  if (block) {
    rmSync(paths.stagingDir, { recursive: true, force: true });
    writeStatus(paths, {
      phase: "skipped",
      build: update.build,
      version: update.version,
      detail: block,
    });
    return "failed";
  }

  writeJson(paths.pendingFile, {
    build: update.build,
    version: update.version,
    installPath: e.installPath,
    stagedApp,
  } satisfies PendingUpdate);
  writeApplier(
    paths,
    renderApplyScript({
      installPath: e.installPath,
      stagedApp,
      rollbackApp: paths.rollbackApp,
      bootOkFile: paths.bootOkFile,
      statusFile: paths.statusFile,
      pendingFile: paths.pendingFile,
      oldPid: process.pid,
      logFile: paths.logFile,
      junkDir: paths.junkDir,
    }),
  );
  writeStatus(paths, {
    phase: "applying",
    build: update.build,
    version: update.version,
  });
  // Per-spawn copy: the next update check rewrites apply.sh (and may re-stage
  // the same build) while this applier is still executing it — bash reads
  // scripts incrementally, so spawn a uniquely-named copy that can't be
  // overwritten under it.
  const applier = join(
    paths.root,
    `apply-${update.build}-${Date.now().toString(36)}.sh`,
  );
  copyFileSync(paths.applyScript, applier);
  const child = spawn("bash", [applier], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return "apply-ready";
}
