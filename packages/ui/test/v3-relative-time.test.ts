import { describe, expect, test } from "vitest";
import { ago, relativeTime } from "../src/v3/v3-bits";

/* One phrase for every v3 clock that used to write `${ago(m)} ago`.
   `ago(0)` is "now", so that spelling was "now ago". */
describe("relativeTime", () => {
  test("under a minute is just now, never now ago", () => {
    expect(ago(0)).toBe("now");
    expect(relativeTime(0)).toBe("just now");
    expect(relativeTime(0.4)).toBe("just now");
  });

  test("minutes, hours and days say ago once", () => {
    expect(relativeTime(5)).toBe("5m ago");
    expect(relativeTime(59)).toBe("59m ago");
    expect(relativeTime(120)).toBe("2h ago");
    expect(relativeTime(90)).toBe("2h ago");
    expect(relativeTime(1440)).toBe("1d ago");
    expect(relativeTime(2880)).toBe("2d ago");
  });
});
