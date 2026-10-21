/* The next run is the smallest `nextAt`. The words in `next` are display
   only, so two days past tomorrow do not fall back to list order (D-#774). */
import { describe, expect, test } from "vitest";
import type { V3Schedule } from "../src/v3/v3-data-types";
import { soonestNext } from "../src/v3/v3-schedule-text";

const at = (iso: string) => Date.parse(iso);

const job = (
  p: Partial<V3Schedule> & Pick<V3Schedule, "id" | "next">,
): V3Schedule => ({
  agentId: "ada",
  title: p.id,
  prompt: "Check overnight",
  when: { kind: "daily", time: "09:00" },
  ...p,
});

describe("soonest next run", () => {
  test("two days beyond tomorrow: the earlier day wins, not list order", () => {
    // Wednesday 28 Oct is sooner than Monday 2 Nov. Neither phrase is
    // Today or Tomorrow, so ranking the words would keep creation order.
    expect(
      soonestNext([
        job({
          id: "mon",
          next: "Mon 09:00",
          nextAt: at("2026-11-02T09:00:00"),
        }),
        job({
          id: "wed",
          next: "Wed 09:00",
          nextAt: at("2026-10-28T09:00:00"),
        }),
      ]),
    ).toBe("Wed 09:00");
  });

  test("the same day: the earlier time wins", () => {
    expect(
      soonestNext([
        job({
          id: "late",
          next: "Wed 15:00",
          nextAt: at("2026-10-28T15:00:00"),
        }),
        job({
          id: "early",
          next: "Wed 09:00",
          nextAt: at("2026-10-28T09:00:00"),
        }),
      ]),
    ).toBe("Wed 09:00");
  });

  test("a once-run next month loses to a weekly run in two days", () => {
    expect(
      soonestNext([
        job({
          id: "once",
          next: "Thu 19 Nov 09:00",
          nextAt: at("2026-11-19T09:00:00"),
          when: { kind: "once", time: "09:00", date: "2026-11-19" },
        }),
        job({
          id: "weekly",
          next: "Fri 09:00",
          nextAt: at("2026-10-23T09:00:00"),
          when: { kind: "weekly", time: "09:00", day: 5 },
        }),
      ]),
    ).toBe("Fri 09:00");
  });

  test("a paused sooner run is ignored, and so is one that will not run again", () => {
    expect(
      soonestNext([
        job({
          id: "paused",
          next: "Today 01:00",
          nextAt: at("2026-10-21T01:00:00"),
          paused: true,
        }),
        job({ id: "finished", next: "No more runs" }),
        job({
          id: "later",
          next: "Fri 09:00",
          nextAt: at("2026-10-23T09:00:00"),
        }),
      ]),
    ).toBe("Fri 09:00");
  });
});
