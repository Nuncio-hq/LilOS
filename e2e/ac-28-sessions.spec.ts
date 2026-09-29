import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { WORKER, wport } from "./ports";

/**
 * Issue #28 — sessions: history after restart, rename/archive, filter,
 * and reconnect-mid-turn with no lost or duplicated output.
 *
 * Unlike ac-27 (one `bun run dev` umbrella), this spec spawns relay /
 * harness / vite as three processes: AC-2 kills the harness alone and AC-5
 * kills the relay alone — the point is watching the rest recover.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");
const SHOTS = path.join(repo, "test-results", "ac-28");

interface Procs {
  home: string;
  webUrl: string;
  relayToken: string;
  ports: { relay: number; feed: number; web: number };
  procs: Record<"relay" | "harness" | "web", ChildProcess | undefined>;
  /** Vite's captured output — the re-optimize reload line must never appear. */
  viteLog: () => string;
  /** Kill one process (or all) and wait for exit. */
  kill: (which?: "relay" | "harness" | "web") => Promise<void>;
  /** Respawn the relay against the same home (used after kill("relay")). */
  restartRelay: () => Promise<void>;
}

const killProc = (proc: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 8_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    proc.kill("SIGTERM");
  });

async function waitForHttp(url: string, ms = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const ok = await fetch(url)
      .then((r) => r.status > 0)
      .catch(() => false);
    if (ok) return;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitForToken(home: string): Promise<string> {
  const tokenPath = path.join(home, "relay-token");
  for (let i = 0; i < 200; i++) {
    try {
      const t = readFileSync(tokenPath, "utf8").trim();
      if (t) return t;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("relay never wrote its token file");
}

async function spawnRelay(home: string, port: number): Promise<ChildProcess> {
  const p = spawn("bun", ["run", "apps/relay/src/index.ts"], {
    cwd: repo,
    env: {
      ...process.env,
      LILOS_RELAY_HOME: home,
      LILOS_RELAY_PORT: String(port),
      LILOS_RELAY_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForHttp(`http://127.0.0.1:${port}/`);
  return p;
}

/**
 * --repeat-each spreads this file's repeats across worker processes; each
 * worker boots the whole stack, so ports (and the vite cache dir below) are
 * offset per worker — otherwise 4 relays race the same port and die (#84).
 */
const viteCacheDir = `node_modules/.vite-ac28-w${WORKER}`;

async function boot(tag: string, home?: string): Promise<Procs> {
  const base = home ?? mkdtempSync(path.join(tmpdir(), `lilos-e2e-28-${tag}-`));
  const leakTag = engineTag(tag);
  const ports = {
    relay: wport(4688),
    feed: wport(4692),
    web: wport(5329),
  };
  let viteOut = "";
  const procs: Procs["procs"] = {
    relay: undefined,
    harness: undefined,
    web: undefined,
  };

  procs.relay = await spawnRelay(base, ports.relay);
  const relayToken = await waitForToken(base);

  const harnessHome = path.join(base, "harness");
  procs.harness = spawn("bun", ["run", "apps/harness/src/index.ts"], {
    cwd: repo,
    env: {
      ...process.env,
      LILOS_ENGINE: "fake",
      LILOS_RELAY_URL: `ws://127.0.0.1:${ports.relay}/ws`,
      LILOS_RELAY_HOME: base,
      LILOS_RELAY_TOKEN: relayToken,
      LILOS_HARNESS_HOME: harnessHome,
      LILOS_REPO_ROOT: repo,
      LILOS_WORKDIR: path.join(harnessHome, "work"),
      LILOS_FEED_PORT: String(ports.feed),
      LILOS_ENGINE_TAG: leakTag,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForHttp(`http://127.0.0.1:${ports.feed}/`);

  procs.web = spawn(
    "bun",
    [
      path.join(webDir, "node_modules", ".bin", "vite"),
      "--config",
      path.join(webDir, "vite.ac28.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(ports.web),
      "--strictPort",
    ],
    {
      cwd: webDir,
      env: {
        ...process.env,
        LILOS_RELAY_WS: `ws://127.0.0.1:${ports.relay}/ws`,
        LILOS_RELAY_TOKEN: relayToken,
        LILOS_ENGINE_WS: `ws://127.0.0.1:${ports.feed}/ws`,
        LILOS_WEB_PORT: String(ports.web),
        LILOS_VITE_CACHE_DIR: viteCacheDir,
      },
      // Captured so the spec can assert no mid-boot re-optimize reload (#84).
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  procs.web.stdout?.on("data", (d) => (viteOut += d));
  procs.web.stderr?.on("data", (d) => (viteOut += d));
  await waitForHttp(`http://127.0.0.1:${ports.web}`);

  return {
    home: base,
    webUrl: `http://127.0.0.1:${ports.web}`,
    relayToken,
    ports,
    procs,
    viteLog: () => viteOut,
    kill: async (which) => {
      const names: (keyof typeof procs)[] = which
        ? [which]
        : ["web", "harness", "relay"];
      for (const n of names) {
        const p = procs[n];
        if (p) {
          procs[n] = undefined;
          await killProc(p);
        }
      }
      if (names.includes("harness")) await expectNoEngineLeak(leakTag);
    },
    restartRelay: async () => {
      procs.relay = await spawnRelay(base, ports.relay);
    },
  };
}

/** Open the app, land on Default's DM home (dismissing the first-run card). */
async function dmDefault(stack: Procs, page: Page) {
  // #84: a vite re-optimize mid-navigation sends a full reload that can
  // abort the in-flight page.goto (ERR_ABORTED on PR #87's CI). A reload
  // wipes the JS context but sessionStorage survives — count navigations.
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "__lilos_navs",
      String(Number(sessionStorage.getItem("__lilos_navs") ?? 0) + 1),
    );
  });
  const navs = () =>
    page.evaluate(() => Number(sessionStorage.getItem("__lilos_navs") ?? 0));
  // #84: goto ERR_ABORTED can come from a vite re-optimize reload OR the
  // page navigating itself — record every navigation + console line so the
  // losing ordering is in the failure message either way.
  const navLog: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navLog.push(`nav -> ${f.url()}`);
  });
  page.on("console", (m) =>
    navLog.push(`console.${m.type()} ${m.text().slice(0, 200)}`),
  );
  page.on("requestfailed", (r) =>
    navLog.push(`reqfail ${r.url()} ${r.failure()?.errorText ?? ""}`),
  );
  try {
    await page.goto(`${stack.webUrl}/`);
  } catch (e) {
    throw new Error(
      `${(e as Error).message}\nvite log tail:\n${stack.viteLog().slice(-2000)}\nnav log:\n${navLog.join("\n")}`,
    );
  }
  const nav0 = await navs();
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 60_000, // the first run spawns the engine; suite runs are parallel
  });
  const dmBtn = page.getByRole("button", {
    name: /open dm|set up later|message/i,
  });
  if (
    await dmBtn
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await dmBtn.first().click();
  } else {
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
  // Any mid-flight full reload bumps the count past what this goto saw —
  // and the navigation entry flips to "reload" even when goto survived it.
  const tail = stack.viteLog().slice(-2000);
  expect(await navs(), `vite log tail:\n${tail}`).toBe(nav0);
  expect(
    await page.evaluate(
      () =>
        (
          performance.getEntriesByType(
            "navigation",
          )[0] as PerformanceNavigationTiming
        )?.type,
    ),
    `vite log tail:\n${stack.viteLog().slice(-2000)}`,
  ).not.toBe("reload");
  // Vite-side view too: once the dep optimizer has settled (it can outlast
  // the navigation under load), it must never have broadcast a reload.
  if (stack.viteLog().includes("dependencies optimized")) {
    expect(stack.viteLog()).not.toContain("optimized dependencies changed");
    expect(stack.viteLog()).not.toContain("new dependencies optimized");
  }
}

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

let stack: Procs;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  // Cold dep cache — a warm cache would never re-optimize and the vite-log
  // assertion above would be vacuous. Per-worker dir: a sibling worker's
  // rm must not invalidate this worker's running optimizer (#84).
  rmSync(path.join(webDir, viteCacheDir), {
    recursive: true,
    force: true,
  });
  stack = await boot("main");
});
test.afterAll(async () => {
  await stack?.kill();
});
test.describe.configure({ mode: "serial" });
// #84: keep a trace on failure so a mid-goto abort shows what navigated.
test.use({ trace: "retain-on-failure" });

const ROOT_TEXT = "Summarize the repo layout in one line";
/** Carried across tests (each test gets a fresh page). */
let convUrl = "";

test("AC-1/4 restart keeps conversations listed; filter narrows them", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Turn 1 on stack A.
  await dmDefault(stack, page);
  await send(page, ROOT_TEXT);
  await expect(
    page
      .locator("main")
      .getByText(/repo|layout|readme/i)
      .last(),
  ).toBeVisible({ timeout: 60_000 });
  // The reply preview can land in the home feed before the send's async
  // navigate commits — wait for the thread URL instead of racing it (#103).
  await expect(page).toHaveURL(/\/dm\/[^/]+\/conv_/, { timeout: 10_000 });
  // A send lands on /focus; the conversation URL the panel opens at is it
  // without the /focus tail (#195 — a click re-opens the peek, not Focus).
  convUrl = page.url().replace(/\/focus$/, "");

  // Full app restart — same LILOS_HOME, new processes. Detach the page
  // while vite is down: a stale vite ws client reloads on reconnect, and
  // that reload aborts the next in-flight goto (ERR_ABORTED, #84).
  await stack.kill();
  await page.goto("about:blank");
  stack = await boot("restart", stack.home);
  await dmDefault(stack, page);

  // AC-1: the past conversation is listed with its first message.
  const row = page.getByText(ROOT_TEXT).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac1-after-restart.png` });

  // AC-4: filter by the first message text narrows the list.
  await page.getByPlaceholder("Filter sessions").fill("zzz-no-match");
  await expect(row).toBeHidden();
  await page.getByPlaceholder("Filter sessions").fill("repo layout");
  await expect(row).toBeVisible();

  // Open it back up for the next leg — the row's replies button navigates.
  await page
    .getByRole("button", { name: /\d+ repl(y|ies)/ })
    .first()
    .click();
  await expect(page).toHaveURL(convUrl);
});

test("AC-2 opening a past conversation shows messages + transcript; harness down shows why", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Fresh page: open the stored thread URL — history loads via messages.list.
  await page.goto(convUrl);
  await expect(page.getByText(ROOT_TEXT).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac2-thread-history.png` });

  // Kill only the harness: visible messages must still render, the working
  // transcript area must say why it's empty (AC-2 "says why").
  await stack.kill("harness");
  await page.reload();
  await dmDefault(stack, page);
  await page
    .getByRole("button", { name: /\d+ repl(y|ies)/ })
    .first()
    .click();
  await expect(page.getByText(ROOT_TEXT).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-transcript-note]")).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac2-harness-down.png` });
  // Bring the harness back for the next test.
});

test("AC-3 rename + archive persist across restart", async ({ page }) => {
  test.setTimeout(120_000);
  await dmDefault(stack, page);
  await expect(page.getByText(ROOT_TEXT).first()).toBeVisible({
    timeout: 30_000,
  });

  // Rename via the row's session menu -> inline input (only one session).
  await page.getByRole("button", { name: "Session actions" }).first().click();
  await page.getByRole("menuitem", { name: "Rename session" }).click();
  const input = page.getByLabel("Session title");
  await input.fill("Repo summary thread");
  await input.press("Enter");
  await expect(page.getByText("Repo summary thread").first()).toBeVisible();

  // Archive it — the row leaves the open list into the Archived section.
  await page.getByRole("button", { name: "Session actions" }).first().click();
  await page.getByRole("menuitem", { name: "Archive session" }).click();
  await page.getByText(/Archived/).click(); // expand the archived section
  await expect(page.getByText("Repo summary thread").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac3-archived.png` });

  // Restart: renamed title + archived placement survive. Same detach
  // before the new vite can accept the stale client's reconnect.
  await stack.kill();
  await page.goto("about:blank");
  stack = await boot("restart2", stack.home);
  await dmDefault(stack, page);
  await page.getByText(/Archived/).click();
  await expect(page.getByText("Repo summary thread").first()).toBeVisible({
    timeout: 30_000,
  });
});

test("AC-5 kill the relay mid-turn, restore: output complete, no duplicates", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // "Add a footer" pauses on an approval ask — a deterministic mid-turn hold.
  await dmDefault(stack, page);
  await send(page, "Add a footer to the page");
  const allow = page.getByRole("button", { name: "Allow once" }).first();
  await expect(allow).toBeVisible({ timeout: 60_000 });

  // Relay down mid-turn; the harness's answer can't reach the app yet.
  await stack.kill("relay");

  // Answer the approval while the relay is down — the call fails on a dead
  // socket; keep retrying once the app reconnects until the turn completes.
  await allow.click().catch(() => {});
  await stack.restartRelay();
  const done = page.locator("main").getByText("Done on").first();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await done.isVisible().catch(() => false)) break;
    const again = page.getByRole("button", { name: "Allow once" }).first();
    if (await again.isVisible().catch(() => false))
      await again.click().catch(() => {});
    await page.waitForTimeout(1_000);
  }
  await expect(done).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1_500); // settle window for a stray duplicate
  const count = await page.locator("main").getByText("Done on").count();
  expect(count).toBe(1);
  await page.screenshot({ path: `${SHOTS}/ac5-after-reconnect.png` });
});
