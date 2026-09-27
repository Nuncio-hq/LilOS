/**
 * Playwright-worker stand-in for `e2e/ac-96-demo-leak.spec.ts`: the spec
 * spawns this script, it spawns `surfaces-demo.ts` exactly like
 * `workbench-live.spec.ts` does (holding the demo's stdin pipe open), drives
 * one real browser_open so the headless Chromium exists, then idles. The
 * spec kills THIS process (or the demo) and asserts the tagged stack dies
 * with it — proving no orphan reaches launchd (#96 AC-1).
 *
 * Prints `PARENT_READY <demo-pid>` once the demo's Chromium is up.
 */
import { spawn } from "node:child_process";

const tag = process.argv[process.argv.indexOf("--tag") + 1];
if (!tag) throw new Error("demo-parent needs --tag <tag>");

const demo = spawn(
  "bun",
  ["apps/harness/scripts/surfaces-demo.ts", "--tag", tag],
  { stdio: ["pipe", "pipe", "inherit"] },
);

let buf = "";
demo.stdout?.on("data", (d) => {
  buf += String(d);
  const end = buf.indexOf("\n}");
  if (end < 0) return;
  demo.stdout?.removeAllListeners("data");
  const attach = JSON.parse(buf.slice(0, end + 2)) as {
    http: string;
    session: string;
    token: string;
  };
  void fetch(`${attach.http}/tools/browser_open`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${attach.token}`,
      "x-lilos-session": attach.session,
    },
    body: JSON.stringify({ url: "about:blank" }),
  }).then(() => console.log(`PARENT_READY ${demo.pid}`));
});

// Stay alive holding the stdin pipe — the spec's kill supplies the EOF.
await new Promise(() => {});
