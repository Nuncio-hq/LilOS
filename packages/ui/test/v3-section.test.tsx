// @vitest-environment happy-dom
/* A section count of 0 is omitted. The empty line under the heading is
   the message; "Needs you 0" would say nothing twice (D-#769). */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { Section } from "../src/v3/v3-bits";

afterEach(cleanup);

describe("section counts", () => {
  test("zero is omitted, a positive count and a worded count stay", () => {
    render(<Section title="Needs you" count={0} />);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    cleanup();

    render(<Section title="Schedules" count="0" />);
    expect(screen.getByRole("heading", { name: "Schedules" })).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    cleanup();

    render(<Section title="Needs you" count={2} />);
    expect(screen.getByRole("heading", { name: /Needs you\s*2/ })).toBeTruthy();
    cleanup();

    render(<Section title="Waiting on you" count="3 more" />);
    expect(
      screen.getByRole("heading", { name: /Waiting on you\s*3 more/ }),
    ).toBeTruthy();
  });
});
