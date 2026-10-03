import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { wport } from "./ports";

/**
 * #374: dark-mode red ink was unreadable — `text-red-800`/`text-red-900` were
 * never remapped under `.dark`, so every chip that pairs a remapped pale red
 * fill with deep red text painted dark-on-dark (~1.5:1). This spec measures
 * the real computed colors in a browser at every site the issue lists: the
 * red StatusBanner, the employee-home session alert, the not-connected notice
 * (same chip family whose local `dark:text-red-200` this change drops), and
 * the app's boot error box — each must hold WCAG AA 4.5:1 in dark, and light
 * mode must keep exactly its original palette.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");
const SHOTS = path.join(repo, "test-results", "ac-374");

type RGBA = { r: number; g: number; b: number; a: number };

interface ContrastRow {
  name: string;
  color: RGBA;
  bg: RGBA;
  ratio: number;
}

/* Read each check's computed color and the background the eye actually sees
   under it: ancestors paint translucent fills, so walk up the tree compositing
   each element's background-color over the next until the stack is opaque.
   (Same machinery as ac-315's #371 tray spec.) */
const measure = (
  page: Page,
  checks: { name: string; sel: string }[],
): Promise<ContrastRow[]> =>
  page.evaluate((checks) => {
    /* getComputedStyle hands back whatever syntax the sheet declared — oklch,
       color-mix, rgb — so colours are sampled through a canvas: fillStyle
       normalises any CSS colour, and one painted pixel yields rgba + alpha. */
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context for colour sampling");
    const parse = (
      s: string,
    ): { r: number; g: number; b: number; a: number } | null => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#f0f"; // sentinel: an unparseable colour keeps it
      ctx.fillStyle = s;
      if (ctx.fillStyle === "#ff00ff") return null;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    };
    const over = (
      top: { r: number; g: number; b: number; a: number },
      under: { r: number; g: number; b: number; a: number },
    ) => {
      const a = top.a + under.a * (1 - top.a);
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (top.r * top.a + under.r * under.a * (1 - top.a)) / a,
        g: (top.g * top.a + under.g * under.a * (1 - top.a)) / a,
        b: (top.b * top.a + under.b * under.a * (1 - top.a)) / a,
        a,
      };
    };
    const effectiveBg = (el: Element) => {
      let acc = { r: 0, g: 0, b: 0, a: 0 };
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) acc = over(acc, c); // nearest layer stays on top
        if (acc.a >= 0.999) return { ...acc, a: 1 };
      }
      return over(acc, { r: 255, g: 255, b: 255, a: 1 }); // canvas fallback
    };
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    return checks.map(({ name, sel }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`contrast check missing: ${name} (${sel})`);
      const bg = effectiveBg(el);
      // The ink itself may be translucent — composite it over the same bg.
      const ink = over(
        parse(getComputedStyle(el).color) ?? { r: 0, g: 0, b: 0, a: 1 },
        bg,
      );
      const l1 = Math.max(lum(ink), lum(bg));
      const l2 = Math.min(lum(ink), lum(bg));
      return { name, color: ink, bg, ratio: (l1 + 0.05) / (l2 + 0.05) };
    });
  }, checks);

const fmt = (rows: ContrastRow[]) =>
  rows
    .map(
      (r) =>
        `${r.name}=${r.ratio.toFixed(2)}:1(${Math.round(r.color.r)},${Math.round(r.color.g)},${Math.round(r.color.b)} on ${Math.round(r.bg.r)},${Math.round(r.bg.g)},${Math.round(r.bg.b)})`,
    )
    .join(" ");

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
  return new Promise((resolve) => {
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
}

/* Theme toggles run colour transitions (~150ms): computed colors read
   mid-flight come back as oklab interpolations, not the final value. */
const killMotion = (page: Page) =>
  page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important}",
  });

/* The prototype's Preview menu puts the mock app into states the mock data
   can't reach on its own — the red banner and session alert live there. */
const pickScenario = async (page: Page, label: string) => {
  await page.getByRole("button", { name: "Preview states" }).click();
  await page.getByRole("menuitemradio", { name: label }).click();
};

/* Two <aside>s render (sidebar + right panel) — the nav sidebar is first. */
const openDm = (page: Page, name: RegExp) =>
  page.locator("aside").first().getByRole("button", { name }).click();

