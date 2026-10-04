import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #508 — the running Focus composer's capsule read light-gray in dark
 * shots (#423's ac1/ac2 screenshots): the capsule's `transition-colors` fades
 * `background-color` across the theme flip, so anything captured in the
 * ~150ms window sees the near-opaque light glass over the dark field and the
 * "Medium" chip label, "Enter steers · ■ stop" hint and placeholder sit on it
 * at ~1.3:1. The fix: the capsule's fill snaps to the theme token instead of
 * fading (theme.css — transition-property minus background-color).
 *
 *   AC-2 the placeholder, the hint and the chip label hold WCAG AA 4.5:1 on
 *      the capsule in dark mode, measured like ac-374 (canvas-normalised
 *      computed colours, ink composited over the effective background);
 *      light mode is pinned to its exact palette. The capsule fill itself is
 *      asserted right as `.dark` lands — a fill that fades in arrives light.
 *   AC-3 screenshots of the running composer at 1288x700, 1288x900 and
 *      1440x900, light and dark — they land in test-results/ac-508/ for the
 *      CI artifact upload.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-508");

/* The running composer is the only capsule carrying a Stop (Esc) button —
   that scopes every selector to the mid-turn surface, not a sibling one. */
const CAPSULE = '[data-slot="input-group"]:has([aria-label="Stop (Esc)"])';

const CHECKS = [
  { name: "placeholder", sel: `${CAPSULE} textarea`, pseudo: "::placeholder" },
  { name: "hint", sel: `${CAPSULE} .lilos-hint` },
  {
    name: "chip name",
    sel: `${CAPSULE} [data-slot="model-picker-trigger"] span`,
  },
  {
    name: "chip effort",
    sel: `${CAPSULE} [data-slot="model-picker-trigger"] .text-foreground\\/70`,
  },
];

type RGBA = { r: number; g: number; b: number; a: number };
interface ContrastRow {
  name: string;
  color: RGBA;
  bg: RGBA;
  ratio: number;
}

/* ac-374's machinery: computed colours are sampled through a canvas (oklch /
   color-mix normalise to rgba), the effective background is each ancestor's
   translucent fill composited up to opaque, and the ink composites over it. */
const measure = (
  page: Page,
  checks: { name: string; sel: string; pseudo?: string }[],
): Promise<ContrastRow[]> =>
  page.evaluate((checks) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context for colour sampling");
    const parse = (s: string) => {
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
    return checks.map(({ name, sel, pseudo }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`contrast check missing: ${name} (${sel})`);
      const bg = effectiveBg(el);
      const ink = over(
        parse(getComputedStyle(el, pseudo).color) ?? {
          r: 0,
          g: 0,
          b: 0,
          a: 1,
        },
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

/* ac-374: theme toggles run colour transitions (~150ms) — computed text
   colours read mid-flight come back as oklab interpolations, not finals. */
const killMotion = (page: Page) =>
  page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important}",
  });

let stack: Stack;
test.setTimeout(180_000);
test.beforeAll(async () => {
  stack = await bootStack("ac508", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Boot onto Default's DM home, dismissing the first-run card. */
async function dmDefault(page: Page) {
  await page.goto(`${stack.webUrl}/?statusPollMs=500`);
  const aside = page.locator("aside").first();
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
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
}

/** Send and land on the Focus view mid-turn. `LILOS_TURN_HOLD` (#400) parks
    the fake engine's turn as running until an interrupt — the composer never
    drops the Stop button between the measurements and the six shots. */
async function runningFocus(page: Page) {
  const box = page.locator("textarea").last();
  await box.fill("LILOS_TURN_HOLD keep this turn running");
  await box.press("Enter");
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop (Esc)" })).toBeVisible({
    timeout: 30_000,
  });
  /* The issue's exact state: the steer placeholder and the running hint. */
  await expect(page.locator(`${CAPSULE} textarea`)).toHaveAttribute(
    "placeholder",
    /Enter steers this turn/,
  );
  await expect(page.locator(`${CAPSULE} .lilos-hint`)).toHaveText(
    "Enter steers · ■ stop",
  );
  /* The chip is one of the measured surfaces — wait for the catalog, don't
     measure while it's still loading. */
  await expect(
    page.locator(`${CAPSULE} [data-slot="model-picker-trigger"]`),
  ).toBeVisible({ timeout: 30_000 });
}

const capsule = (page: Page) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error("running composer capsule not found");
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, transition: cs.transitionProperty };
  }, CAPSULE);

test("AC-2 placeholder, hint and chip label hold 4.5:1 in dark; light stays byte-exact", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 900 });
  await dmDefault(page);
  await runningFocus(page);
  const html = page.locator("html");

  /* Dark first: the fill is read the moment `.dark` lands — before the fix
     this was mid-fade toward the token (the light capsule in the issue's
     screenshots). The transition list itself must not carry the fill. */
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveClass(/dark/);
  const cap = await capsule(page);
  expect(cap.transition).not.toMatch(/\b(background|background-color|all)\b/);
  expect(cap.bg).toBe("rgba(255, 255, 255, 0.06)");
  await killMotion(page);
  const dark = await measure(page, CHECKS);
  console.log("#508 composer dark", fmt(dark));
  for (const r of dark) {
    expect(
      r.ratio,
      `${r.name} dark contrast ${r.ratio.toFixed(2)}:1 (ink ${JSON.stringify(r.color)} on ${JSON.stringify(r.bg)})`,
    ).toBeGreaterThanOrEqual(4.5);
  }

  /* Light is pinned byte-exact: the fix only removed a fade, so the palette
     must be exactly what it always was. */
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).not.toHaveClass(/dark/);
  const capLight = await capsule(page);
  expect(capLight.bg).toBe("rgba(255, 255, 255, 0.75)");
  const light = await measure(page, CHECKS);
  console.log("#508 composer light", fmt(light));
  const pin = (name: string, rgb: [number, number, number]) => {
    const c = light.find((r) => r.name === name)?.color;
    expect(
      c ? `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}` : "",
      `${name} must keep its light-mode color`,
    ).toBe(`${rgb[0]},${rgb[1]},${rgb[2]}`);
  };
  pin("placeholder", [134, 134, 139]);
  pin("hint", [134, 134, 139]);
  pin("chip name", [74, 74, 76]);
  pin("chip effort", [95, 95, 98]);
});

test("AC-3 screenshots of the running composer at the three viewports, light and dark", async ({
  page,
}) => {
  await dmDefault(page);
  await runningFocus(page);
  await killMotion(page); // stills read the final palette, not a mid-flip frame
  const html = page.locator("html");
  for (const [width, height] of [
    [1288, 700],
    [1288, 900],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      if (scheme === "dark") {
        await expect(html).toHaveClass(/dark/);
      } else {
        await expect(html).not.toHaveClass(/dark/);
      }
      await page.screenshot({
        path: `${SHOTS}/running-composer-${width}x${height}-${scheme}.png`,
      });
    }
  }
});
