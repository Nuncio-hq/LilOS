import { execFileSync } from "node:child_process";
import {
  chmodSync,
  promises as fsp,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

/* D-#875 bounded probes: a read that can't answer — a FIFO `open()` with
   no writer, a `git` child that never finishes — reports FOLDER_ACCESS
   ("waiting on macOS folder access for …") only when the protected folder
   itself is unreadable; a slow-but-granted op reports its own timeout.
   The probe home is a tmpdir via LILOS_HOME so this runs on any OS.
   A chmod 0111 folder stands in for the TCC wall: chdir/stat still pass
   (the path resolves) but readdir is refused — exactly what a denied
   consent looks like to the confirm read. Skipped when tests run as root
   (root bypasses the mode bits). */

const tmp = mkdtempSync(join(tmpdir(), "lilos-access-"));
const HOME = join(tmp, "home");
const D = join(HOME, "Desktop");
const DOCS = join(HOME, "Documents");
const DL = join(HOME, "Downloads");
for (const dir of [D, DOCS, DL]) mkdirSync(dir, { recursive: true });

const restoreEnv = {
  home: process.env.LILOS_HOME,
  ms: process.env.LILOS_PROBE_TIMEOUT_MS,
};
process.env.LILOS_HOME = HOME;
process.env.LILOS_PROBE_TIMEOUT_MS = "40";

const isRoot = process.getuid?.() === 0;
const deny = (dir: string) => chmodSync(dir, 0o111); // traverse ok, read refused
const allow = (dir: string) => chmodSync(dir, 0o755);

afterAll(() => {
  if (restoreEnv.home === undefined) delete process.env.LILOS_HOME;
  else process.env.LILOS_HOME = restoreEnv.home;
  if (restoreEnv.ms === undefined) delete process.env.LILOS_PROBE_TIMEOUT_MS;
  else process.env.LILOS_PROBE_TIMEOUT_MS = restoreEnv.ms;
  for (const dir of [D, DOCS, DL]) allow(dir);
  rmSync(tmp, { recursive: true, force: true });
});

const never = <T>() => new Promise<T>(() => {});
const inDesktop = join(D, "x");
const inDocs = join(DOCS, "x");

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
    expect(isAccessError({ code: "ENOENT" })).toBe(false);
    expect(isAccessError(new Error("plain"))).toBe(false);
  });
});

