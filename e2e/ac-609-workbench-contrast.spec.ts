import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { expectSettled } from "./helpers/approvals";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #609 — dark-mode Workbench ink read dark-on-dark:
 *   AC-1 every [role=tab] label meets WCAG AA >= 4.5:1 in dark — including
 *      the active tab, which must be the brightest ink on the strip and the
 *      only one carrying the underline.
 *   AC-2 file-view content text and the path-row labels meet AA in dark.
 *   AC-3 this spec: real-browser getComputedStyle contrast measurement.
 *      Root cause (measured on main): `transition-all`/`transition-colors`
 *      animate `color` across the theme flip, so for ~150ms after `.dark`
 *      lands the labels still paint the LIGHT theme's ink on the already
 *      dark panel — that mid-fade frame is what the issue's screenshots
 *      caught. The fix (`lilos-theme-freeze` in useTheme) snaps every
 *      colour at flip; the flip-time rows below read exactly that frame.
 *   AC-4 shot matrix: 1288x700 + 1440x900 x light/dark x folder/folderless.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-609");

/* A real git folder for the folder legs — the Files tab + file view need
   fs/git answers (mirrors ac-543's seed). */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-609-"));
const repoDir = path.join(ROOT, "lilos-repo");
mkdirSync(repoDir, { recursive: true });
writeFileSync(path.join(repoDir, "a.txt"), "one\ntwo\nthree\n");
execFileSync("git", ["init", "-b", "trunk"], { cwd: repoDir });
execFileSync("git", ["add", "."], { cwd: repoDir });
execFileSync(
  "git",
  ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
  { cwd: repoDir },
);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac609", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

const FOCUS_URL = /\/dm\/[^/]+\/[^/]+\/focus/;