/* Light mode must not change: every class still resolves to its light palette
   value (the fix only adds `.dark` rules and `dark:` variants). Pinned to the
   exact sRGB the canvas samples. */
const expectInk = (
  light: Record<string, RGBA>,
  name: string,
  rgb: [number, number, number],
) => {
  const c = light[name] as RGBA;
  expect(
    `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`,
    `${name} must keep its light-mode color`,
  ).toBe(`${rgb[0]},${rgb[1]},${rgb[2]}`);
};

test("red status ink holds WCAG AA in dark and keeps its palette in light (#374)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator("aside").first()).toContainText("Employees", {
    timeout: 30_000,
  });
  await killMotion(page);
  const html = page.locator("html");

  /* Site 1 — the red StatusBanner (packages/ui/src/shell/banner.tsx), shown by
     the "Engine down" preview scenario. */
  await pickScenario(page, "Engine down");
  const banner = page.locator("[data-status-banner]");
  await expect(banner).toBeVisible();

  /* Site 2 — the session alert chip (employee-home.tsx SessionAlertRow, the
     non-warm variant), shown by "Model error" on a DM home. */
  const bannerChecks = [
    { name: "banner text", sel: "[data-status-banner] > div" },
    { name: "banner action", sel: "[data-status-banner] button" },
    { name: "banner icon", sel: "[data-status-banner] svg" },
  ];
  const lightPins: Record<string, RGBA> = {};
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    if (scheme === "dark") {
      await expect(html).toHaveClass(/dark/);
    } else {
      await expect(html).not.toHaveClass(/dark/);
    }
    await expect(banner).toBeVisible();
    await banner.scrollIntoViewIfNeeded();
    const rows = await measure(page, bannerChecks);
    console.log(`#374 banner ${scheme}`, fmt(rows));
    for (const r of rows) {
      if (scheme === "dark") {
        expect(
          r.ratio,
          `${r.name} dark contrast ${r.ratio.toFixed(2)}:1 (ink ${JSON.stringify(r.color)} on ${JSON.stringify(r.bg)})`,
        ).toBeGreaterThanOrEqual(4.5);
      } else {
        Object.assign(
          lightPins,
          Object.fromEntries(rows.map((x) => [x.name, x.color])),
        );
      }
    }
    await page.screenshot({ path: `${SHOTS}/banner-${scheme}.png` });
  }

  await page.emulateMedia({ colorScheme: "light" });
  await pickScenario(page, "Model error");
  await openDm(page, /builder/i);
  const alert = page.locator("[data-session-alert]");
  await expect(alert).toBeVisible({ timeout: 15_000 });
  const alertChecks = [
    { name: "alert text", sel: "[data-session-alert] > span" },
    { name: "alert icon", sel: "[data-session-alert] svg" },
  ];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    if (scheme === "dark") {
      await expect(html).toHaveClass(/dark/);
    } else {
      await expect(html).not.toHaveClass(/dark/);
    }
    await expect(alert).toBeVisible();
    await alert.scrollIntoViewIfNeeded();
    const rows = await measure(page, alertChecks);
    console.log(`#374 alert ${scheme}`, fmt(rows));
    for (const r of rows) {
      if (scheme === "dark") {
        expect(
          r.ratio,
          `${r.name} dark contrast ${r.ratio.toFixed(2)}:1 (ink ${JSON.stringify(r.color)} on ${JSON.stringify(r.bg)})`,
        ).toBeGreaterThanOrEqual(4.5);
      } else {
        Object.assign(
          lightPins,
          Object.fromEntries(rows.map((x) => [x.name, x.color])),
        );
      }
    }
    await page.screenshot({ path: `${SHOTS}/alert-${scheme}.png` });
  }

  /* Site 3 — the not-connected notice's failed variant (same chip family the
     dropped `dark:text-red-200` used to paint): Marketer's profile is "failed"
     in the default scenario, so her DM home carries it. */
  await page.emulateMedia({ colorScheme: "light" });
  await pickScenario(page, "Normal demo");
  await openDm(page, /marketer/i);
  const notice = page.locator("[data-not-connected]");
  await expect(notice).toBeVisible({ timeout: 15_000 });
  const noticeChecks = [
    { name: "notice text", sel: "[data-not-connected] span" },
    { name: "notice icon", sel: "[data-not-connected] svg" },
  ];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    if (scheme === "dark") {
      await expect(html).toHaveClass(/dark/);
    } else {
      await expect(html).not.toHaveClass(/dark/);
    }
    await expect(notice).toBeVisible();
    await notice.scrollIntoViewIfNeeded();
    const rows = await measure(page, noticeChecks);
    console.log(`#374 notice ${scheme}`, fmt(rows));
    for (const r of rows) {
      if (scheme === "dark") {
        expect(
          r.ratio,
          `${r.name} dark contrast ${r.ratio.toFixed(2)}:1 (ink ${JSON.stringify(r.color)} on ${JSON.stringify(r.bg)})`,
        ).toBeGreaterThanOrEqual(4.5);
      } else {
        Object.assign(
          lightPins,
          Object.fromEntries(rows.map((x) => [x.name, x.color])),
        );
      }
    }
    await page.screenshot({ path: `${SHOTS}/notice-${scheme}.png` });
  }

  // Light palette pins — red-900 / red-800 must be exactly what they were.
  expectInk(lightPins, "banner text", [130, 24, 26]); // red-900
  expectInk(lightPins, "banner action", [130, 24, 26]); // red-900
  expectInk(lightPins, "banner icon", [130, 24, 26]); // red-900
  expectInk(lightPins, "alert text", [130, 24, 26]); // red-900
  expectInk(lightPins, "alert icon", [130, 24, 26]); // red-900
  expectInk(lightPins, "notice text", [130, 24, 26]); // red-900
  expectInk(lightPins, "notice icon", [130, 24, 26]); // red-900
});

