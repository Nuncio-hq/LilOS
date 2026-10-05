import { expect, type Page, test } from "@playwright/test";

/* Issue #535 — the floating ↓ scroll-to-latest button must never overlap
   message content. Real-browser invariant (boundingBox): with the view
   scrolled up, the button's box intersects no [data-msg] box — in the
   Thread panel AND in Focus, at the three desktop sizes the issue names.
   The fixture is the prototype's seeded ses_b71d thread (open by default on
   ≥1280px): the same view and the same last row the bug was reported on.
   Red on main: the button floats bottom-4 over the port's content. */

const SIZES: Array<{ w: number; h: number }> = [
  { w: 1288, h: 700 },
  { w: 1288, h: 900 },
  { w: 1440, h: 900 },
];

/* The conversation port carries role="log" (components/ai-elements/
   conversation.tsx); the scroll button is its only direct-child <button>
   (TurnRow chrome lives deeper inside the content).
   Rows scrolled out of the scroller keep unclipped bounding boxes — a row
   half-out of view would falsely "hit" the button through the clip, so each
   row is clipped to the scroller's own rect before intersecting: what the
   check measures is what a user can actually see. */
const overlaps = (page: Page, portSelector: string) =>
  page.evaluate((sel) => {
    const port = document.querySelector(sel);
    if (!port) return { error: `no port ${sel}` } as const;
    const sc = port.firstElementChild;
    if (!sc) return { error: "no scroller" } as const;
    const btn = port.querySelector(":scope > button");
    if (!btn) return { button: false } as const;
    const s = sc.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const hits = [...port.querySelectorAll("[data-msg]")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.getAttribute("data-msg"),
          top: Math.max(r.top, s.top),
          bottom: Math.min(r.bottom, s.bottom),
          left: Math.max(r.left, s.left),
          right: Math.min(r.right, s.right),
        };
      })
      .filter(
        (r) =>
          r.bottom > r.top &&
          r.right > r.left &&
          r.bottom > b.top &&
          r.top < b.bottom &&
          r.right > b.left &&
          r.left < b.right,
      )
      .map((r) => r.id);
    return { button: true, hits } as const;
  }, portSelector);

/* Browser-side: the scroller is the port's first element child
   (use-stick-to-bottom's scrollRef div). */
const scrollerStats = (page: Page, portSelector: string) =>
  page.evaluate((sel) => {
    const sc = document.querySelector(sel)
      ?.firstElementChild as HTMLElement | null;
    if (!sc) throw new Error(`no scroller under ${sel}`);
    return { max: sc.scrollHeight - sc.clientHeight, h: sc.scrollHeight };
  }, portSelector);

/** Rows keep mounting after first paint (cards, trays) — wait for the
    scroll extent to stop growing before measuring anything. */
async function settlePort(page: Page, portSelector: string) {
  let prev = -1;
  await expect
    .poll(async () => {
      const { h } = await scrollerStats(page, portSelector);
      const stable = h === prev && h > 0;
      prev = h;
      return stable;
    })
    .toBe(true);
}

async function expectClear(page: Page, portSelector: string) {
  await settlePort(page, portSelector);
  const { max } = await scrollerStats(page, portSelector);
  expect(max, "port must be scrollable for this invariant").toBeGreaterThan(0);
  /* Positions: just off the bottom (last row under the button — the reported
     case), mid-scroll, and the top. Re-scroll inside the poll: the library's
     smooth bottom-lock animation can still be in flight on the first try. */
  for (const top of [Math.max(0, max - 120), Math.max(0, max - 40), 0]) {
    await expect
      .poll(
        async () => {
          await page.evaluate(
            ([sel, t]) => {
              const sc = document.querySelector(sel)
                ?.firstElementChild as HTMLElement | null;
              if (!sc) throw new Error(`no scroller under ${sel}`);
              sc.scrollTop = t;
            },
            [portSelector, top] as const,
          );
          return overlaps(page, portSelector);
        },
        {
          timeout: 10_000,
          message: `↓ overlaps a message row at scrollTop=${top}`,
        },
      )
      .toEqual({ button: true, hits: [] });
  }
}

test.describe("AC-2 ↓ scroll-to-latest never overlaps a message row", () => {
  for (const { w, h } of SIZES) {
    test(`Thread panel ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      // The seeded ses_b71d thread opens in the right-hand panel by default.
      const port = page.locator("aside").last().locator('[role="log"]');
      await expect(port.locator("[data-msg]").first()).toBeVisible({
        timeout: 15_000,
      });
      await expectClear(page, "aside [role='log']");
    });

    test(`Focus ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      const panel = page.locator("aside").last();
      await panel.getByRole("button", { name: "Focus", exact: true }).click();
      const port = page.locator('main [role="log"]');
      await expect(port.locator("[data-msg]").first()).toBeVisible({
        timeout: 15_000,
      });
      await expectClear(page, "main [role='log']");
    });
  }
});
