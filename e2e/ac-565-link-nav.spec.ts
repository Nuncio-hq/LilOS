import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  type ElectronApplication,
  expect,
  test,
} from "@playwright/test";
import { electronScreenshot, ensureDesktopPayload } from "./helpers/electron";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #565 — the Electron shell is the last line of defense behind
 * markdown sanitizing (#566): links only open externally on
 * https:/http:/mailto:, the window never navigates off the app's own origin,
 * and every app page carries a CSP. Not macOS-specific — Electron runs under
 * xvfb on CI. Screenshots land in test-results/ac-565 as PR evidence.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const desktopDir = path.join(repo, "apps", "desktop");
const SHOTS = path.join(repo, "test-results", "ac-565");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac565", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Build the payload, launch Electron at the stack's web server, stub
 *  shell.openExternal so the "opens in the browser" half is observable. */
async function launchDesktop(): Promise<ElectronApplication> {
  await ensureDesktopPayload(desktopDir);
  const portOf = (ws: string) => new URL(ws).port;
  const app = await _electron.launch({
    args:
      process.platform === "linux"
        ? [desktopDir, "--no-sandbox"]
        : [desktopDir],
    env: {
      ...process.env,
      LILOS_RELAY_HOME: stack.home,
      LILOS_RELAY_PORT: portOf(stack.relayWs),
      LILOS_FEED_PORT: portOf(stack.feedWs),
      LILOS_WEB_URL: stack.webUrl,
      LILOS_DEBUG_NAV: "1",
    },
  });
  /* Record instead of delegating: a real openExternal would spawn xdg-open
     under xvfb, whose grandchild inherits Electron's stdio pipes — the app
     then never exits and app.close() hangs the whole worker (#565 CI). */
  await app.evaluate(({ shell }) => {
    const g = globalThis as { __openedExternal?: string[] };
    g.__openedExternal = [];
    shell.openExternal = (u: string) => {
      g.__openedExternal?.push(u);
      return Promise.resolve();
    };
  });
  return app;
}

const openedExternal = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as { __openedExternal?: string[] }).__openedExternal ?? [],
  );

const ready = async (app: ElectronApplication) => {
  const win = await app.firstWindow();
  await expect(
    win.locator("aside").getByRole("button", { name: /default/i }),
  ).toBeVisible({ timeout: 60_000 });
  return win;
};

/* Temporary #565 diagnosis: dump the main-process nav event log +
   webContents state collected under LILOS_DEBUG_NAV. */
async function dumpNav(app: ElectronApplication): Promise<void> {
  try {
    const state = await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as { __navEvents?: string[] };
      const wc = BrowserWindow.getAllWindows()[0]?.webContents;
      return {
        url: wc?.getURL(),
        loading: wc?.isLoading(),
        history: wc?.navigationHistory.getAllEntries(),
        events: g.__navEvents ?? [],
      };
    });
    console.log(`[nav-dump] ${JSON.stringify(state, null, 1)}`);
  } catch (e) {
    console.log(`[nav-dump] evaluate failed: ${e}`);
  }
}

test("AC-1+AC-2 links can't open windows or take over the app window", async () => {
  test.setTimeout(180_000);
  const app = await launchDesktop();
  try {
    const win = await ready(app);
    const appUrl = win.url();
    expect(appUrl).toBe(`${stack.webUrl}/`);

    // window.open on a web URL: no second window — it goes to the browser.
    await win.evaluate(() => window.open("https://example.com", "_blank"));
    await expect.poll(() => app.windows().length).toBe(1);
    await expect
      .poll(() => openedExternal(app))
      .toEqual(["https://example.com/"]);
    expect(win.url()).toBe(appUrl);

    // Dangerous schemes are refused outright — no window, no browser.
    await win.evaluate(() => window.open("file:///etc/passwd", "_blank"));
    await win.evaluate(() => window.open("smb://nas/share", "_blank"));
    await expect.poll(() => app.windows().length).toBe(1);
    await expect.poll(() => openedExternal(app)).toHaveLength(1);
    expect(win.url()).toBe(appUrl);

    // Same-window navigation off the app origin is denied; the web one
    // still reaches the browser.
    await win.evaluate(() => {
      window.location.href = "https://example.com/x";
    });
    await expect
      .poll(() => openedExternal(app))
      .toEqual(["https://example.com/", "https://example.com/x"]);
    expect(win.url()).toBe(appUrl);

    /* file: never reaches the browser process — the renderer refuses it
       ("not allowed to load local resource"), so the window stays on the
       app but the frame keeps a phantom pending navigation that wedges
       Playwright's actionability wait ("waiting for navigation to
       finish" for the full timeout, though the document is untouched).
       about:blank really commits, and the did-navigate net snaps the
       window back to the app. Assert the end state — app URL and a
       rendered sidebar — via evaluate, which doesn't wait on the
       phantom navigation. */
    const asideShown = () =>
      win
        .evaluate(() => {
          const el = document.querySelector("aside");
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return (
            r.width > 0 &&
            r.height > 0 &&
            s.visibility !== "hidden" &&
            s.display !== "none"
          );
        })
        /* evaluate races the snap-back's context swap ("execution context
           was destroyed") — not-yet-shown, not an error to the poll. */
        .catch(() => false);
    for (const target of ["file:///etc/passwd", "about:blank"]) {
      await win.evaluate((u) => {
        window.location.href = u;
      }, target);
      await expect.poll(() => win.url(), { timeout: 60_000 }).toBe(appUrl);
      await expect.poll(asideShown, { timeout: 60_000 }).toBe(true);
    }
    await expect.poll(() => openedExternal(app)).toHaveLength(2);

    await electronScreenshot(app, win, `${SHOTS}/ac-1-2-stay-put.png`);
  } finally {
    await dumpNav(app);
    await app.close();
  }
});

test("AC-3 the app page carries a CSP that bites", async () => {
  test.setTimeout(180_000);
  const app = await launchDesktop();
  try {
    const win = await ready(app);
    const csp = await win.evaluate(
      () =>
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content") ?? "",
    );
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");

    // A remote <script> is refused — the violation event is the proof it
    // was CSP, not a network failure.
    const scriptViolation = await win.evaluate(
      () =>
        new Promise<string>((resolve) => {
          document.addEventListener(
            "securitypolicyviolation",
            (e) => resolve(`${e.violatedDirective} blocked ${e.blockedURI}`),
            { once: true },
          );
          const s = document.createElement("script");
          s.src = "https://example.com/evil.js";
          document.head.append(s);
          setTimeout(() => resolve("no violation"), 5_000);
        }),
    );
    expect(scriptViolation).toContain("script-src");
    expect(scriptViolation).toContain("example.com");

    // A remote fetch can't phone home either (connect-src).
    const fetchViolation = await win.evaluate(
      () =>
        new Promise<string>((resolve) => {
          document.addEventListener(
            "securitypolicyviolation",
            (e) => resolve(`${e.violatedDirective} blocked ${e.blockedURI}`),
            { once: true },
          );
          void fetch("https://example.com").catch(() => undefined);
          setTimeout(() => resolve("no violation"), 5_000);
        }),
    );
    expect(fetchViolation).toContain("connect-src");

    // The app still runs under the policy — the sidebar rendered above came
    // from bundled scripts + the loopback relay socket the CSP allows.
    await electronScreenshot(app, win, `${SHOTS}/ac-3-csp.png`);
  } finally {
    await app.close();
  }
});
