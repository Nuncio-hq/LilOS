import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { setAccess } from "./helpers/approvals";
import {
  bootStack,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #106 — approval modes per conversation, real app (apps/web over
 * relay + harness on engine-fake). AC-1 the composer pill switches Ask ↔
 * Full access from the agent's next action (mid-turn included); AC-2 Full
 * access is enforced by the harness (no card ever reaches the user, the
 * turn logs "Auto-approved"); AC-3 new conversations start on Settings'
 * default and never remember the last-used level; AC-4 cards offer
 * Allow / Deny with the extra scopes under Allow's ▾; AC-9 the Settings
 * Approvals copy says what the level gates.
 *
 * v3 notes: the pill lives on the thread's composer (the new-chat draft has
 * none), so every leg starts a chat first and reads/flips the pill on its
 * thread. #884: the engine's own approval policy (Smart/Manual/Off) no
 * longer sits under the default access — one approval system, not two.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");

const SHOTS = path.join(repo, "test-results", "ac-106");
/* The seeded employee. An id that names nobody opens the new-chat draft on
   the default agent, which on this one-agent stack is Default. */
const DEFAULT_AGENT = { id: "default", name: "Default" };

/** The thread's access pill (the draft composer has none). */
const pill = (page: Page) =>
  page.locator('[data-thread-panel] [data-slot="access-pill"]');
const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]');
const settled = (page: Page) => page.locator("[data-turnsettled]").last();

/** A fresh chat with the seeded employee, landed on its thread in the side
    peek, its opening turn over. `text` must not need an approval (it only
    opens the thread). engine-fake steers a send made mid-turn into the
    running turn, so the legs' own gated prompts only run as turns of their
    own once this one has ended. */
async function newThread(stack: Stack, page: Page, text = "Say hello once") {
  await skipFirstRun(page);
  await startChat(page, stack.webUrl, DEFAULT_AGENT, text);
  await expect(pill(page)).toBeVisible({ timeout: 30_000 });
  await expect(settled(page)).toBeVisible({ timeout: 90_000 });
}

