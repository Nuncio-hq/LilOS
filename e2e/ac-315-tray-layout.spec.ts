import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, killProc } from "./helpers/stack";
import { wport } from "./ports";

/**
 * #315 tray geometry: the waiting tray must reserve its own height — it can
 * never paint over the message list. Coordinator fix on PR #358: with an
 * approval pending AND a waiting mid-turn send, the tray sliced through the
 * approval card's body and hid the Approve/Deny row. This spec parks a turn
 * on an approval, parks a send in the tray, then measures the real boxes at
 * 1288x700, 900 and 1440 — the approval card's bottom edge must land at or
 * above the tray's top edge, and the card must stay answerable.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");

async function dmDefault(page: Page, webUrl: string) {
  await page.goto(`${webUrl}/`);
  const aside = page.locator("aside");
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

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]').first();
const tray = (page: Page) => page.locator("[data-queued]").first();

/* The invariant must hold at every sampled instant — not just after the
   layout settles: a boundingBox read anywhere has to see the card fully
   above the tray. */
async function cardAboveTray(page: Page, width: number) {
  const cardBox = await openCard(page).boundingBox();
  const trayBox = await tray(page).boundingBox();
  if (!cardBox || !trayBox) {
    throw new Error(
      `missing boxes at ${width}: card=${!!cardBox} tray=${!!trayBox}`,
    );
  }
  const cardBottom = cardBox.y + cardBox.height;
  // 1px subpixel slack; the regression was a ~90px overlap.
  expect(
    cardBottom,
    `at ${width}px wide the approval card bottom (${cardBottom}) must end at or above the tray top (${trayBox.y})`,
  ).toBeLessThanOrEqual(trayBox.y + 1);
}

test("tray reserves its height: the approval card stays answerable with a waiting send (1288 / 900 / 1440)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("traygeo", {
    relay: wport(4643),
    feed: wport(4647),
    web: wport(5241),
  });
  try {
    await page.setViewportSize({ width: 1288, height: 700 });
    await dmDefault(page, stack.webUrl);
    // Edit-ask prompt: the turn parks on the approval card and stays live.
    await send(page, "Add a release note to the readme");
    await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 30_000 });
    await expect(openCard(page)).toBeVisible({ timeout: 30_000 });
    // A mid-turn send waits in the tray — the state that must not cover the card.
    await send(page, "first waiting nudge");
    await expect(tray(page)).toBeVisible();
    await cardAboveTray(page, 1288);

    await page.setViewportSize({ width: 1440, height: 700 });
    await cardAboveTray(page, 1440);

    await page.setViewportSize({ width: 900, height: 700 });
    await cardAboveTray(page, 900);

    // …and the card stays clickable at the tightest width — "Allow once"
    // resolves the ask (the 900px shot hid the button row entirely).
    await openCard(page)
      .getByRole("button", { name: /Allow once/i })
      .click();
    const askId = await openCard(page).getAttribute("data-ask-id");
    if (askId) {
      await expect
        .poll(
          () =>
            page
              .locator(`[data-ask-id="${askId}"]`)
              .evaluateAll((els) =>
                els.some((el) => el.getAttribute("data-ask-state") === "open"),
              ),
          { timeout: 15_000 },
        )
        .toBe(false);
    }
  } finally {
    await stack.stop();
  }
});

/* #371: the tray's amber text was unreadable in dark mode — text-amber-950 and
   text-amber-800 were never remapped under .dark, so the queued item painted
   ~1.4:1 and the subtitle ~2.5:1. This spec measures the real computed colors
   in a browser: the queued text, subtitle, index, header and both action icons
   must hold WCAG AA 4.5:1 against the effective tray background in dark, and
   light mode must keep exactly its original palette. */
const SHOTS = path.join(repo, "test-results", "ac-371");

type RGBA = { r: number; g: number; b: number; a: number };

interface ContrastRow {
  name: string;
  color: RGBA;
  bg: RGBA;
  ratio: number;
}

/* Read every check's computed color and the background the eye actually sees
   under it: ancestors paint translucent fills, so walk up the tree compositing
   each element's background-color over the next until the stack is opaque. */
const measureTray = (page: Page): Promise<ContrastRow[]> =>
  page.evaluate(() => {
    /* getComputedStyle hands back whatever syntax the sheet declared — oklch,
       color-mix, rgb — so colours are sampled through a canvas: fillStyle
       normalises any CSS colour, and one painted pixel yields rgba + alpha. */
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context for colour sampling");
    const parse = (s: string): RGBA | null => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#f0f"; // sentinel: an unparseable colour keeps it
      ctx.fillStyle = s;
      if (ctx.fillStyle === "#ff00ff") return null;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top.a + under.a * (1 - top.a);
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (top.r * top.a + under.r * under.a * (1 - top.a)) / a,
        g: (top.g * top.a + under.g * under.a * (1 - top.a)) / a,
        b: (top.b * top.a + under.b * under.a * (1 - top.a)) / a,
        a,
      };
    };
    const effectiveBg = (el: Element): RGBA => {
      let acc: RGBA = { r: 0, g: 0, b: 0, a: 0 };
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) acc = over(acc, c); // nearest layer stays on top
        if (acc.a >= 0.999) return { ...acc, a: 1 };
      }
      return over(acc, { r: 255, g: 255, b: 255, a: 1 }); // canvas fallback
    };
    const lum = (c: RGBA) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const checks: { name: string; sel: string }[] = [
      { name: "header", sel: "[data-queued] .text-amber-900" },
      { name: "subtitle", sel: "[data-queued-when]" },
      { name: "index", sel: "[data-queued] li .font-mono" },
      { name: "queued text", sel: "[data-queued] li .truncate" },
      { name: "edit icon", sel: "[data-queued-edit]" },
      { name: "remove icon", sel: "[data-queued-remove]" },
    ];
    return checks.map(({ name, sel }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`tray check missing: ${name} (${sel})`);
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
  });