test("boot error text holds WCAG AA in dark and keeps its palette in light (#374)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  /* apps/web BootScreen (app.tsx) only renders when the relay can't be
     reached at boot: run vite alone with a dead relay WS. Ports reuse literals
     already in the suite — every distinct wport base must keep a unique
     residue mod 100 (ports.spec.ts), and all 100 residues are taken. */
  const webPort = wport(5241);
  const deadRelay = wport(4643); // nothing binds it in this spec → refused
  const proc = spawn(
    "bun",
    [
      "run",
      "--cwd",
      webDir,
      "dev:vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      env: {
        ...process.env,
        LILOS_RELAY_WS: `ws://127.0.0.1:${deadRelay}/ws`,
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  const webUrl = `http://127.0.0.1:${webPort}`;
  try {
    await waitForHttp(webUrl);
    await page.setViewportSize({ width: 1288, height: 700 });
    const checks = [
      { name: "boot title", sel: ".text-red-900" },
      { name: "boot body", sel: ".text-red-800" },
    ];
    const lightPins: Record<string, RGBA> = {};
    const html = page.locator("html");
    /* The BootScreen renders before AppShell mounts useTheme — `.dark` comes
       only from index.html's inline script, which reads matchMedia once at
       load. So the colour scheme must be emulated BEFORE each navigation. */
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(webUrl);
      await expect(page.getByText("LilOS could not start")).toBeVisible({
        timeout: 30_000,
      });
      await killMotion(page);
      if (scheme === "dark") {
        await expect(html).toHaveClass(/dark/);
      } else {
        await expect(html).not.toHaveClass(/dark/);
      }
      const rows = await measure(page, checks);
      console.log(`#374 boot ${scheme}`, fmt(rows));
      for (const r of rows) {
        if (scheme === "dark") {
          expect(
            r.ratio,
            `${r.name} dark contrast ${r.ratio.toFixed(2)}:1 (ink ${JSON.stringify(r.color)} on ${JSON.stringify(r.bg)})`,
          ).toBeGreaterThanOrEqual(4.5);
        } else {
          Object.assign(
            lightPins,
            Object.fromEntries(rows.map((x) => [x.name, x.color])),
          );
        }
      }
      await page.screenshot({ path: `${SHOTS}/boot-${scheme}.png` });
    }
    expectInk(lightPins, "boot title", [130, 24, 26]); // red-900
    expectInk(lightPins, "boot body", [159, 7, 18]); // red-800
  } finally {
    await killProc(proc);
  }
});
