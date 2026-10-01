import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  engineTag,
  expectNoEngineLeak,
  killStack,
  killTagged,
  taggedPids,
} from "./engine-leak";
import { wport } from "./ports";

/* #347: a test run's engine-fake/surfaces-demo must not outlive it — Oscar
   found four `serve.ts --tick 25` and one surfaces-demo alive 3.5 days after
   their runs ended. Specs boot the stack detached with stdin ignored, so
   nothing reached the tree when the worker died. The fix is self-exit:
   every long-lived entry point watches parentage and dies with the tree.

   This spec is the acceptance probe: `stack-parent.ts` stands in for a
   busy Playwright worker and boots `bun run dev` exactly like a spec does;
   the test SIGKILLs it — no SIGTERM, no stdin EOF, the worst case — then
   asserts zero tagged engine processes and zero processes in the detached
   group survive. */

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "../apps/web");

const groupPids = (pgid: number): number[] => {
  try {
    return execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" })
      .split("\n")
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n !== process.pid);
  } catch {
    return [];
  }
};

test.describe("engine leak — killed runner leaves nothing (#347)", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });

  let parent: ChildProcess | undefined;
  let tag = "";
  let pgid = 0;

  test.afterEach(async () => {
    // The test kills the parent itself; this is only the failure path —
    // afterEach still proves the suite never leaves tagged orphans.
    if (parent?.pid) killStack(parent.pid);
    if (tag) {
      const leaked = taggedPids(tag);
      if (leaked.length) killTagged(tag);
      await expectNoEngineLeak(tag);
    }
  });

  test("SIGKILLed worker: tagged engines and the detached group all die", async () => {
    const tag_ = engineTag("ac347");
    tag = tag_;
    const home = mkdtempSync(path.join(tmpdir(), "lilos-ac347-"));
    const ports = {
      relay: wport(4740),
      feed: wport(4741),
      web: wport(4742),
    };

    parent = spawn(
      "bun",
      [path.join(here, "stack-parent.ts"), "--web-dir", webDir],
      {
        stdio: ["ignore", "pipe", "inherit"],
        env: {
          ...process.env,
          LILOS_HOME: home,
          LILOS_ENGINE_TAG: tag_,
          LILOS_RELAY_PORT: String(ports.relay),
          LILOS_FEED_PORT: String(ports.feed),
          LILOS_WEB_PORT: String(ports.web),
        },
      },
    );

    // Wait for PARENT_READY <shim-pid> — the whole tree is up by then.
    const shimPid = await new Promise<number>((resolve, reject) => {
      let buf = "";
      const t = setTimeout(
        () => reject(new Error("stack-parent never reported ready")),
        150_000,
      );
      parent?.stdout?.on("data", (d) => {
        buf += String(d);
        const m = buf.match(/PARENT_READY (\d+)/);
        if (m) {
          clearTimeout(t);
          resolve(Number.parseInt(m[1], 10));
        }
      });
      parent?.once("exit", (code) =>
        reject(new Error(`stack-parent exited early (${code}): ${buf}`)),
      );
    });
    pgid = shimPid; // detached: the `bun run dev` shim leads the group

    // Precondition: the tree is real — a tagged engine + group members.
    await expect.poll(() => taggedPids(tag_)).not.toEqual([]);
    expect(groupPids(pgid).length).toBeGreaterThan(0);

    // The kill: SIGKILL on the "worker" — no graceful shutdown path runs.
    if (!parent.pid) throw new Error("stack-parent has no pid");
    process.kill(parent.pid, "SIGKILL");

    // AC-2/AC-3: every spawned layer self-exits once orphaned; nothing tagged
    // and nothing in the detached group survives.
    await expectNoEngineLeak(tag_);
    await expect.poll(() => groupPids(pgid), { timeout: 30_000 }).toEqual([]);
  });

  test("engine-fake serve.ts exits when its direct parent dies", async () => {
    // The serve.ts orphan watchdog covers launches that never held its stdin
    // (detached groups, stdio ignore): kill -9 a bare launcher and the fake
    // must still die on the reparent.
    const tag_ = engineTag("ac347-direct");
    tag = tag_;

    const shim = spawn(
      "bun",
      [path.join(here, "serve-parent.ts"), "--tag", tag_],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    parent = shim;

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("serve-parent never reported ready")),
        30_000,
      );
      shim.stdout?.on("data", (d) => {
        if (String(d).includes("PARENT_READY")) {
          clearTimeout(t);
          resolve();
        }
      });
      shim.once("exit", (code) =>
        reject(new Error(`serve-parent exited early (${code})`)),
      );
    });

    await expect.poll(() => taggedPids(tag_)).not.toEqual([]);
    if (!shim.pid) throw new Error("serve-parent has no pid");
    process.kill(shim.pid, "SIGKILL");
    await expectNoEngineLeak(tag_);
  });
});