/* The tray's Edit/Remove icons render only while an item is still removable —
   with steer on, engine-fake accepts the mid-turn send almost at once and the
   icons hide (`removable: false`). A steer-less engine keeps every queued item
   a plain removable string, so the icons stay up long enough to measure and
   shoot. serve.ts is a ws endpoint, so the harness gets LILOS_ENGINE=url. */
async function bootSteerlessEngine(port: number): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const proc = spawn(
    "bun",
    [
      "packages/engine-fake/scripts/serve.ts",
      "--port",
      String(port),
      "--no-steer",
      "--tag",
      "e2e-371",
    ],
    { cwd: repo, stdio: ["ignore", "pipe", "inherit"] },
  );
  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error("steer-less engine never printed LISTENING")),
      30_000,
    );
    proc.stdout?.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/LISTENING (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  return { url, stop: () => killProc(proc) };
}

test("tray text holds WCAG AA in dark and keeps its palette in light (#371)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  /* Ports: reuse literals already in the suite — every distinct wport
     base must keep a unique residue mod 100 (ports.spec.ts), and all
     100 residues are taken, so new literals are not an option. */
  const engine = await bootSteerlessEngine(wport(4653));
  const stack = await bootStack(
    "traycontrast",
    {
      relay: wport(4643),
      feed: wport(4647),
      web: wport(5241),
    },
    { LILOS_ENGINE: "url", LILOS_ENGINE_URL: engine.url },
  );
  try {
    await page.setViewportSize({ width: 1288, height: 700 });
    await page.emulateMedia({ colorScheme: "light" });
    await dmDefault(page, stack.webUrl);
    // Theme toggles run color transitions (~150ms): computed colors read
    // mid-flight come back as oklab interpolations, not the final value.
    await page.addStyleTag({
      content:
        "*,*::before,*::after{transition:none!important;animation:none!important}",
    });
    await send(page, "Add a release note to the readme");
    await expect(openCard(page)).toBeVisible({ timeout: 30_000 });
    await send(page, "first waiting nudge");
    await expect(tray(page)).toBeVisible();

    const html = page.locator("html");
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      if (scheme === "dark") {
        await expect(html).toHaveClass(/dark/);
      } else {
        await expect(html).not.toHaveClass(/dark/);
      }
      for (const width of [1288, 900, 1440]) {
        await page.setViewportSize({ width, height: 700 });
        await expect(tray(page)).toBeVisible();
        const rows = await measureTray(page);
        console.log(
          `#371 ${scheme}@${width}`,
          rows
            .map(
              (r) =>
                `${r.name}=${r.ratio.toFixed(2)}:1(${Math.round(r.color.r)},${Math.round(r.color.g)},${Math.round(r.color.b)} on ${Math.round(r.bg.r)},${Math.round(r.bg.g)},${Math.round(r.bg.b)})`,
            )
            .join(" "),
        );
        for (const r of rows) {
          if (scheme === "dark") {
            expect(
              r.ratio,
              `${r.name} dark contrast ${r.ratio.toFixed(2)}:1 (ink ${JSON.stringify(r.color)} on ${JSON.stringify(r.bg)})`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
        await page.screenshot({
          path: `${SHOTS}/tray-${scheme}-${width}.png`,
        });
      }
    }
    // Light mode must not change: the classes still resolve to their light
    // palette values (the fix only adds .dark rules and a dark: variant).
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html).not.toHaveClass(/dark/);
    const light = Object.fromEntries(
      (await measureTray(page)).map((r) => [r.name, r.color]),
    );
    const expectInk = (name: string, rgb: [number, number, number]) => {
      const c = light[name] as RGBA;
      expect(
        `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`,
        `${name} must keep its light-mode color`,
      ).toBe(`${rgb[0]},${rgb[1]},${rgb[2]}`);
    };
    expectInk("header", [123, 51, 6]); // amber-900
    expectInk("subtitle", [151, 60, 0]); // amber-800
    expectInk("index", [187, 77, 0]); // amber-700
    expectInk("queued text", [70, 25, 1]); // amber-950
    expectInk("edit icon", [134, 134, 139]); // muted-foreground
    expectInk("remove icon", [134, 134, 139]); // muted-foreground
  } finally {
    await stack.stop();
    await engine.stop();
  }
});
