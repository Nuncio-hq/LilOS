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
    scroll extent AND scrollTop to settle at the bottom. Two reasons a
    single programmatic write is otherwise swallowed: use-stick-to-bottom
    drops scroll events that land while its resizeDifference is set, and
    its resize="smooth" animation keeps re-writing scrollTop to the
    bottom until the content stops growing. */
async function settlePort(page: Page, portSelector: string) {
  let prev: { h: number; top: number; ch: number } | null = null;
  await expect
    .poll(async () => {
      const cur = await page.evaluate((sel) => {
        const sc = document.querySelector(sel)
          ?.firstElementChild as HTMLElement | null;
        if (!sc) throw new Error(`no scroller under ${sel}`);
        return {
          h: sc.scrollHeight,
          top: sc.scrollTop,
          ch: sc.clientHeight,
        };
      }, portSelector);
      const settled =
        cur.h > 0 &&
        prev !== null &&
        cur.h === prev.h &&
        cur.top === prev.top &&
        /* The library's lock target is scrollHeight - 1 - clientHeight
           and scrollTop is fractional — "at the bottom" is within 2px. */
        cur.top >= cur.h - cur.ch - 2;
      prev = cur;
      return settled;
    })
    .toBe(true);
}

async function expectClear(page: Page, portSelector: string) {
  await settlePort(page, portSelector);
  const { max } = await scrollerStats(page, portSelector);
  expect(max, "port must be scrollable for this invariant").toBeGreaterThan(0);
  const button = page.locator(portSelector).locator(":scope > button");
  /* Positions: 120px and 80px above the bottom (the reported case: last
     row under the button), and the absolute top. Offsets must clear 70px:
     use-stick-to-bottom exposes isAtBottom || isNearBottom and
     isNearBottom holds within STICK_TO_BOTTOM_OFFSET_PX=70 of the bottom,
     so the ↓ can never mount nearer than that — a "40px above bottom"
     position asserts something the library forbids (CI flake #536 r1).
     Offsets are computed from the CURRENT bottom inside each write —
     scrollHeight keeps churning while lazy rows remeasure, and a stale
     absolute top can land below the shrunken extent, which clamps the
     write back to the bottom and the ↓ never mounts. Two separate waits
     per position: first the ↓ must be mounted (it unmounts at the
     bottom — "not mounted yet" is not "overlap"), then hits must stay
     empty. */
  const positions: Array<number | "top"> = [120, 80, "top"];
  const scrollTo = (sel: string, t: number | "top") =>
    page.evaluate(
      ([s, p]) => {
        const sc = document.querySelector(s)
          ?.firstElementChild as HTMLElement | null;
        if (!sc) throw new Error(`no scroller under ${s}`);
        sc.scrollTop = p === "top" ? 0 : sc.scrollHeight - sc.clientHeight - p;
      },
      [sel, t] as const,
    );
  for (const pos of positions) {
    await scrollTo(portSelector, pos);
    await expect(button).toBeVisible({ timeout: 15_000 });
    /* Re-scroll inside the poll: the library's smooth bottom-lock
       animation can still be in flight on the first try, and a snap back
       to the bottom unmounts the button (returned as "unmounted",
       never []). */
    await expect
      .poll(
        async () => {
          await scrollTo(portSelector, pos);
          const res = await overlaps(page, portSelector);
          return "hits" in res ? res.hits : "unmounted";
        },
        {
          timeout: 10_000,
          message: `↓ overlaps a message row ${pos === "top" ? "at the top" : `${pos}px above the bottom`}`,
        },
      )
      .toEqual([]);
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
      await page.goto("/?stickProbe=1"); // TEMP #626 debug knob
      const panel = page.locator("aside").last();
      await panel.getByRole("button", { name: "Focus", exact: true }).click();
      const port = page.locator('main [role="log"]');
      await expect(port.locator("[data-msg]").first()).toBeVisible({
        timeout: 15_000,
      });
      try {
        await expectClear(page, "main [role='log']");
      } catch (err) {
        const dump = await page.evaluate(
          () =>
            (window as unknown as { __stick?: unknown[] }).__stick?.slice(
              -800,
            ) ?? "no probe",
        );
        console.log(`STICKPROBE ${JSON.stringify(dump)}`);
        throw err;
      }
    });
  }
});
