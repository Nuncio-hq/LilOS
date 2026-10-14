import { describe, expect, it } from "vitest";
import {
  nextRunAt,
  runTitle,
  validCron,
  validSchedule,
} from "../src/app/schedule";

const at = (s: string) => new Date(s);

describe("schedule math (#136)", () => {
  it("daily lands the next clock time strictly after the anchor", () => {
    const s = { kind: "daily" as const, time: "9:00" };
    expect(nextRunAt(s, at("2026-10-10T08:30:00"))).toEqual(
      at("2026-10-10T09:00:00"),
    );
    expect(nextRunAt(s, at("2026-10-10T09:00:00"))).toEqual(
      at("2026-10-11T09:00:00"),
    );
  });

  it("weekdays skips the weekend", () => {
    const s = { kind: "weekdays" as const, time: "9:00" };
    /* Friday 10am → next slot is Monday 9:00. */
    expect(nextRunAt(s, at("2026-10-09T10:00:00"))).toEqual(
      at("2026-10-12T09:00:00"),
    );
  });

  it("hourly anchors on the next minute-mark", () => {
    const s = { kind: "hourly" as const, time: "0:30" };
    expect(nextRunAt(s, at("2026-10-10T09:45:00"))).toEqual(
      at("2026-10-10T10:30:00"),
    );
    expect(nextRunAt(s, at("2026-10-10T10:30:00"))).toEqual(
      at("2026-10-10T11:30:00"),
    );
  });

  it("weekly fires only on its weekday", () => {
    const s = { kind: "weekly" as const, time: "9:00", day: 3 };
    expect(nextRunAt(s, at("2026-10-12T00:00:00"))).toEqual(
      at("2026-10-14T09:00:00"),
    );
  });

  it("once fires on its date only and never again", () => {
    const s = { kind: "once" as const, time: "9:00", date: "2026-10-15" };
    expect(nextRunAt(s, at("2026-10-10T00:00:00"))).toEqual(
      at("2026-10-15T09:00:00"),
    );
    expect(nextRunAt(s, at("2026-10-15T09:00:00"))).toBeNull();
  });

  it("cron parses standard five-field syntax", () => {
    const s = { kind: "cron" as const, time: "0:00", cron: "0 9 * * 1-5" };
    expect(nextRunAt(s, at("2026-10-09T10:00:00"))).toEqual(
      at("2026-10-12T09:00:00"),
    );
    expect(validCron("*/15 * * * *")).toBe(true);
    expect(validCron("not a cron")).toBe(false);
    expect(validCron("61 * * * *")).toBe(false);
  });

  it("validSchedule rejects shapes the clock can't fire", () => {
    expect(validSchedule({ kind: "daily", time: "9:00" })).toBe(true);
    expect(validSchedule({ kind: "once", time: "9:00" })).toBe(false);
    expect(validSchedule({ kind: "cron", time: "0:00", cron: "bogus" })).toBe(
      false,
    );
  });

  it("runTitle reads like a user-titled session", () => {
    expect(runTitle("Triage", at("2026-10-02T09:00:00"))).toBe(
      "Triage · Fri 2 Oct",
    );
  });
});