describe("bounded() (#875)", () => {
  it.skipIf(isRoot)(
    "times a never-landing read out as FOLDER_ACCESS on a denied folder",
    async () => {
      deny(D);
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
      allow(D);
    },
  );

  it("reports its own timeout when the folder reads fine — no consent cry", async () => {
    // D is 0755: the 1s confirm readdir lands, so the caller hears the
    // honest timeout — a slow op is not a TCC wall (review finding 7).
    await expect(bounded(never(), inDesktop)).rejects.toThrow(/timed out/);
    await expect(bounded(never(), inDesktop)).rejects.not.toBeInstanceOf(
      HostError,
    );
  });

  it.skipIf(isRoot)("a late grant re-opens the folder", async () => {
    deny(DOCS);
    await expect(bounded(never(), inDocs)).rejects.toMatchObject({
      code: HOST_ERRORS.FOLDER_ACCESS,
    });
    allow(DOCS); // granted in System Settings — the very next probe reads.
    await expect(bounded(Promise.resolve(7), inDocs)).resolves.toBe(7);
  });

  it.skipIf(isRoot)(
    "a refused read inside a denied folder reports FOLDER_ACCESS",
    async () => {
      deny(DL);
      const refused = Promise.reject(
        Object.assign(new Error("nope"), { code: "EPERM" }),
      );
      await expect(bounded(refused, join(DL, "x"))).rejects.toMatchObject({
        code: HOST_ERRORS.FOLDER_ACCESS,
        data: { folder: "Downloads" },
      });
      allow(DL);
    },
  );

  it("a refused read inside a GRANTED folder keeps its own errno", async () => {
    // A chmod'd child is not the wall (review finding 4): EPERM stays EPERM.
    const refused = Promise.reject(
      Object.assign(new Error("nope"), { code: "EACCES" }),
    );
    await expect(bounded(refused, inDesktop)).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("passes ordinary failures straight through", async () => {
    const missing = Promise.reject(
      Object.assign(new Error("gone"), { code: "ENOENT" }),
    );
    await expect(bounded(missing, inDesktop)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(isRoot)(
    "a real blocking syscall (FIFO open) reports FOLDER_ACCESS on a denied folder",
    async () => {
      const fifo = join(tmp, "blocked.fifo");
      execFileSync("mkfifo", [fifo]);
      deny(DOCS);
      const opening = fsp.open(fifo, "r"); // blocks until a writer pairs
      await expect(bounded(opening, inDocs)).rejects.toMatchObject({
        code: HOST_ERRORS.FOLDER_ACCESS,
        data: { folder: "Documents" },
      });
      allow(DOCS);
      // Pair a writer so the parked open resolves and the test can exit.
      const w = await fsp.open(fifo, "w");
      const r = await opening;
      await r.close();
      await w.close();
    },
  );

  it("outside the protected folders a timeout is just a timeout", async () => {
    await expect(bounded(never(), join(tmp, "x"), 40)).rejects.toThrow(
      /timed out/,
    );
  });
});

describe("exists() (#875)", () => {
  it("answers true/false for real paths without touching the bound", async () => {
    await expect(exists(tmp)).resolves.toBe(true);
    await expect(exists(join(tmp, "not-there"))).resolves.toBe(false);
  });

  it.skipIf(isRoot)(
    "a permission-denied child inside a readable folder answers false",
    async () => {
      const locked = join(DOCS, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o000); // even stat inside fails — one denied child
      await expect(exists(join(locked, ".git"))).resolves.toBe(false);
      chmodSync(locked, 0o755);
    },
  );
});

describe("git probe bound (#875)", () => {
  /* A `git` that never answers — PATH-injected, like the skill-symlink case
     that hung `session/new` on 27 Oct. LILOS_PROBE_TIMEOUT_MS is 40ms, so
     the child is SIGKILLed almost at once. The protected cwd lives inside
     a chmod-0111 folder: spawn's chdir passes (x bit) while the confirm
     readdir is refused — the deny-by-mode stand-in for the TCC wall. */
  const fakeBin = join(tmp, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "git"), "#!/bin/sh\nsleep 60\n");
  chmodSync(join(fakeBin, "git"), 0o755);
  const repoInDocs = join(DOCS, "repo");
  mkdirSync(repoInDocs);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
  afterAll(() => {
    process.env.PATH = oldPath;
  });

  it.skipIf(isRoot)(
    "a hanging child on a denied protected cwd reports FOLDER_ACCESS",
    async () => {
      deny(DOCS);
      await expect(gitIsRepo({ path: repoInDocs })).rejects.toMatchObject({
        code: HOST_ERRORS.FOLDER_ACCESS,
        data: { folder: "Documents" },
      });
      allow(DOCS);
    },
  );

  it("a hanging child on a GRANTED protected cwd is a plain timeout", async () => {
    // Slow git ≠ TCC (review finding 7): the folder reads fine, so the
    // killed child reports GIT_FAILED, not a consent wait.
    await expect(gitIsRepo({ path: repoInDocs })).rejects.toMatchObject({
      code: HOST_ERRORS.GIT_FAILED,
      message: expect.stringContaining("timed out"),
    });
  });

  it("a hanging child elsewhere is a plain timeout, not a consent cry", async () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    await expect(gitIsRepo({ path: outside })).rejects.toMatchObject({
      code: HOST_ERRORS.GIT_FAILED,
      message: expect.stringContaining("timed out"),
    });
  });
});
