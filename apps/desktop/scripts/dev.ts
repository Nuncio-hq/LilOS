import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dev loop: build the app payload + lilos-svc (no service binaries, no .app
 * packaging — SMAppService registration only works from the packaged bundle)
 * then run `electron .`.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const APP_DIR = join(BUILD, "app");
const REPO = join(ROOT, "..", "..");

execFileSync(
  "bun",
  [
    "build",
    join(ROOT, "src", "main.ts"),
    "--target=node",
    "--format=cjs",
    "--external=electron",
    "--outfile",
    join(APP_DIR, "main.cjs"),
  ],
  { stdio: "inherit", cwd: REPO },
);
copyFileSync(join(ROOT, "src", "preload.cjs"), join(APP_DIR, "preload.cjs"));
copyFileSync(join(ROOT, "src", "index.html"), join(APP_DIR, "index.html"));
writeFileSync(
  join(APP_DIR, "package.json"),
  `${JSON.stringify(
    { name: "lilos-desktop", version: "0.0.0-dev", main: "main.cjs" },
    null,
    2,
  )}\n`,
);

if (!existsSync(join(BUILD, "lilos-svc"))) {
  try {
    execFileSync(
      "swiftc",
      [
        "-O",
        "-o",
        join(BUILD, "lilos-svc"),
        "-target",
        "arm64-apple-macosx13.0",
        join(ROOT, "native", "lilos-svc", "main.swift"),
      ],
      { stdio: "inherit" },
    );
  } catch {
    console.warn(
      "lilos-svc build failed (non-macOS?); status will read 'unknown'",
    );
  }
}

const electron = join(ROOT, "node_modules", ".bin", "electron");
const child = spawn(electron, ["."], { cwd: ROOT, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
