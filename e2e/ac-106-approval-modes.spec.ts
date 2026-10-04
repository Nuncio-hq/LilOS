import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, type Stack } from "./helpers/stack";
import { wport } from "./ports";

/**
 * Issue #106 — approval modes per conversation, real app (apps/web over
 * relay + harness on engine-fake). AC-1 the composer pill switches Ask ↔
 * Full access from the agent's next action (mid-turn included); AC-2 Full
 * access is enforced by the harness (no card ever reaches the user, the
 * turn logs "Auto-approved"); AC-3 new conversations start on Settings'
 * default and never remember the last-used level; AC-4 cards offer
 * Once / This session / Always / Deny; AC-9 the Settings Approvals copy
 * says what the level gates.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");

const SHOTS = path.join(repo, "test-results", "ac-106");
const pill = (page: Page) => page.locator('[data-slot="access-pill"]');
const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]');
const settled = (page: Page) => page.locator("[data-turnsettled]").last();

/** Land on the DM home composer of the seeded employee. */
async function dmHome(stack: Stack, page: Page) {
  await page.goto(`${stack.webUrl}/`);
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

const settingsDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Settings" });

test.describe.configure({ mode: "serial" });
test.use({ video: "on" });

test("AC-1+AC-2+AC-4+AC-3 the pill drives the mode; cards offer the four options; defaults don't leak", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const stack = await bootStack("ac106", {
    relay: wport(4690),
    feed: wport(4691),
    web: wport(4692),
  });
  try {
    /* ── New conversation starts on Ask (the factory default) ── */
    await dmHome(stack, page);
    await expect(pill(page)).toBeVisible();
    await expect(pill(page)).toHaveAttribute("data-access", "ask");
    await expect(pill(page)).toContainText("Ask");

    /* ── One click → Full access: orange shield + label, no dialog ── */
    await pill(page).click();
    await expect(pill(page)).toHaveAttribute("data-access", "full");
    await expect(pill(page)).toContainText("Full access");
    await expect(pill(page)).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: `${SHOTS}/ac-1-pill-full.png` });

    /* ── Full access: the gated turn completes with no card at all ── */
    await send(page, "Add a footer to the page");
    await expect(settled(page)).toBeVisible({ timeout: 90_000 });
    await expect(openCard(page)).toHaveCount(0);
    await expect(page.getByText(/Auto-approved/).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-2-auto-approved.png` });

    /* ── The thread's own pill persisted Full access; switch back to Ask ── */
    await expect(pill(page)).toHaveAttribute("data-access", "full");
    await pill(page).click();
    await expect(pill(page)).toHaveAttribute("data-access", "ask");

    /* ── Ask: the card offers Once / This session / Always / Deny ── */
    await send(page, "Change the header color");
    const card = openCard(page).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    for (const name of ["Once", "This session", "Always", "Deny"]) {
      await expect(
        card.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    await page.screenshot({ path: `${SHOTS}/ac-4-four-options.png` });

    /* ── AC-1 mid-turn: flip to Full while the card is open — the NEXT
       approval never becomes a card. */
    await pill(page).click();
    await expect(pill(page)).toHaveAttribute("data-access", "full");
    await card.getByRole("button", { name: "Once", exact: true }).click();
    await expect(settled(page)).toBeVisible({ timeout: 90_000 });
    // Only that one card ever opened for this turn's other gated steps.
    await expect(openCard(page)).toHaveCount(0);
    await expect(page.getByText(/Auto-approved/).first()).toBeVisible();

    /* ── AC-3: a fresh conversation doesn't inherit the last-used level ── */
    await dmHome(stack, page);
    await expect(pill(page)).toHaveAttribute("data-access", "ask");
    await expect(pill(page)).toContainText("Ask");
  } finally {
    await stack.stop();
  }
});

test("AC-3+AC-9 Settings Approvals: policy pick, honest copy, and the default seeds new conversations", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("ac106s", {
    relay: wport(4693),
    feed: wport(4694),
    web: wport(4695),
  });
  try {
    await dmHome(stack, page);
    await page
      .locator("aside")
      .getByRole("button", { name: "Settings" })
      .click();
    await expect(settingsDialog(page)).toBeVisible();
    await settingsDialog(page)
      .getByRole("tab", { name: "Approvals", exact: true })
      .click();

    /* The engine declares approval_policy → the policy pick renders. */
    const policy = settingsDialog(page).getByRole("radiogroup", {
      name: "Engine approval policy",
    });
    await expect(policy).toBeVisible();
    for (const name of ["Smart", "Manual", "Off"])
      await expect(
        policy.getByRole("radio", { name, exact: true }),
      ).toBeVisible();

    /* AC-9: the access default names what it gates — no sandbox promise. */
    await expect(
      settingsDialog(page).getByText(/asks before risky commands/),
    ).toBeVisible();
    await expect(
      settingsDialog(page).getByText(/never stops to ask/),
    ).toBeVisible();
    await expect(
      settingsDialog(page).getByText(/outside its folder|works anywhere/i),
    ).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ac-9-settings.png` });

    /* Default → Full access seeds the NEXT new conversation only. */
    await settingsDialog(page)
      .getByRole("radiogroup", { name: "Default access for new conversations" })
      .getByRole("radio", { name: "Full access", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await dmHome(stack, page);
    await expect(pill(page)).toHaveAttribute("data-access", "full");

    /* …and switching the engine policy lands on the engine (fake records it). */
    await page
      .locator("aside")
      .getByRole("button", { name: "Settings" })
      .click();
    await settingsDialog(page)
      .getByRole("tab", { name: "Approvals", exact: true })
      .click();
    await settingsDialog(page)
      .getByRole("radiogroup", { name: "Engine approval policy" })
      .getByRole("radio", { name: "Manual", exact: true })
      .click();
    await expect(
      settingsDialog(page)
        .getByRole("radiogroup", { name: "Engine approval policy" })
        .getByRole("radio", { name: "Manual", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
  } finally {
    await stack.stop();
  }
});

test("AC-1 the Full access pill actually paints orange, light and dark (#106)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  /* The pill's full state must read ORANGE (Codex-style warning), not the
     neutral gray of the paperclip/model picker beside it. Read the real
     computed colors in the prototype app — a bare text-orange-600 probe div
     in the same sheet tells us whether the utility exists at all. */
  await page.setViewportSize({ width: 1288, height: 700 });
  const html = page.locator("html");
  const hueOf = (r: number, g: number, b: number) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    const h =
      max === r
        ? (g - b) / d + (g < b ? 6 : 0)
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    return { h: h * 60, s: d / max };
  };
  const ink = () =>
    page.evaluate(() => {
      const ctx = document
        .createElement("canvas")
        .getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d context");
      const parse = (s: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#f0f";
        ctx.fillStyle = s;
        if (ctx.fillStyle === "#ff00ff") return null;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return { r: d[0], g: d[1], b: d[2] };
      };
      const pill = document.querySelector('[data-slot="access-pill"]');
      if (!pill) throw new Error("access pill missing");
      const svg = pill.querySelector("svg");
      const label = pill.querySelector("span");
      /* Probe: does .text-orange-600 exist in the compiled sheet at all? */
      const probe = document.createElement("div");
      probe.className = "text-orange-600";
      pill.appendChild(probe);
      const out = {
        pillClass: pill.getAttribute("class") ?? "",
        pill: parse(getComputedStyle(pill).color),
        svg: svg ? parse(getComputedStyle(svg).color) : null,
        svgFill: svg ? parse(getComputedStyle(svg).fill) : null,
        label: label ? parse(getComputedStyle(label).color) : null,
        probe: parse(getComputedStyle(probe).color),
      };
      probe.remove();
      return out;
    });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expect(page.locator("aside").first()).toContainText("Employees", {
      timeout: 30_000,
    });
    await page.addStyleTag({
      content:
        "*,*::before,*::after{transition:none!important;animation:none!important}",
    });
    if (scheme === "dark") {
      await expect(html).toHaveClass(/dark/);
    } else {
      await expect(html).not.toHaveClass(/dark/);
    }
    const p = pill(page);
    await expect(p).toBeVisible();
    await p.click();
    await expect(p).toHaveAttribute("data-access", "full");
    const c = await ink();
    console.log(`#106 pill ${scheme} hovered`, JSON.stringify(c));
    /* The cursor rests on the pill after the click, so the first read is the
       hovered state; move away for the unhovered read — orange must hold in
       both (the bug was hover:text-foreground muting it). */
    await page.mouse.move(20, 20);
    const c2 = await ink();
    console.log(`#106 pill ${scheme} unhovered`, JSON.stringify(c2));
    const merged = {
      ...c,
      ...Object.fromEntries(
        Object.entries(c2).map(([k, v]) => [`${k}Unhovered`, v]),
      ),
    };
    for (const [what, px] of [
      ["pillUnhovered", merged.pillUnhovered],
      ["svgUnhovered", merged.svgUnhovered],
      ["labelUnhovered", merged.labelUnhovered],
      ["pill", c.pill],
      ["svg", c.svg],
      ["label", c.label],
      ["probe", c.probe],
    ] as const) {
      if (!px) continue;
      const { h, s } = hueOf(px.r, px.g, px.b);
      expect(
        { h, s, px },
        `${what} must be orange (hue 20–50°), not gray — ${scheme} computed rgb(${px.r},${px.g},${px.b})`,
      ).toEqual(
        expect.objectContaining({
          h: expect.any(Number),
          s: expect.any(Number),
        }),
      );
      expect(
        s,
        `${what} is gray in ${scheme} (rgb ${px.r},${px.g},${px.b}) — orange ink never applied`,
      ).toBeGreaterThan(0.25);
      expect(
        h,
        `${what} hue ${h.toFixed(0)}° in ${scheme} is not orange`,
      ).toBeGreaterThanOrEqual(15);
      expect(
        h,
        `${what} hue ${h.toFixed(0)}° in ${scheme} is not orange`,
      ).toBeLessThanOrEqual(55);
    }
    await page.screenshot({ path: `${SHOTS}/pill-orange-${scheme}.png` });
  }
});
