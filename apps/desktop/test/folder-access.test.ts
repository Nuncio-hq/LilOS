import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FolderAccess } from "../src/folder-access";

/* D-#875: the shell's folder-access state machine — pending until touched,
   blocked when the touch refuses or keeps waiting. The `read` seam stands
   in for the real readdir so a "macOS prompt nobody answered" is a promise
   that never settles (the probe bound is 30ms here). */

const tmp = mkdtempSync(join(tmpdir(), "lilos-fa-"));
const saved = process.env.LILOS_PROBE_TIMEOUT_MS;
process.env.LILOS_PROBE_TIMEOUT_MS = "30";
afterAll(() => {
  if (saved === undefined) delete process.env.LILOS_PROBE_TIMEOUT_MS;
  else process.env.LILOS_PROBE_TIMEOUT_MS = saved;
  rmSync(tmp, { recursive: true, force: true });
});

const HOME = "/Users/tester";
let seq = 0;
const make = (read: (abs: string) => Promise<unknown>) =>
  new FolderAccess({
    stateFile: join(tmp, `state-${seq++}.json`),
    home: HOME,
    read,
  });

const eperm = () =>
  Promise.reject(Object.assign(new Error("no"), { code: "EPERM" }));
const never = () => new Promise<never>(() => {});

describe("FolderAccess (#875)", () => {
  it("starts with every protected folder pending, none blocked", () => {
    const fa = make(() => Promise.resolve([]));
    expect(fa.state()).toEqual({
      pending: ["Desktop", "Documents", "Downloads"],
      blocked: [],
    });
  });

  it("ask() touches each folder once and settles the outcome", async () => {
    const touched: string[] = [];
    const fa = make((abs) => {
      touched.push(abs);
      if (abs.endsWith("/Desktop")) return Promise.resolve([]);
      if (abs.endsWith("/Documents")) return eperm();
      return never();
    });
    const s = await fa.ask();
    expect(touched).toEqual([
      `${HOME}/Desktop`,
      `${HOME}/Documents`,
      `${HOME}/Downloads`,
    ]);
    expect(s.pending).toEqual([]);
    // Desktop read fine; Documents refused; Downloads' prompt never answered.
    expect(s.blocked).toEqual(["Documents", "Downloads"]);
  });

  it("remembers the ask across a restart and re-derives blocked", async () => {
    const file = join(tmp, "persist.json");
    const read = (abs: string) =>
      abs.endsWith("/Downloads") ? eperm() : Promise.resolve([]);
    const first = new FolderAccess({ stateFile: file, home: HOME, read });
    await first.ask();
    expect(first.state().blocked).toEqual(["Downloads"]);

    const second = new FolderAccess({ stateFile: file, home: HOME, read });
    // `asked` persisted — nothing is pending even before the probe runs.
    expect(second.state().pending).toEqual([]);
    // A denial answers fast again; `blocked` comes from the live probe.
    await second.refreshBlocked();
    expect(second.state().blocked).toEqual(["Downloads"]);
  });

  it("ensure() re-touches a blocked folder a grant just unblocked", async () => {
    let granted = false;
    const read = (abs: string) =>
      abs.endsWith("/Desktop") && !granted ? eperm() : Promise.resolve([]);
    const fa = new FolderAccess({
      stateFile: join(tmp, "ensure.json"),
      home: HOME,
      read,
    });
    await fa.ask();
    expect(fa.state().blocked).toEqual(["Desktop"]);
    granted = true; // the user just allowed it in System Settings
    const s = await fa.ensure("~/Desktop/work/LilOS");
    expect(s.blocked).toEqual([]);
  });

  it("pushes state changes to subscribers", async () => {
    const fa = make(() => Promise.resolve([]));
    const seen = vi.fn();
    fa.onChange(seen);
    await fa.ask();
    expect(seen).toHaveBeenCalledWith({ pending: [], blocked: [] });
  });
});
