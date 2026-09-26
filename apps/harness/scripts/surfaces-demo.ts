/**
 * Demo launcher for issue #36 (not CI): starts `serveSurfaces` with the real
 * drivers (headless Chromium + PTY), creates one session, prints the attach
 * params, and stays alive so the prototype's `?surfaces=` leg has something
 * to attach to. Run: `bun apps/harness/scripts/surfaces-demo.ts`
 */
import { serveSurfaces } from "../src/surfaces/server";

const server = await serveSurfaces(0);
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
