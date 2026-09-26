import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build dist/LilOS.app — issue #34.
 *
 *   bun apps/desktop/scripts/build.ts [VERSION] [SIGN_IDENTITY]
 *
 * VERSION:      CFBundleVersion + ShortVersionString (default "1").
 *               Changing it makes the app unregister→register the agents on
 *               next launch (SP1 stale-pin rule).
 * SIGN_IDENTITY: "-" (ad-hoc, default for this VM) or a full identity name
 *               like "Developer ID Application: …" (#35 owns notarization).
 *
 * Layout produced:
 *   Contents/MacOS/{Electron→LilOS, lilos-svc, lilos-relay, lilos-harness}
 *   Contents/Resources/app/{main.cjs, preload.cjs, index.html, package.json}
 *   Contents/Resources/LilOS.icns
 *   Contents/Library/LaunchAgents/*.plist
 */

const VERSION = process.argv[2] ?? "1";
const IDENTITY = process.argv[3] ?? "-";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..", "..");
const BUILD = join(ROOT, "build");
const APP_DIR = join(BUILD, "app");
const DIST = join(ROOT, "dist");
const APP = join(DIST, "LilOS.app");
// Bun installs a workspace package's deps into that workspace's node_modules.
const ELECTRON_APP = join(
  ROOT,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
);

const run = (cmd: string, args: string[]) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit" });
};

if (process.platform !== "darwin") {
  console.error("LilOS.app packaging is macOS-only (SMAppService + codesign).");
  process.exit(1);
}
if (!existsSync(ELECTRON_APP)) {
  console.error(
    `Electron binary not at ${ELECTRON_APP} — run \`bun install\` first.`,
  );
  process.exit(1);
}

console.log("==> render launch-agent plists");
run("bun", [join(ROOT, "scripts", "render-agents.ts")]);

console.log("==> compile lilos-svc (SMAppService helper)");
mkdirSync(BUILD, { recursive: true });
run("swiftc", [
  "-O",
  "-o",
  join(BUILD, "lilos-svc"),
  "-target",
  "arm64-apple-macosx13.0",
  join(ROOT, "native", "lilos-svc", "main.swift"),
]);

console.log("==> compile lilos-relay (bun standalone)");
run("bun", [
  "build",
  join(REPO, "apps", "relay", "src", "index.ts"),
  "--compile",
  "--target=bun-darwin-arm64",
  "--outfile",
  join(BUILD, "lilos-relay"),
]);

const harnessEntry = join(REPO, "apps", "harness", "src", "index.ts");
const skipHarness = process.env.LILOS_SKIP_HARNESS === "1";
if (!existsSync(harnessEntry) && !skipHarness) {
  console.error(
    "apps/harness/src/index.ts missing — the harness binary needs #26's entrypoint (devin/26-workspace-harness). LILOS_SKIP_HARNESS=1 builds a relay-only dev bundle.",
  );
  process.exit(1);
}
if (!skipHarness) {
  console.log("==> compile lilos-harness (bun standalone)");
  run("bun", [
    "build",
    harnessEntry,
    "--compile",
    "--target=bun-darwin-arm64",
    "--outfile",
    join(BUILD, "lilos-harness"),
  ]);
  // The packaged harness can't run `bun serve.ts` — ship the fake engine as
  // a sibling binary it auto-discovers next to its own execPath.
  console.log("==> compile lilos-engine-fake (bun standalone)");
  run("bun", [
    "build",
    join(REPO, "packages", "engine-fake", "scripts", "serve.ts"),
    "--compile",
    "--target=bun-darwin-arm64",
    "--outfile",
    join(BUILD, "lilos-engine-fake"),
  ]);
} else {
  console.warn("!! LILOS_SKIP_HARNESS=1 — dev bundle without lilos-harness");
}

console.log("==> compile app payload (electron main, CJS)");
mkdirSync(APP_DIR, { recursive: true });
run("bun", [
  "build",
  join(ROOT, "src", "main.ts"),
  "--target=node",
  "--format=cjs",
  "--external=electron",
  "--outfile",
  join(APP_DIR, "main.cjs"),
]);
copyFileSync(join(ROOT, "src", "preload.cjs"), join(APP_DIR, "preload.cjs"));
copyFileSync(join(ROOT, "src", "index.html"), join(APP_DIR, "index.html"));
writeFileSync(
  join(APP_DIR, "package.json"),
  JSON.stringify(
    { name: "lilos-desktop", version: `1.0.${VERSION}`, main: "main.cjs" },
    null,
    2,
  ) + "\n",
);

console.log(`==> assemble ${APP} from ${ELECTRON_APP}`);
rmSync(APP, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
// ditto preserves framework symlinks verbatim — cpSync dereferences them and
// codesign then rejects the bundle ("unsealed contents").
run("ditto", [ELECTRON_APP, APP]);

const INFO = join(APP, "Contents", "Info.plist");
const plistBuddy = (args: string[]) =>
  execFileSync("/usr/libexec/PlistBuddy", [...args, INFO], {
    stdio: "pipe",
  });
const set = (key: string, value: string) => {
  try {
    plistBuddy(["-c", `Set :${key} ${value}`]);
  } catch {
    plistBuddy(["-c", `Add :${key} string ${value}`]);
  }
};
set("CFBundleName", "LilOS");
set("CFBundleDisplayName", "LilOS");
set("CFBundleIdentifier", "com.nuncio.lilos");
set("CFBundleShortVersionString", `1.0.${VERSION}`);
set("CFBundleVersion", VERSION);
set("CFBundleIconFile", "LilOS");

const ICON = join(REPO, "assets", "brand", "LilOS.icns");
if (existsSync(ICON)) {
  copyFileSync(ICON, join(APP, "Contents", "Resources", "LilOS.icns"));
}

rmSync(join(APP, "Contents", "Resources", "app"), {
  recursive: true,
  force: true,
});
mkdirSync(join(APP, "Contents", "Resources", "app"), { recursive: true });
cpSync(APP_DIR, join(APP, "Contents", "Resources", "app"), {
  recursive: true,
});

mkdirSync(join(APP, "Contents", "Library", "LaunchAgents"), {
  recursive: true,
});
for (const plist of [
  "com.nuncio.lilos.relay.plist",
  ...(skipHarness ? [] : ["com.nuncio.lilos.harness.plist"]),
]) {
  copyFileSync(
    join(BUILD, "launchagents", plist),
    join(APP, "Contents", "Library", "LaunchAgents", plist),
  );
}
for (const bin of [
  "lilos-svc",
  "lilos-relay",
  ...(skipHarness ? [] : ["lilos-harness", "lilos-engine-fake"]),
]) {
  copyFileSync(join(BUILD, bin), join(APP, "Contents", "MacOS", bin));
  chmodSync(join(APP, "Contents", "MacOS", bin), 0o755);
}

console.log(
  `==> sign (${IDENTITY === "-" ? "ad-hoc" : IDENTITY})`,
);
if (IDENTITY === "-") {
  run("codesign", ["--force", "--deep", "--sign", "-", APP]);
} else {
  run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--deep",
    "--sign",
    IDENTITY,
    APP,
  ]);
}
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", APP]);

console.log(`==> done: ${APP}`);
console.log(
  "Install: sudo rm -rf /Applications/LilOS.app && sudo cp -R dist/LilOS.app /Applications/ && open /Applications/LilOS.app",
);
