/**
 * Demo launcher for issue #36 (not CI): starts `serveSurfaces` with the real
 * drivers (headless Chromium + PTY), creates one session, prints the attach
 * params, and stays alive so the prototype's `?surfaces=` leg has something
 * to attach to. Run: `bun apps/harness/scripts/surfaces-demo.ts`
 *
 * `--tag <tag>` marks the demo and its headless Chromium in argv so a spec's
 * teardown watchdog (e2e/engine-leak.ts) can prove nothing outlived the
 * spawning test — the ~1.9 GB of orphans from issue #96.
 */
import { ChromiumBrowser } from "../src/surfaces/browser";
import { serveSurfaces } from "../src/surfaces/server";

const tagFlag = process.argv.indexOf("--tag");
const tag = tagFlag >= 0 ? process.argv[tagFlag + 1] : undefined;

const server = await serveSurfaces(0, {
  createBrowser: () =>
    Promise.resolve(
      new ChromiumBrowser(tag ? { args: [`--lilos-demo-tag=${tag}`] } : {}),
    ),
});

let stopping = false;
const shutdown = (why: string) => {
  if (stopping) return;
  stopping = true;
  // Bound the graceful close — a wedged PTY/browser must not pin the
  // process (pre-#96 a SIGTERM here was swallowed while `zsh -l` held on).
  const force = setTimeout(() => process.exit(0), 5_000);
  void server
    .close()
    .catch(() => {})
    .finally(() => {
      clearTimeout(force);
      console.error(`surfaces-demo: ${why}, exiting`);
      process.exit(0);
    });
};

// stdin is a pipe whose write end is held by the spawning test; when that
// process dies the fd closes and the read side sees EOF — exit with it,
// even when the parent went away via SIGKILL (no handler runs there).
process.stdin.resume();
process.stdin.once("end", () => shutdown("stdin EOF"));
process.stdin.once("close", () => shutdown("stdin closed"));
process.stdin.once("error", () => shutdown("stdin error"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Belt for the stdin path: once reparented to launchd the spawner is gone
// whether or not its pipe EOF arrived.
setInterval(() => {
  if (process.ppid === 1) shutdown("orphaned");
}, 1_000);

const res = await fetch(`${server.url}/surfaces/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ cwd: process.env.HOME }),
});
const s = (await res.json()) as {
  session: string;
  token: string;
  viewerUrl: string;
};
const wsBase = s.viewerUrl.replace(/\/view\?.*$/, "");
console.log(
  JSON.stringify(
    {
      http: server.url,
      ws: wsBase,
      session: s.session,
      token: s.token,
      attach: `?surfaces=${encodeURIComponent(wsBase)}&session=${s.session}&token=${s.token}`,
    },
    null,
    2,
  ),
);
await new Promise(() => {});