const send = async (page: Page, text: string) => {
  const box = page.locator("[data-thread-panel] textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

/** Settings → General, where the approvals default lives. */
async function openSettings(stack: Stack, page: Page) {
  await page.goto(`${stack.webUrl}/#?page=settings&view=general`);
  await expect(
    page.getByRole("radiogroup", { name: "Approvals", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });
test.use({ video: "on" });

test("AC-1+AC-2+AC-4+AC-3 the pill drives the mode; cards offer the four options; defaults don't leak", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const stack = await bootStack("ac106", await pickPorts());
  try {
    /* ── New conversation starts on Ask (the factory default) ── */
    await newThread(stack, page);
    await expect(pill(page)).toBeVisible();
    await expect(pill(page)).toHaveAttribute("data-access", "ask");
    await expect(pill(page)).toContainText("Ask");

    /* ── Full access comes from the pill's menu (#886), confirmed —
       a single click on the pill only opens it. ── */
    await pill(page).click();
    await expect(pill(page)).toHaveAttribute("data-access", "ask");
    await expect(
      page.getByRole("menu", { name: "Access", exact: true }),
    ).toBeVisible();
    await page.locator('[data-access-option="full"]').click();
    // Still Ask: picking Full confirms first, it does not apply.
    await expect(pill(page)).toHaveAttribute("data-access", "ask");
    await expect(
      page.getByText("Agents run tools without asking in this thread"),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-1-pill-confirm.png` });
    await page.locator("[data-access-confirm]").click();
    await expect(pill(page)).toHaveAttribute("data-access", "full");
    await expect(pill(page)).toContainText("Full access");
    await expect(pill(page)).toHaveAttribute("aria-haspopup", "menu");
    await page.screenshot({ path: `${SHOTS}/ac-1-pill-full.png` });

    /* ── Full access: the gated turn completes with no card at all ── */
    await send(page, "Add a footer to the page");
    await expect(settled(page)).toBeVisible({ timeout: 90_000 });
    await expect(openCard(page)).toHaveCount(0);
    await expect(page.getByText(/Auto-approved/).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ac-2-auto-approved.png` });

    /* ── The thread's own pill persisted Full access; switch back to Ask ── */
    await expect(pill(page)).toHaveAttribute("data-access", "full");
    await setAccess(page, "ask");

    /* ── Ask: the card offers Allow / Deny; the other grant scopes live
       under Allow's ▾ (#884) ── */
    await send(page, "Change the header color");
    const card = openCard(page).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    for (const name of ["Allow", "Deny"]) {
      await expect(
        card.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    await card
      .getByRole("button", { name: "More ways to allow", exact: true })
      .click();
    for (const name of ["This thread", "Always"]) {
      await expect(
        card.getByRole("menuitem", { name, exact: true }),
      ).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `${SHOTS}/ac-4-four-options.png` });

    /* ── AC-1 mid-turn: flip to Full while the card is open — the NEXT
       approval never becomes a card. (The menu pick applies straight
       away; Full confirms first.) */
    await setAccess(page, "full");
    await card.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(settled(page)).toBeVisible({ timeout: 90_000 });
    // Only that one card ever opened for this turn's other gated steps.
    await expect(openCard(page)).toHaveCount(0);
    await expect(page.getByText(/Auto-approved/).first()).toBeVisible();

    /* ── AC-3: a fresh conversation doesn't inherit the last-used level ── */
    await newThread(stack, page);
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
  const stack = await bootStack("ac106s", await pickPorts());
  try {
    await skipFirstRun(page);
    await openSettings(stack, page);

    /* AC-9: the access default names what it gates — no sandbox promise.
       (v3's copy: "stops and asks you before anything that deletes,
       publishes or spends" / "never stops to ask".) */
    const policy = page.getByRole("radiogroup", {
      name: "Approvals",
      exact: true,
    });
    await expect(
      policy.getByRole("radio", { name: "Ask before risky commands" }),
    ).toBeVisible();
    await expect(
      page.getByText(/stops and asks you before anything that deletes/),
    ).toBeVisible();
    await expect(page.getByText(/never stops to ask/)).toBeVisible();
    await expect(
      page.getByText(/outside its folder|works anywhere/i),
    ).toHaveCount(0);

    /* #884: the engine's own Smart/Manual/Off policy row is gone — only the
       one Ask / Full access system shows. */
    await expect(
      page.getByRole("radiogroup", { name: "Engine approval policy" }),
    ).toHaveCount(0);
    for (const name of ["Smart", "Manual", "Off"])
      await expect(page.getByRole("radio", { name, exact: true })).toHaveCount(
        0,
      );
    await page.screenshot({ path: `${SHOTS}/ac-9-settings.png` });

    /* Default → Full access (after its confirm) seeds the NEXT new
       conversation only. */
    await policy.getByRole("radio", { name: "Full access" }).click();
    await page.locator("[data-access-confirm]").click();
    await expect(
      policy.getByRole("radio", { name: "Full access" }),
    ).toHaveAttribute("aria-checked", "true");
    await newThread(stack, page);
    await expect(pill(page)).toHaveAttribute("data-access", "full");
  } finally {
    await stack.stop();
  }
});

/** The new-chat draft's access pill (the thread's is `pill`). */
const draftPill = (page: Page) =>
  v3Peek(page).locator('[data-slot="access-pill"]');

/** Switch the open draft to another agent through its Agent chip. */
async function draftAgent(page: Page, name: string) {
  await v3Peek(page).getByTitle("Agent", { exact: true }).click();
  await v3Peek(page)
    .getByRole("menuitemradio", { name: new RegExp(name) })
    .click();
  await expect(v3Peek(page).getByPlaceholder(`Message ${name}…`)).toBeVisible();
}

/** Send the open draft; resolves once it has swapped for its thread and the
    thread's first turn is over. */
async function sendDraft(page: Page, name: string) {
  await v3Peek(page)
    .getByPlaceholder(`Message ${name}…`)
    .fill("Say hello once");
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  await expect(pill(page)).toBeVisible({ timeout: 30_000 });
  await expect(settled(page)).toBeVisible({ timeout: 90_000 });
}

test("AC-3 the new-chat draft's Ask / Full access pill starts on Settings' default, a pick holds per agent, and the thread starts with it (#106)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const stack = await bootStack("ac106d", await pickPorts());
  try {
    await skipFirstRun(page);
    await page.goto(`${stack.webUrl}/`);
    const { employee } = await relayRpc<{ employee: { id: string } }>(
      page,
      stack,
      "employees.create",
      { name: "Blanca" },
    );

    /* ── Default's draft starts on Settings' default (Ask, untouched) ── */
    await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:default`);
    await expect(draftPill(page)).toHaveAttribute("data-access", "ask", {
      timeout: 30_000,
    });
    await expect(draftPill(page)).toContainText("Ask");

    /* ── A pick flips it (menu + confirm, #886); another
       agent's draft is not that agent's pick ── */
    await setAccess(page, "full", draftPill(page));
    await expect(draftPill(page)).toContainText("Full access");
    await draftAgent(page, "Blanca");
    await expect(draftPill(page)).toHaveAttribute("data-access", "ask");
    /* …and Default's pick is still there when the chip comes back to it. */
    await draftAgent(page, "Default");
    await expect(draftPill(page)).toHaveAttribute("data-access", "full");
    await page.screenshot({ path: `${SHOTS}/ac-3-draft-pill-full.png` });

    /* ── The thread starts with the draft's access, read on its own pill ── */
    await sendDraft(page, "Default");
    await expect(pill(page)).toHaveAttribute("data-access", "full");

    /* ── Settings' default moves the next draft; a pick still beats it ── */
    await openSettings(stack, page);
    await page
      .getByRole("radiogroup", { name: "Approvals", exact: true })
      .getByRole("radio", { name: "Full access" })
      .click();
    await page.locator("[data-access-confirm]").click();
    await page.goto(
      `${stack.webUrl}/#?page=threads&open=newchat:${employee.id}`,
    );
    await expect(draftPill(page)).toHaveAttribute("data-access", "full", {
      timeout: 30_000,
    });
    await setAccess(page, "ask", draftPill(page));
    await sendDraft(page, "Blanca");
    await expect(pill(page)).toHaveAttribute("data-access", "ask");
  } finally {
    await stack.stop();
  }
});

test("AC-1 the Full access pill actually paints orange, light and dark (#106)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  /* The pill's full state must read ORANGE (Codex-style warning), not the
     neutral gray of the paperclip/model picker beside it. Read the real
     computed colors on the app's thread composer — a bare text-orange-600
     probe div in the same sheet tells us whether the utility exists at all. */
  const stack = await bootStack("ac106c", await pickPorts());
  try {
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
        const pill = document.querySelector(
          '[data-thread-panel] [data-slot="access-pill"]',
        );
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
      await newThread(stack, page);
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
      await setAccess(page, "full", p);
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
  } finally {
    await stack.stop();
  }
});
