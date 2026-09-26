import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";

/* Issue #56 coverage, against the REAL surfaces path: the spec boots
   `apps/harness/scripts/surfaces-demo.ts` (real PTY + headless Chromium),
   attaches the prototype Workbench via ?surfaces=…, and drives both panes.
   Requires `bun` on PATH and playwright chromium — same prerequisites as
   apps/harness/test/surfaces.test.ts, which `verify` already runs. */

const SHOT = "test-results";

let demo: ChildProcess | null = null;
let attach: {
  http: string;
  ws: string;
  session: string;
  token: string;
} | null = null;

test.beforeAll(async () => {
  test.setTimeout(60_000);
  demo = spawn("bun", ["apps/harness/scripts/surfaces-demo.ts"], {
    env: process.env,
  });
  const out = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () =>
        reject(new Error(`surfaces-demo produced no attach params: ${buf}`)),
      45_000,
    );
    demo.stdout?.on("data", (d) => {
      buf += String(d);
      const end = buf.indexOf("\n}");
      if (end >= 0) {
        clearTimeout(timer);
        resolve(buf.slice(0, end + 2));
      }
    });
    demo.stderr?.on("data", (d) => {
      buf += String(d);
    });
    demo.on("error", reject);
  });
  const parsed = JSON.parse(out) as {
    http: string;
    ws: string;
    session: string;
    token: string;
  };
  attach = parsed;
});

test.afterAll(() => {
  demo?.kill();
});

/** Raw tool-API call — returns status + body so error paths are testable. */
async function tool(name: string, args: unknown = {}) {
  const res = await fetch(`${attach?.http}/tools/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${attach?.token}`,
      "x-lilos-session": attach?.session ?? "",
    },
    body: JSON.stringify(args),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      result?: Record<string, unknown>;
      error?: { code: string; message: string };
    },
  };
}

/** Open the prototype attached to the demo harness, on the Terminal tab. */
async function openWorkbench(page: Page) {
  await page.goto(
    `/?surfaces=${encodeURIComponent(attach?.ws ?? "")}&session=${attach?.session}&token=${attach?.token}`,
  );
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  await page.locator("[data-session]").first().click();
  // Thread → focus view → Workbench panel → Terminal tab. The panel starts
  // open on wide viewports — toggle it on only when it isn't.
  await page.locator('[title="Focus"]').click();
  const terminalTab = page.getByRole("tab", { name: /Terminal/ });
  try {
    await terminalTab.waitFor({ state: "visible", timeout: 4000 });
  } catch {
    await page.locator('[title="Workbench"]').click();
  }
  await terminalTab.click();
  // The live terminal replaces the mock tab only after the viewer socket's
  // hello arrives — wait for real PTY output before asserting on it.
  const term = page.locator("pre.whitespace-pre-wrap").last();
  await expect(term).toContainText(/\S/, { timeout: 20_000 });
  return term;
}

