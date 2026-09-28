import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { engineBundlePlan } from "./engines";

/**
 * Build dist/LilOS.app — issue #34.
 *
 *   bun apps/desktop/scripts/build.ts [VERSION] [SIGN_IDENTITY] [--engine=hermes|fake]
 *
 * VERSION:      CFBundleVersion + ShortVersionString (default "1").
 *               Changing it makes the app unregister→register the agents on
 *               next launch (SP1 stale-pin rule).
 * SIGN_IDENTITY: "-" (ad-hoc, default for this VM) or a full identity name
 *               like "Developer ID Application: …" (#35 owns notarization).
 * --engine:     explicit engine override (#141). `--engine=hermes` on an
 *               ad-hoc build stamps the real engine as the harness default
 *               (`bun run app:local`); `--engine=fake` on a signed build is
 *               an error. Unset keeps the #85 defaults (fake on ad-hoc,
 *               hermes on signed).
 *
 * Layout produced:
 *   Contents/MacOS/{Electron→LilOS, lilos-svc, lilos-relay, lilos-harness,
 *                  lilos-engine-hermes (+ lilos-engine-fake on dev builds)}
 *   Contents/Resources/app/{main.cjs, preload.cjs, index.html, package.json}
 *   Contents/Resources/LilOS.icns
 *   Contents/Library/LaunchAgents/*.plist
 */

// `--engine=…` is an option, not a positional — strip it before VERSION and
// SIGN_IDENTITY are read so `build.ts 85 -` keeps working unchanged.
const ENGINE_FLAG = process.argv.find((a) => a.startsWith("--engine="));
if (
  ENGINE_FLAG !== undefined &&
  !/^(hermes|fake)$/.test(ENGINE_FLAG.slice(9))
) {
  console.error(
    `unknown --engine value "${ENGINE_FLAG.slice(9)}" — expected hermes or fake`,
  );
  process.exit(1);
}
const ENGINE = ENGINE_FLAG?.slice(9) as "hermes" | "fake" | undefined;
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const VERSION = positional[0] ?? "1";
const IDENTITY = positional[1] ?? "-";
// #85/#141: the signing identity decides the engine bundle — a signed release
// ships only the Hermes adapter; an ad-hoc dev bundle ships both engines and
// boots the fake one unless --engine= overrides the default (app:local).
// Resolved up front so an invalid combination fails before any work runs.
const engines = engineBundlePlan(IDENTITY, ENGINE);
// One release version shared by app + relay + harness (#35): stamped into
// each binary so a bundle's components always agree in `system.status`.
const RELEASE_VERSION = `1.0.${VERSION}`;
const stamp = [
  "--define",
  `process.env.LILOS_RELEASE_VERSION:${JSON.stringify(RELEASE_VERSION)}`,
];
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
  // Bun skips electron's postinstall on fresh CI machines; fetch the dist
  // bundle ourselves (install.js is the package's own downloader).
  console.log("==> electron dist missing — running electron/install.js");
  try {
    execFileSync("node", [join(ROOT, "node_modules/electron/install.js")], {
      cwd: join(ROOT, "node_modules/electron"),
      stdio: "inherit",
    });
  } catch {
    execFileSync("bun", [join(ROOT, "node_modules/electron/install.js")], {
      cwd: join(ROOT, "node_modules/electron"),
      stdio: "inherit",
    });
  }
  if (!existsSync(ELECTRON_APP)) {
    console.error(
      `Electron binary still not at ${ELECTRON_APP} — run \`bun install\` first.`,
    );
    process.exit(1);
  }
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
  ...stamp,
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
  console.log(
    `==> compile lilos-harness (bun standalone, engine default: ${engines.defaultEngine})`,
  );
  run("bun", [
    "build",
    harnessEntry,
    "--compile",
    "--target=bun-darwin-arm64",
    ...stamp,
    "--define",
    `process.env.LILOS_ENGINE_DEFAULT:${JSON.stringify(engines.defaultEngine)}`,
    "--outfile",
    join(BUILD, "lilos-harness"),
  ]);
  // The packaged harness can't run `bun serve.ts` — ship each engine adapter
  // as a sibling binary it auto-discovers next to its own execPath.
  for (const bin of engines.binaries) {
    console.log(`==> compile ${bin.outfile} (bun standalone)`);
    run("bun", [
      "build",
      join(REPO, bin.entry),
      "--compile",
      "--target=bun-darwin-arm64",
      ...stamp,
      "--outfile",
      join(BUILD, bin.outfile),
    ]);
  }
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
  `${JSON.stringify(
    {
      name: "lilos-desktop",
      productName: "LilOS",
      version: RELEASE_VERSION,
      main: "main.cjs",
      // The updater compares feeds against this monotonic build (#35).
      lilosBuild: Number(VERSION),
    },
    null,
    2,
  )}\n`,
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
// Product name on the main executable too — `open`, `ps` and the updater all
// address Contents/MacOS/LilOS.
renameSync(
  join(APP, "Contents", "MacOS", "Electron"),
  join(APP, "Contents", "MacOS", "LilOS"),
);
set("CFBundleExecutable", "LilOS");
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
// apps/web bundle (#27): build it with relative asset paths (the app loads it
// over file://) and ship it so the DM surface opens offline.
const WEB_DIST = join(REPO, "apps", "web", "dist");
if (existsSync(join(REPO, "apps", "web", "package.json"))) {
  execFileSync("bun", ["run", "--cwd", "apps/web", "build"], {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, LILOS_WEB_BASE: "./" },
  });
}
if (existsSync(join(WEB_DIST, "index.html"))) {
  cpSync(WEB_DIST, join(APP, "Contents", "Resources", "app", "web"), {
    recursive: true,
  });
}

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
  ...(skipHarness
    ? []
    : ["lilos-harness", ...engines.binaries.map((b) => b.outfile)]),
]) {
  copyFileSync(join(BUILD, bin), join(APP, "Contents", "MacOS", bin));
  chmodSync(join(APP, "Contents", "MacOS", bin), 0o755);
}