async function openDefault(page: Page, s: Stack = stack) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${s.webUrl}/?roots=${ROOT}`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /Default/ })).toBeVisible({
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
    await aside.getByRole("button", { name: /Default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
}

const pickerButton = (page: Page) => page.locator('[data-ws="folder"]');

async function pickNoFolder(page: Page) {
  await pickerButton(page).click();
  await page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last()
    .getByText("No folder · just chat")
    .click();
}

async function pickSessionFolder(page: Page, dir: string) {
  await pickerButton(page).click();
  const menu = page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
  const recent = menu.locator(`[data-wsfolder="${dir}"]`);
  const recentVisible = await expect(recent.first())
    .toBeVisible({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (recentVisible) {
    await recent.first().click();
  } else {
    await menu.getByText("Add a folder").click();
    const dialog = page.locator("[data-addfolder]");
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-pathinput]").fill(dir);
    await expect(dialog.locator("[data-folderinfo]")).toBeVisible({
      timeout: 15_000,
    });
    await dialog.locator("[data-addbtn]").click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(pickerButton(page)).toContainText(path.basename(dir), {
    timeout: 15_000,
  });
}

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const turns = (page: Page) => page.locator("[data-agentturn]");
const turnSettled = (page: Page) => expectSettled(turns(page).last(), 90_000);

const workbenchToggle = (page: Page) =>
  page.getByTitle("Workbench", { exact: true });
const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });

const openWorkbench = async (page: Page, firstTab: RegExp | string) => {
  await expect(workbenchToggle(page)).toBeVisible({ timeout: 30_000 });
  if (
    !(await tab(page, firstTab)
      .isVisible()
      .catch(() => false))
  ) {
    await workbenchToggle(page).click();
  }
  await expect(tab(page, firstTab)).toBeVisible({ timeout: 15_000 });
};

/* A check is a single selector (`sel`) or `all:` for every match — the
   tab strip enumerates itself this way. */
type Check = { name: string; sel: string } | { name: string; all: string };

type Row = {
  name: string;
  color: { r: number; g: number; b: number };
  bg: { r: number; g: number; b: number };
  ratio: number;
  inkLum: number;
  selected?: boolean;
  underline?: number;
};

/* window.__measure — ac-374's contrast machinery, plus `all:` checks that
   fan a selector out to every match (the tab strip) and, for [role=tab]
   rows, aria-selected + the ::after underline's opacity. */
const installMeasure = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __measure: (checks: Check[]) => Row[];
    };
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
        if (c && c.a > 0) acc = over(acc, c);
        if (acc.a >= 0.999) return { ...acc, a: 1 };
      }
      return over(acc, { r: 255, g: 255, b: 255, a: 1 });
    };
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const one = (el: Element, name: string): Row => {
      const cs = getComputedStyle(el);
      const bg = effectiveBg(el);
      const ink = over(parse(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 }, bg);
      const l1 = Math.max(lum(ink), lum(bg));
      const l2 = Math.min(lum(ink), lum(bg));
      const isTab = el.getAttribute("role") === "tab";
      return {
        name,
        color: ink,
        bg,
        ratio: (l1 + 0.05) / (l2 + 0.05),
        inkLum: lum(ink),
        ...(isTab
          ? {
              selected: el.getAttribute("aria-selected") === "true",
              underline: parseFloat(getComputedStyle(el, "::after").opacity),
            }
          : {}),
      };
    };
    w.__measure = (checks) =>
      checks.flatMap((check) => {
        if ("all" in check) {
          const els = [...document.querySelectorAll(check.all)];
          if (els.length === 0)
            throw new Error(
              `contrast check empty: ${check.name} (${check.all})`,
            );
          return els.map((el) =>
            one(el, `${check.name} "${(el.textContent ?? "").trim()}"`),
          );
        }
        const el = document.querySelector(check.sel);
        if (!el)
          throw new Error(
            `contrast check missing: ${check.name} (${check.sel})`,
          );
        return [one(el, check.name)];
      });
  });

const measure = (page: Page, checks: Check[]) =>
  page.evaluate((c) => {
    const w = window as unknown as {
      __measure: (checks: typeof c) => Row[];
    };
    return w.__measure(c);
  }, checks);

/* Flip-time measurement: resolve with __measure(checks) inside the
   MutationObserver callback that sees `.dark` land — the same instant a
   screenshot lands on. On main the transitioning ink is still at its
   light-theme value; with the fix every colour has already snapped. */
const flipToDark = (page: Page, checks: Check[]) =>
  page.evaluate((c) => {
    const w = window as unknown as {
      __measure: (checks: typeof c) => Row[];
    };
    return new Promise<Row[]>((resolve) => {
      const mo = new MutationObserver(() => {
        if (!document.documentElement.classList.contains("dark")) return;
        mo.disconnect();
        resolve(w.__measure(c));
      });
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
    });
  }, checks);

/* Theme toggles run colour transitions on main (~150ms): settled reads must
   wait out the fade or pinned values come back mid-flight. */
const killMotion = (page: Page) =>
  page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important}",
  });

const fmt = (rows: Row[]) =>
  rows
    .map(
      (r) =>
        `${r.name}=${r.ratio.toFixed(2)}:1(${Math.round(r.color.r)},${Math.round(r.color.g)},${Math.round(r.color.b)} on ${Math.round(r.bg.r)},${Math.round(r.bg.g)},${Math.round(r.bg.b)})`,
    )
    .join(" ");

const expectAa = (rows: Row[], when: string) => {
  for (const r of rows) {
    expect(
      r.ratio,
      `${when}: ${r.name} contrast ${r.ratio.toFixed(2)}:1 (ink ${JSON.stringify(r.color)} on ${JSON.stringify(r.bg)})`,
    ).toBeGreaterThanOrEqual(4.5);
  }
};

/* AC-1: the active tab is the brightest ink on the strip and the only one
   with its underline lit. */
const expectActiveTabWins = (rows: Row[]) => {
  const tabs = rows.filter((r) => r.selected !== undefined);
  const active = tabs.filter((r) => r.selected);
  expect(active.length, "exactly one selected tab").toBe(1);
  for (const r of tabs) {
    const underline = r.underline ?? 0; // tab rows always report it
    if (r.selected) {
      expect(underline, `${r.name} must carry the underline`).toBeGreaterThan(
        0.5,
      );
    } else {
      expect(
        underline,
        `${r.name} must not carry a stale underline`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        r.inkLum,
        `${r.name} must be dimmer than the active tab`,
      ).toBeLessThan(active[0].inkLum);
    }
  }
};

/* Light keeps its palette: pins the composited ink of non-tab rows exactly
   (ac-374's convention — dark-only fix, light must not drift). */
const pinInk = (rows: Row[], name: string, rgb: [number, number, number]) => {
  const r = rows.find((x) => x.name === name);
  if (!r) throw new Error(`pin target missing: ${name}`);
  const got = [r.color.r, r.color.g, r.color.b].map(Math.round);
  expect(got, `${name} must keep its light-mode ink`).toEqual(rgb);
};

const TABS = { name: "tab", all: "aside [role='tab']" } as const;

test("AC-1/AC-3 folderless session: every Workbench tab label holds AA at the flip and settled", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await page.emulateMedia({ colorScheme: "light" });
  await openDefault(page);
  await pickNoFolder(page);
  await send(page, "slow:100 delegate the relay scan to subagents");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await turnSettled(page);
  await openWorkbench(page, "Subagents");
  await expect(tab(page, "Background")).toBeVisible();

  await installMeasure(page);
  const lightRows = await measure(page, [TABS]);
  console.log("#609 folderless light", fmt(lightRows));

  /* The flip frame: what every dark screenshot taken right at the toggle
     shows. On main this is light ink on the dark panel. */
  const flipRowsP = flipToDark(page, [TABS]);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 15_000 });
  const flipRows = await flipRowsP;
  console.log("#609 folderless dark flip", fmt(flipRows));
  expectAa(flipRows, "dark at flip");

  await killMotion(page);
  const darkRows = await measure(page, [TABS]);
  console.log("#609 folderless dark settled", fmt(darkRows));
  expectAa(darkRows, "dark settled");
  expectActiveTabWins(darkRows);

  /* Light settled labels must hold AA too — /60 read 4.44:1 (#609). */
  expectAa(lightRows, "light settled");
  await page.screenshot({ path: `${SHOTS}/ac-1-folderless-tabs-dark.png` });
});

test("AC-1/AC-2/AC-3 folder session: tab strip + file-view ink hold AA at the flip and settled", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  await page.emulateMedia({ colorScheme: "light" });
  await openDefault(page);
  await pickSessionFolder(page, repoDir);
  await send(page, "slow:100 delegate the relay scan to subagents");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await turnSettled(page);
  await openWorkbench(page, "Changes");
  await expect(tab(page, "Files")).toBeVisible();

  /* Open a.txt from the tree → the file view (`pre` content + the `← Files`
     path row). */
  await tab(page, "Files").click();
  const fileRow = page.getByRole("treeitem", { name: /a\.txt/ }).first();
  await expect(fileRow).toBeVisible({ timeout: 15_000 });
  await fileRow.click();
  const fileview = page.locator("[data-fileview]");
  await expect(fileview.locator("pre")).toBeVisible({ timeout: 15_000 });

  await installMeasure(page);
  const checks = [
    TABS,
    { name: "file-view text", sel: "[data-fileview] pre" },
    { name: "← Files label", sel: "[data-fileview] button" },
    { name: "file path", sel: "[data-fileview] .font-mono" },
  ];
  const lightRows = await measure(page, checks);
  console.log("#609 folder light", fmt(lightRows));

  const flipRowsP = flipToDark(page, checks);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 15_000 });
  const flipRows = await flipRowsP;
  console.log("#609 folder dark flip", fmt(flipRows));
  expectAa(flipRows, "dark at flip");

  await killMotion(page);
  const darkRows = await measure(page, checks);
  console.log("#609 folder dark settled", fmt(darkRows));
  expectAa(darkRows, "dark settled");
  expectActiveTabWins(darkRows);
  /* Light: the tab labels pass AA with the /70 bump. The file-view rows keep
     their palette; the path row's muted-foreground ~3.5:1 in light is the
     app-wide muted-token question — #617, out of this slice. */
  expectAa(
    lightRows.filter((r) => r.selected !== undefined),
    "light settled",
  );
  pinInk(lightRows, "file-view text", [29, 29, 31]);
  pinInk(lightRows, "← Files label", [29, 29, 31]);
  pinInk(lightRows, "file path", [134, 134, 139]);
  await page.screenshot({ path: `${SHOTS}/ac-2-fileview-dark.png` });
});

test("AC-4 shot matrix: 1288x700 + 1440x900 × light/dark × folder/folderless", async ({
  page,
}) => {
  test.setTimeout(360_000);
  mkdirSync(SHOTS, { recursive: true });

  /* Folder session: Changes / Files (file view open) / PR. */
  await page.setViewportSize({ width: 1288, height: 700 });
  await page.emulateMedia({ colorScheme: "light" });
  await openDefault(page);
  await pickSessionFolder(page, repoDir);
  await send(page, "slow:100 delegate the relay scan to subagents");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await turnSettled(page);
  await openWorkbench(page, "Changes");
  await tab(page, "Files").click();
  const fileRow = page.getByRole("treeitem", { name: /a\.txt/ }).first();
  await expect(fileRow).toBeVisible({ timeout: 15_000 });
  await fileRow.click();
  await expect(page.locator("[data-fileview] pre")).toBeVisible({
    timeout: 15_000,
  });

  for (const [w, h] of [
    [1288, 700],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await killMotion(page);
      await page.waitForTimeout(250);
      for (const [t, name] of [
        ["Changes", "changes"],
        ["Files", "files"],
        [/^PR$/, "pr"],
      ] as const) {
        await tab(page, t).click();
        await page.screenshot({
          path: `${SHOTS}/folder-${name}-${w}x${h}-${scheme}.png`,
        });
      }
    }
  }

  /* Folderless session: Subagents / Background. */
  await page.emulateMedia({ colorScheme: "light" });
  await openDefault(page);
  await pickNoFolder(page);
  await send(page, "leave the dev server running in the background");
  await expect(page).toHaveURL(FOCUS_URL, { timeout: 30_000 });
  await turnSettled(page);
  await send(page, "delegate the relay scan to subagents");
  await turnSettled(page);
  await openWorkbench(page, "Subagents");

  for (const [w, h] of [
    [1288, 700],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await killMotion(page);
      await page.waitForTimeout(250);
      for (const [t, name] of [
        ["Subagents", "subagents"],
        ["Background", "background"],
      ] as const) {
        await tab(page, t).click();
        await page.screenshot({
          path: `${SHOTS}/folderless-${name}-${w}x${h}-${scheme}.png`,
        });
      }
    }
  }
});
