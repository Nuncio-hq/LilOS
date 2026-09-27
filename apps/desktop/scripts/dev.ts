import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dev loop: build the app payload + lilos-svc (no service binaries, no .app
 * packaging — SMAppService registration only works from the packaged bundle),
 * boot the shared dev stack (apps/web dev/stack.ts: relay + harness + vite),
 * then run `electron .` pointed at it.
 *
 * `--payload-only` builds build/app and exits — e2e launches Electron itself.
 *
 * Env: LILOS_HOME (shared scratch dir for the stack's state; default
 * ~/.lilos-dev), LILOS_RELAY_PORT / LILOS_FEED_PORT / LILOS_WEB_PORT,
 * ELECTRON_BIN.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const APP_DIR = join(BUILD, "app");
const REPO = join(ROOT, "..", "..");
const WEB_DIR = join(REPO, "apps", "web");

const HOME = process.env.LILOS_HOME ?? join(homedir(), ".lilos-dev");
const RELAY_PORT = Number(process.env.LILOS_RELAY_PORT ?? 4577);
const FEED_PORT = Number(process.env.LILOS_FEED_PORT ?? 4581);
const WEB_PORT = Number(process.env.LILOS_WEB_PORT ?? 5200);
const PAYLOAD_ONLY = process.argv.includes("--payload-only");

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
    {
      name: "lilos-desktop",
      productName: "LilOS",
      version: "0.0.0-dev",
      main: "main.cjs",
    },
    null,
    2,
  )}\n`,
);

if (PAYLOAD_ONLY) process.exit(0);

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

// Dev services come from the web dev stack, not launch agents (those only
// exist inside a packaged .app). main.ts's ensureServices reports that
// degradation on the status page; the app window works regardless.
mkdirSync(HOME, { recursive: true });
const kids: ChildProcess[] = [];
const killAll = () => {
  for (const k of kids) k.kill();
};
process.on("SIGINT", () => {
  killAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  killAll();
  process.exit(0);
});

const stack = spawn("bun", ["run", "dev"], {
  cwd: WEB_DIR,
  stdio: "inherit",
  env: {
    ...process.env,
    LILOS_HOME: HOME,
    LILOS_RELAY_PORT: String(RELAY_PORT),
    LILOS_FEED_PORT: String(FEED_PORT),
    LILOS_WEB_PORT: String(WEB_PORT),
  },
});
kids.push(stack);

// Wait for the dev relay's token so the app window can authenticate.
const tokenPath = join(HOME, "relay-token");
for (let i = 0; i < 200 && !existsSync(tokenPath); i++) {
  await new Promise((r) => setTimeout(r, 50));
}

const electron =
  process.env.ELECTRON_BIN ?? join(ROOT, "node_modules", ".bin", "electron");
const child = spawn(electron, ["."], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    LILOS_RELAY_HOME: HOME,
    LILOS_RELAY_PORT: String(RELAY_PORT),
    LILOS_FEED_PORT: String(FEED_PORT),
    LILOS_WEB_URL: `http://localhost:${WEB_PORT}`,
  },
});
child.on("exit", (code) => {
  killAll();
  process.exit(code ?? 0);
});
