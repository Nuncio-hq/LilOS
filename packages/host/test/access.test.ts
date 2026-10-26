import { execFileSync } from "node:child_process";
import {
  chmodSync,
  promises as fsp,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bounded,
  exists,
  gitIsRepo,
  HOST_ERRORS,
  HostError,
  isAccessError,
} from "../src/index";

/* D-#875 bounded probes: a filesystem promise that can't answer — a FIFO
   `open()` with no writer, or an injected promise that never lands — must
   report FOLDER_ACCESS ("waiting on macOS folder access for …"), not hang.
   Protected-folder keys come from the path SPELLING (homedir + name), so a
   tmpdir FIFO can stand in for a consent-blocked `~/Desktop` read. The
   probe bound is per-call `ms`; the env knob is exercised via git below. */

const HOME = homedir();
const tmp = mkdtempSync(join(tmpdir(), "lilos-access-"));
const made = [tmp];
const restoreEnv: string | undefined = process.env.LILOS_PROBE_TIMEOUT_MS;
process.env.LILOS_PROBE_TIMEOUT_MS = "40";

afterAll(() => {
  if (restoreEnv === undefined) delete process.env.LILOS_PROBE_TIMEOUT_MS;
  else process.env.LILOS_PROBE_TIMEOUT_MS = restoreEnv;
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const never = <T>() => new Promise<T>(() => {});
const inDesktop = join(HOME, "Desktop", "x");
const inDocs = join(HOME, "Documents", "x");
const inDl = join(HOME, "Downloads", "x");

describe("isAccessError signatures (#875)", () => {
  it("names a killed child, the TCC errnos and git's wording", () => {
    expect(isAccessError(Object.assign(new Error("x"), { killed: true }))).toBe(
      true,
    );
    for (const code of ["EPERM", "EACCES", "EINTR"])
      expect(isAccessError({ code }), code).toBe(true);
    expect(isAccessError({ stderr: "fatal: Operation not permitted" })).toBe(
      true,
    );
    expect(isAccessError({ stderr: "error: Interrupted system call" })).toBe(
      true,
    );
    expect(isAccessError({ code: "ENOENT" })).toBe(false);
    expect(isAccessError(new Error("plain"))).toBe(false);
  });
});

describe("bounded() (#875)", () => {
  it("times a never-landing read out as FOLDER_ACCESS naming the folder", async () => {
    const err = await bounded(never(), inDesktop).then(
      () => {
        throw new Error("should have thrown");
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(HostError);
    expect(err.code).toBe(HOST_ERRORS.FOLDER_ACCESS);
    expect(err.data).toMatchObject({ folder: "Desktop", path: inDesktop });
    expect(err.message).toContain("Desktop");
  });

  it("fails fast on the next read while the folder's prompt is still up", async () => {
    // "Desktop" is stuck from the test above — a second wait must not park.
    const at = Date.now();
    await expect(bounded(never(), inDesktop, 60_000)).rejects.toMatchObject({
      code: HOST_ERRORS.FOLDER_ACCESS,
    });
    expect(Date.now() - at).toBeLessThan(1000);
  });

  it("clears the stuck flag when the late read finally lands", async () => {
    let release!: () => void;
    const late = new Promise<null>((r) => {
      release = () => r(null);
    });
    await expect(bounded(late, inDocs)).rejects.toMatchObject({
      code: HOST_ERRORS.FOLDER_ACCESS,
    });
    release();
    await late;
    // The flag cleared — a fresh read on the folder is tried, not shorted.
    await expect(bounded(Promise.resolve(7), inDocs)).resolves.toBe(7);
  });

  it("names the path for a consent-class timeout outside the known folders", async () => {
    const outside = join(tmp, "fifo-target");
    await expect(bounded(never(), outside)).rejects.toMatchObject({
      code: HOST_ERRORS.FOLDER_ACCESS,
      data: { folder: null, path: outside },
    });
  });

  it("turns a refused read into FOLDER_ACCESS instead of leaking EPERM", async () => {
    const refused = Promise.reject(
      Object.assign(new Error("nope"), { code: "EPERM" }),
    );
    await expect(bounded(refused, inDl)).rejects.toMatchObject({
      code: HOST_ERRORS.FOLDER_ACCESS,
      data: { folder: "Downloads" },
    });
  });

  it("passes ordinary failures straight through", async () => {
    const missing = Promise.reject(
      Object.assign(new Error("gone"), { code: "ENOENT" }),
    );
    await expect(bounded(missing, inDl)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("a real blocking syscall (FIFO open) times out instead of hanging", async () => {
    const fifo = join(tmp, "blocked.fifo");
    execFileSync("mkfifo", [fifo]);
    const opening = fsp.open(fifo, "r"); // blocks until a writer pairs with it
    const abs = join(HOME, "Documents", "fifo");
    await expect(bounded(opening, abs)).rejects.toMatchObject({
      code: HOST_ERRORS.FOLDER_ACCESS,
      data: { folder: "Documents" },
    });
    // Pair a writer so the parked open resolves and libuv lets the test go.
    const w = await fsp.open(fifo, "w");
    const r = await opening;
    await r.close();
    await w.close();
  });
});

describe("exists() (#875)", () => {
  it("answers true/false for real paths without touching the bound", async () => {
    await expect(exists(tmp)).resolves.toBe(true);
    await expect(exists(join(tmp, "not-there"))).resolves.toBe(false);
  });
});

describe("git probe bound (#875)", () => {
  /* A `git` that never answers — PATH-injected, like the skill-symlink case
     that hung `session/new` on 27 Oct. LILOS_PROBE_TIMEOUT_MS is 40ms here,
     so the child is SIGKILLed almost at once. */
  const fakeBin = join(tmp, "fake-bin");
  mkdirSync(fakeBin);
  const fakeGit = join(fakeBin, "git");
  writeFileSync(fakeGit, "#!/bin/sh\nsleep 60\n");
  chmodSync(fakeGit, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
  afterAll(() => {
    process.env.PATH = oldPath;
  });

  it("a hanging child on a protected cwd reports FOLDER_ACCESS", async () => {
    // cwd must exist for the spawn to happen at all — the protected folder
    // itself is the blocked read the issue describes.
    await expect(
      gitIsRepo({ path: join(HOME, "Desktop") }),
    ).rejects.toMatchObject({
      code: HOST_ERRORS.FOLDER_ACCESS,
      data: { folder: "Desktop" },
    });
  });

  it("a hanging child elsewhere is a plain timeout, not a consent cry", async () => {
    await expect(gitIsRepo({ path: tmp })).rejects.toMatchObject({
      code: HOST_ERRORS.GIT_FAILED,
      message: expect.stringContaining("timed out"),
    });
  });
});