/* Developer ID signing, inside out. `codesign --deep` does not reliably reach
   nested code (Electron's dylibs, Squirrel's ShipIt), and notarization then
   rejects the archive ("not signed with a valid Developer ID certificate",
   "no secure timestamp", "hardened runtime not enabled"). Sign every Mach-O
   file first, then every nested bundle deepest-first, then the app — each
   with the hardened runtime, a secure timestamp and the JIT entitlements. */
const ENTITLEMENTS = join(ROOT, "entitlements.plist");
const MACHO_MAGIC = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);
const isMachO = (path: string): boolean => {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) < 4) return false;
    return MACHO_MAGIC.has(buf.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
};
const walk = (dir: string, files: string[], bundles: string[]) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walk(path, files, bundles);
      if (/\.(app|framework|xpc|appex)$/.test(name)) bundles.push(path);
    } else if (st.isFile() && isMachO(path)) {
      files.push(path);
    }
  }
};
function signInsideOut(app: string, identity: string) {
  const sign = (path: string) =>
    run("codesign", [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      ENTITLEMENTS,
      "--sign",
      identity,
      path,
    ]);
  const files: string[] = [];
  const bundles: string[] = [];
  walk(join(app, "Contents"), files, bundles);
  const depth = (p: string) => p.split("/").length;
  for (const f of files.sort((a, b) => depth(b) - depth(a))) sign(f);
  for (const b of bundles.sort((a, b) => depth(b) - depth(a))) sign(b);
  sign(app);
}

console.log(`==> sign (${IDENTITY === "-" ? "ad-hoc" : IDENTITY})`);
if (IDENTITY === "-") {
  run("codesign", ["--force", "--deep", "--sign", "-", APP]);
} else {
  signInsideOut(APP, IDENTITY);
}
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", APP]);

console.log(`==> done: ${APP}`);
console.log(
  "Install: sudo rm -rf /Applications/LilOS.app && sudo cp -R dist/LilOS.app /Applications/ && open /Applications/LilOS.app",
);
