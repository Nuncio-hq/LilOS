import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FolderAccess } from "../src/folder-access";

/* D-#875: the shell's folder-access state machine — pending until touched,
   blocked when the touch refuses, still-pending while the OS prompt is up
   (late answers land whenever they land — nothing is timed out). The
   `read` seam stands in for the real readdir, `mac: true` runs the state
   machine off macOS. */

const tmp = mkdtempSync(join(tmpdir(), "lilos-fa-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HOME = "/Users/tester";
let seq = 0;
const make = (read: (abs: string) => Promise<unknown>, stateFile?: string) =>
  new FolderAccess({
    stateFile: stateFile ?? join(tmp, `state-${seq++}.json`),
    home: HOME,
    read,
    mac: true,
  });

const eperm = () =>
  Promise.reject(Object.assign(new Error("no"), { code: "EPERM" }));
const never = () => new Promise<never>(() => {});
/** The touches settle off microtasks — a setImmediate turn drains them. */
const flush = () => new Promise((r) => setImmediate(r));

describe("FolderAccess (#875)", () => {
  it("starts with every protected folder pending, none blocked", () => {
    const fa = make(() => Promise.resolve([]));
    expect(fa.state()).toEqual({
      pending: ["Desktop", "Documents", "Downloads"],
      blocked: [],
    });
  });

  it("ask() touches each unsettled folder once; settles mark the outcome", async () => {
    const touched: string[] = [];
    const fa = make((abs) => {
      touched.push(abs);
      if (abs.endsWith("/Desktop")) return Promise.resolve([]);
      if (abs.endsWith("/Documents")) return eperm();
      return never();
    });
    await fa.ask();
    expect(touched).toEqual([
      `${HOME}/Desktop`,
      `${HOME}/Documents`,
      `${HOME}/Downloads`,
    ]);
    await flush();
    const s = fa.state();
    // Desktop read fine; Documents refused; Downloads' prompt never answered.
    expect(s.pending).toEqual(["Downloads"]);
    expect(s.blocked).toEqual(["Documents"]);
  });

  it("keeps a never-answered prompt pending — and takes the late answer", async () => {
    let answer!: () => void;
    const fa = make((abs) =>
      abs.endsWith("/Downloads")
        ? new Promise<unknown>((r) => {
            answer = () => r([]);
          })
        : Promise.resolve([]),
    );
    await fa.ask();
    await flush();
    // The OS prompt is still up — nothing was timed out into "blocked".
    expect(fa.state()).toEqual({ pending: ["Downloads"], blocked: [] });
    answer(); // the user clicks Allow ten minutes later — the read lands.
    await flush();
    expect(fa.state()).toEqual({ pending: [], blocked: [] });
  });

  it("remembers the ask across a restart and re-derives blocked", async () => {
    const file = join(tmp, "persist.json");
    const read = (abs: string) =>
      abs.endsWith("/Downloads") ? eperm() : Promise.resolve([]);
    const first = make(read, file);
    await first.ask();
    await flush();
    expect(first.state().blocked).toEqual(["Downloads"]);

    const second = make(read, file);
    // `asked` persisted — nothing is pending even before the probe runs.
    expect(second.state().pending).toEqual([]);
    // A denial answers fast again; `blocked` comes from the live probe.
    await second.refreshBlocked();
    await flush();
    expect(second.state().blocked).toEqual(["Downloads"]);
  });

  it("ensure() touches a pending folder — the project-add prompt (#875)", async () => {
    const touched: string[] = [];
    const fa = make((abs) => {
      touched.push(abs);
      return Promise.resolve([]);
    });
    await fa.ensure(`${HOME}/Desktop/work/LilOS`);
    expect(touched).toEqual([`${HOME}/Desktop`]);
    await flush();
    expect(fa.state().pending).toEqual(["Documents", "Downloads"]);
  });

  it("ensure() awaits the OS answer before resolving (#875 r2)", async () => {
    let answer!: () => void;
    const fa = make((abs) =>
      abs.endsWith("/Desktop")
        ? new Promise<unknown>((r) => {
            answer = () => r([]);
          })
        : Promise.resolve([]),
    );
    let settled = false;
    const p = fa.ensure(`${HOME}/Desktop/work/LilOS`).then((s) => {
      settled = true;
      return s;
    });
    await flush();
    // The prompt is still up — the pending folders.add waits on it.
    expect(settled).toBe(false);
    answer(); // Allow clicked — the await ends, the add proceeds.
    const s = await p;
    expect(settled).toBe(true);
    expect(s).toEqual({ pending: ["Documents", "Downloads"], blocked: [] });
  });

  it("ensure() re-touches a blocked folder a grant just unblocked", async () => {
    let granted = false;
    const read = (abs: string) =>
      abs.endsWith("/Desktop") && !granted ? eperm() : Promise.resolve([]);
    const fa = make(read);
    await fa.ask();
    await flush();
    expect(fa.state().blocked).toEqual(["Desktop"]);
    granted = true; // the user just allowed it in System Settings
    await fa.ensure(`${HOME}/Desktop/work/LilOS`);
    await flush();
    expect(fa.state().blocked).toEqual([]);
  });

  it("refreshBlocked() re-derives blocked on focus — a grant clears it", async () => {
    let granted = false;
    const read = (abs: string) =>
      abs.endsWith("/Documents") && !granted ? eperm() : Promise.resolve([]);
    const fa = make(read);
    await fa.ask();
    await flush();
    expect(fa.state().blocked).toEqual(["Documents"]);
    granted = true;
    await fa.refreshBlocked();
    await flush();
    expect(fa.state().blocked).toEqual([]);
  });

  it("pushes state changes to subscribers", async () => {
    const fa = make(() => Promise.resolve([]));
    const seen = vi.fn();
    fa.onChange(seen);
    await fa.ask();
    await flush();
    expect(seen).toHaveBeenCalledWith({ pending: [], blocked: [] });
  });
});
