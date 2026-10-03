import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";

/**
 * Issue #413 — the per-profile Connect state reaches the app live, not only
 * on load. Before the fix the DM's "Not connected to LilOS" notice and
 * Settings → Engine read rows fetched once by `system.status`; the flip to
 * connected only surfaced on the next poll (or a reload). The reconciled
 * rows now ride `harness.report` → the relay's `connect.changed` broadcast →
 * the client-runtime status atom — no polling.
 *
 * AC-2 (engine-fake): Connect → the notice disappears without reload.
 * AC-1: Settings → Engine reflects the same live row.
 * `LILOS_CONNECT_FAKE=1` opts the fake stack into `FakeConnect` — the real
 * engine has no plugin to install, so rows stay off the default stack.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");

interface Stack {
  home: string;
  webUrl: string;
  stop: () => Promise<void>;
}

async function waitForHttp(url: string, ms = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const ok = await fetch(url)
      .then((r) => r.ok || r.status === 404)
      .catch(() => false);
    if (ok) return;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function killProc(proc: ChildProcess): Promise<void> {
  // `bun run dev` stacks shim layers between `proc` and the dev-stack
  // children — signal the whole group (spawn is `detached`) (#84).
  const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      if (proc.pid) process.kill(-proc.pid, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {}
    }
  };
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      killGroup("SIGKILL");
      resolve();
    }, 8_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    killGroup("SIGTERM");
  });
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === "object" && addr
          ? resolve(addr.port)
          : reject(new Error("no port")),
      );
    });
  });

async function bootStack(tag: string): Promise<Stack> {
  const [relay, feed, web] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  const home = mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const leakTag = engineTag(tag);
  const proc = spawn("bun", ["run", "dev"], {
    cwd: webDir,
    detached: true,
    env: {
      ...process.env,
      LILOS_HOME: home,
      LILOS_ENGINE: "fake",
      LILOS_CONNECT_FAKE: "1",
      LILOS_ENGINE_TAG: leakTag,
      LILOS_RELAY_PORT: String(relay),
      LILOS_FEED_PORT: String(feed),
      LILOS_WEB_PORT: String(web),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${web}`;
  try {
    await waitForHttp(webUrl);
    await waitForHttp(`http://127.0.0.1:${relay}/`);
    await waitForHttp(`http://127.0.0.1:${feed}/`);
    // The token file is written before the relay serves — the stack waits on
    // it, but read it late so a slow fs can't beat us to it.
    const tokenPath = path.join(home, "relay-token");
    let token = "";
    for (let i = 0; i < 300 && !token; i++) {
      try {
        token = readFileSync(tokenPath, "utf8").trim();
      } catch {}
      if (!token) await new Promise((r) => setTimeout(r, 100));
    }
    if (!token) throw new Error(`relay token never appeared at ${tokenPath}`);
    return {
      home,
      webUrl,
      stop: async () => {
        await killProc(proc);
        await expectNoEngineLeak(leakTag);
      },
    };
  } catch (e) {
    await killProc(proc);
    throw e;
  }
}

let stack: Stack;

test.beforeAll(async () => {
  stack = await bootStack("ac413");
});

test.afterAll(async () => {
  await stack?.stop();
});

test("AC-2+AC-1 Connect clears the DM notice live; Settings reads the same row", async ({
  page,
}) => {
  // Past first run: the app lands on the auto-hired employee's DM.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("lilos-onboarded", "1");
    } catch {}
  });
  await page.goto(stack.webUrl);

  const notice = page.locator("[data-not-connected]");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText("Not connected to LilOS");

  await notice.getByRole("button", { name: "Connect" }).click();

  // The reconciled row lands on connect.changed — the notice unmounts live.
  await expect(notice).toBeHidden({ timeout: 10_000 });

  // Settings → Engine reads the same live row — no second poll or reload.
  await page.locator("aside").getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Engine", exact: true }).click();
  await expect(
    dialog.locator('[data-connect-state="connected"]').first(),
  ).toBeVisible({ timeout: 10_000 });
});