test.describe
  .serial("AC-1/2/3/4 workbench terminal+preview polish", () => {
    test("AC-2 the streaming cursor sits on the prompt line, not below it", async ({
      page,
    }) => {
      const term = await openWorkbench(page);
      const probe = await term.evaluate((pre) => {
        // Position of the last non-whitespace character vs the cursor block.
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        let last: Text | null = null;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (/\S/.test((n as Text).data)) last = n as Text;
        }
        const cursor = pre.querySelector(".animate-pulse");
        if (!last || !cursor) return null;
        const t = (last as Text).data.replace(/\s+$/, "");
        const range = document.createRange();
        range.setStart(last, Math.max(0, t.length - 1));
        range.setEnd(last, t.length);
        return {
          char: range.getBoundingClientRect().y,
          cursor: cursor.getBoundingClientRect().y,
          height: range.getBoundingClientRect().height || 1,
        };
      });
      expect(probe, "terminal has text + cursor").not.toBeNull();
      expect(
        Math.abs((probe?.cursor ?? 0) - (probe?.char ?? 99)),
        "cursor stays on the prompt's line",
      ).toBeLessThan(probe?.height ?? 1);
      await page.screenshot({ path: `${SHOT}/ac-2-cursor-on-prompt.png` });
    });

    test("AC-1 typing takes control (banner + agent blocked), explicit release hands it back", async ({
      page,
    }) => {
      const term = await openWorkbench(page);

      // Baseline: the agent's terminal calls work.
      expect(
        (await tool("terminal_run", { command: "echo BASE-$((1+1))" })).status,
      ).toBe(200);

      // The human types into the Workbench terminal → visible takeover.
      await page.getByRole("textbox", { name: /Terminal input/ }).click();
      await page.keyboard.type("x");
      await expect(page.getByText(/in control/i)).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Return control/i }),
      ).toBeVisible();

      // The agent's next terminal call gets a clear result, not silent mixing.
      const held = await tool("terminal_run", { command: "echo nope" });
      expect(held.status).toBe(409);
      expect(held.body.error?.code).toBe("user_control");

      await page.screenshot({ path: `${SHOT}/ac-1-takeover.png` });

      // Delete the stray keystroke while still holding, then explicit
      // release hands the terminal back to the agent.
      await page.keyboard.press("Backspace");
      await page.getByRole("button", { name: /Return control/i }).click();
      await expect(page.getByText(/in control/i)).toHaveCount(0);
      const free = await tool("terminal_run", {
        command: "echo FREE-$((2+2))",
      });
      expect(free.status).toBe(200);
      expect(String(free.body.result?.output)).toContain("FREE-4");
      void term;
    });

    test("AC-3 the Preview address field shows the real landed URL", async ({
      page,
    }) => {
      // A redirector: the typed URL lands on a different final URL.
      const redir: Server = createServer((_req, res) => {
        res.writeHead(302, { location: "http://127.0.0.1:5199/" });
        res.end();
      });
      await new Promise<void>((r) => redir.listen(0, "127.0.0.1", r));
      const port = (redir.address() as AddressInfo).port;
      try {
        await openWorkbench(page);
        await page.getByRole("tab", { name: /Preview/ }).click();
        const field = page.getByPlaceholder("Enter URL");
        await field.fill(`http://127.0.0.1:${port}/go`);
        await field.press("Enter");
        // The field follows the page's real URL, not the typed string.
        await expect(field).toHaveValue("http://127.0.0.1:5199/", {
          timeout: 20_000,
        });
        await page.screenshot({ path: `${SHOT}/ac-3-url-sync.png` });
      } finally {
        redir.close();
      }
    });

    test("AC-4 the remote browser viewport follows the pane (no letterbox)", async ({
      page,
    }) => {
      expect(
        (
          await tool("browser_open", {
            url: "data:text/html,<h1 style='font:48px system-ui'>fits</h1>",
          })
        ).status,
      ).toBe(200);
      await openWorkbench(page);
      await page.getByRole("tab", { name: /Preview/ }).click();
      const img = page.locator("img[alt='live preview']");
      await expect(img).toBeVisible({ timeout: 20_000 });
      const pane = img.locator("..");
      const box = await pane.boundingBox();
      expect(box).not.toBeNull();
      const wantW = Math.round(box?.width ?? 0);
      const wantH = Math.round(box?.height ?? 0);

      // The remote page really resizes to the pane's pixels.
      await expect
        .poll(
          async () =>
            (await tool("browser_eval", { expression: "innerWidth" })).body
              .result?.value,
          { timeout: 20_000 },
        )
        .toBe(wantW);
      await expect
        .poll(
          async () =>
            (await tool("browser_eval", { expression: "innerHeight" })).body
              .result?.value,
        )
        .toBe(wantH);

      // Frames arrive at pane size → object-contain fills the box exactly.
      await expect
        .poll(
          async () => img.evaluate((i: HTMLImageElement) => i.naturalWidth),
          {
            timeout: 20_000,
          },
        )
        .toBe(wantW);

      // A pane resize propagates again.
      await page.setViewportSize({ width: 1000, height: 640 });
      const box2 = await pane.boundingBox();
      const wantW2 = Math.round(box2?.width ?? 0);
      await expect
        .poll(
          async () =>
            (await tool("browser_eval", { expression: "innerWidth" })).body
              .result?.value,
          { timeout: 20_000 },
        )
        .toBe(wantW2);
      await page.screenshot({ path: `${SHOT}/ac-4-viewport-fit.png` });
    });
  });
