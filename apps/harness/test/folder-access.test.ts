import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppMessage } from "@lilos/contracts/app";
import type { CheckpointStore } from "@lilos/host";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessCtx, SessionBinding } from "../src/harness/ctx";
import { stampCheckpoint } from "../src/harness/dispatch";

/* #875: on a consent-waiting protected cwd the shadow `git add -A` parks
   inside open() forever — the turn would hang before its prompt is even
   sent. stampCheckpoint's 1 s confirm skips the snapshot instead; the
   turn still runs, the message just can't be a file rewind point.
   chmod 0111 stands in for the TCC wall (traverse ok, readdir refused);
   skipped when tests run as root (mode bits don't apply). */

const tmp = mkdtempSync(join(tmpdir(), "lilos-fa-"));
const HOME = join(tmp, "home");
const DESKTOP = join(HOME, "Desktop");
const PROJ = join(DESKTOP, "proj");
mkdirSync(PROJ, { recursive: true });

const keepHome = process.env.LILOS_TCC_HOME;
process.env.LILOS_TCC_HOME = HOME;
const isRoot = process.getuid?.() === 0;

afterAll(() => {
  if (keepHome === undefined) delete process.env.LILOS_TCC_HOME;
  else process.env.LILOS_TCC_HOME = keepHome;
  chmodSync(DESKTOP, 0o755);
  rmSync(tmp, { recursive: true, force: true });
});

function fixture(cwd: string) {
  let snapshotCalls = 0;
  const stamps: unknown[] = [];
  const warns: string[] = [];
  const checkpoints: CheckpointStore = {
    snapshot: async () => {
      snapshotCalls += 1;
      return "ck-1";
    },
    restore: async () => ({ removed: [], restoredTo: "" }),
    list: async () => [],
    prune: async () => {},
  };
  const ctx = {
    opts: {
      checkpoints,
      log: { warn: (m: string) => warns.push(m) },
      relay: {
        request: async (method: string, params: unknown) => {
          stamps.push({ method, params });
          return {};
        },
      },
    },
  } as unknown as HarnessCtx;
  const binding = {
    conversationId: "conv",
    channelId: "ch",
    cwd,
    hasFolder: true,
  } as SessionBinding;
  const message = { id: "m1" } as AppMessage;
  return {
    ctx,
    binding,
    message,
    snapshotCalls: () => snapshotCalls,
    stamps,
    warns,
  };
}

describe("stampCheckpoint on a protected folder (#875)", () => {
  /* The readable case runs first: the walled case arms the folder's
     blocked flag for 30 s of real time, which would leak into it. */
  it("snapshots and stamps normally on a readable folder", async () => {
    const f = fixture(PROJ);
    await stampCheckpoint.call(f.ctx, f.binding, f.message);
    expect(f.snapshotCalls()).toBe(1);
    expect(f.stamps).toMatchObject([
      {
        method: "messages.setCheckpoint",
        params: { channelId: "ch", messageId: "m1", checkpoint: "ck-1" },
      },
    ]);
  });

  it.skipIf(isRoot)(
    "skips the snapshot on a walled folder and lets the turn proceed",
    async () => {
      chmodSync(DESKTOP, 0o111);
      const f = fixture(PROJ);
      await stampCheckpoint.call(f.ctx, f.binding, f.message);
      expect(f.snapshotCalls()).toBe(0);
      expect(f.stamps).toHaveLength(0);
      expect(f.warns[0]).toContain("folder access");
      chmodSync(DESKTOP, 0o755);
    },
  );
});
