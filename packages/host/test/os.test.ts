import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOST_ERRORS } from "@lilos/contracts/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callHost } from "../src/index";
import { detectEditors, openPlan } from "../src/os";

/**
 * Issue #110 AC tests for the os.* host API. Editors are fake `.app` bundles
 * under a tmp dir ($LILOS_APP_DIRS): an Info.plist carrying the real
 * CFBundleIdentifier plus a bundled cli script that logs its argv — so the
 * test sees the exact execFile argv (no shell). `open` itself is faked by a
 * script on PATH logging to $LILOS_OPEN_LOG.
 */
const TOP = mkdtempSync(join(tmpdir(), "lilos-os-"));
const APPS = join(TOP, "apps");
const BIN = join(TOP, "bin");
const LOG = join(TOP, "open.log");
/** The session folder `os.open` is contained to; has a file + a subdir.
   realpath'd so assertions match the canonical path the host sees
   (macOS: /var → /private/var). */
mkdirSync(join(TOP, "session folder"), { recursive: true });
const ROOT = realpathSync(join(TOP, "session folder"));

function writeApp(
  dir: string,
  bundle: string,
  bundleId: string,
  cli?: string,
): string {
  const app = join(dir, bundle);
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`,
  );
  if (cli) {
    const p = join(app, cli);
    mkdirSync(dirname(p), { recursive: true });
    // Argv proof: each arg logged on its own line (spaces stay inside one arg).
    writeFileSync(
      p,
      '#!/usr/bin/env bash\nfor a in "$@"; do echo "arg:$a" >> "$LILOS_OPEN_LOG"; done\necho "exec:$(basename "$0")" >> "$LILOS_OPEN_LOG"\n',
    );
    chmodSync(p, 0o755);
  }
  return app;
}

function writeFakeOpen() {
  mkdirSync(BIN, { recursive: true });
  writeFileSync(
    join(BIN, "open"),
    '#!/usr/bin/env bash\nfor a in "$@"; do echo "arg:$a" >> "$LILOS_OPEN_LOG"; done\necho "exec:open" >> "$LILOS_OPEN_LOG"\n',
  );
  chmodSync(join(BIN, "open"), 0o755);
}

const calls = () => readFileSync(LOG, "utf8").split("\n").filter(Boolean);

let savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  savedEnv = {
    LILOS_APP_DIRS: process.env.LILOS_APP_DIRS,
    LILOS_OPEN_LOG: process.env.LILOS_OPEN_LOG,
    PATH: process.env.PATH,
  };
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "a file.txt"), "one\ntwo\n");
  mkdirSync(join(ROOT, "sub"));
  writeFakeOpen();
  process.env.LILOS_APP_DIRS = APPS;
  process.env.LILOS_OPEN_LOG = LOG;
  process.env.PATH = `${BIN}:${process.env.PATH}`;
  writeApp(
    APPS,
    "Visual Studio Code.app",
    "com.microsoft.VSCode",
    "Contents/Resources/app/bin/code",
  );
  writeApp(APPS, "Zed.app", "dev.zed.Zed", "Contents/MacOS/cli");
  writeApp(
    APPS,
    "Xcode.app",
    "com.apple.dt.Xcode",
    "Contents/Developer/usr/bin/xed",
  );
  // A decoy: right-looking name, wrong bundle id — must not register.
  writeApp(APPS, "Cursor.app", "com.example.notcursor");
  writeFileSync(LOG, "");
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  rmSync(TOP, { recursive: true, force: true });
});

describe("os.editors / os.open (issue #110)", () => {
  it("AC-1 detects editors by bundle id under the app dirs, in preference order; decoys ignored", async () => {
    const { editors } = (await callHost("os.editors", {})) as {
      editors: { id: string; name: string; app: string }[];
    };
    // Fake dir has vscode + zed + xcode; catalog order wins over write order.
    expect(editors.map((e) => e.id)).toEqual(["vscode", "zed", "xcode"]);
    expect(editors[0]?.app).toBe(join(APPS, "Visual Studio Code.app"));
    // Empty dirs answer [] — the UI then shows Reveal in Finder only.
    const none = (await detectEditors([join(TOP, "empty")])).map((e) => e.id);
    expect(none).toEqual([]);
  });

  it("AC-2 builds each editor's argv: -g for code/cursor, colon for zed, file-only for xcode", () => {
    const file = join(ROOT, "a file.txt");
    const vscode = {
      id: "vscode" as const,
      name: "VS Code",
      app: join(APPS, "Visual Studio Code.app"),
    };
    expect(openPlan("vscode", vscode, file, 12)).toEqual({
      cmd: join(APPS, "Visual Studio Code.app/Contents/Resources/app/bin/code"),
      args: ["-g", `${file}:12`],
    });
    const zed = { id: "zed" as const, name: "Zed", app: join(APPS, "Zed.app") };
    expect(openPlan("zed", zed, file, 7)).toEqual({
      cmd: join(APPS, "Zed.app/Contents/MacOS/cli"),
      args: [`${file}:7`],
    });
    const xcode = {
      id: "xcode" as const,
      name: "Xcode",
      app: join(APPS, "Xcode.app"),
    };
    expect(openPlan("xcode", xcode, file, 7)).toEqual({
      cmd: join(APPS, "Xcode.app/Contents/Developer/usr/bin/xed"),
      args: [file], // Xcode opens the file only — no line arg (issue #110).
    });
    // Folder target: no line.
    expect(openPlan("vscode", vscode, ROOT).args).toEqual(["-g", ROOT]);
    // Editor bundle without the cli → `open -a` still opens it.
    const plain = writeApp(
      join(TOP, "bare"),
      "Cursor.app",
      "com.todesktop.230313mzl4wtc92lm",
    );
    expect(
      openPlan("cursor", { id: "cursor", name: "Cursor", app: plain }, file),
    ).toEqual({
      cmd: "open",
      args: ["-a", plain, file],
    });
  });

  it("AC-3 `os.open` finder reveals the path — real argv, spaces intact, no shell", async () => {
    await callHost("os.open", {
      root: ROOT,
      path: "a file.txt",
      app: "finder",
    });
    expect(calls()).toEqual([
      "arg:-R",
      `arg:${join(ROOT, "a file.txt")}`,
      "exec:open",
    ]);
  });

  it("AC-2 `os.open` opens the file at a line in the picked editor", async () => {
    writeFileSync(LOG, "");
    await callHost("os.open", {
      root: ROOT,
      path: "sub/../a file.txt",
      app: "vscode",
      line: 2,
    });
    expect(calls()).toEqual([
      "arg:-g",
      `arg:${join(ROOT, "a file.txt")}:2`,
      "exec:code",
    ]);
  });

  it("AC-4 paths escaping the session folder are refused (.. and symlinks)", async () => {
    symlinkSync(TOP, join(ROOT, "escape-link"));
    for (const path of ["../outside", "escape-link"]) {
      await expect(
        callHost("os.open", { root: ROOT, path, app: "finder" }),
      ).rejects.toMatchObject({ code: HOST_ERRORS.OUTSIDE_ROOT });
    }
    await expect(
      callHost("os.open", { root: ROOT, path: "gone.txt", app: "finder" }),
    ).rejects.toMatchObject({ code: HOST_ERRORS.PATH_NOT_FOUND });
    // The folder itself ("." → the root) is inside, so it opens.
    writeFileSync(LOG, "");
    await callHost("os.open", { root: ROOT, path: ".", app: "finder" });
    expect(calls()).toEqual(["arg:-R", `arg:${ROOT}`, "exec:open"]);
  });

  it("AC-1/AC-4 an undetected editor answers APP_NOT_FOUND (nothing is launched)", async () => {
    await expect(
      callHost("os.open", {
        root: ROOT,
        path: "a file.txt",
        app: "cursor",
      }),
    ).rejects.toMatchObject({ code: HOST_ERRORS.APP_NOT_FOUND });
    await expect(
      callHost("os.open", { root: ROOT, path: "a file.txt", app: "vi" }),
    ).rejects.toMatchObject({ code: HOST_ERRORS.INVALID_PARAMS });
  });
});
