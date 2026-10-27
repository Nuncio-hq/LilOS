// @vitest-environment happy-dom
/* Settings' default access (#886): Full as the default asks first, the same
   confirm as the access pill; Back or no answer saves nothing. */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DefaultAccess } from "../src/v3/v3-settings-access";

afterEach(cleanup);

const body = () => document.body as HTMLElement;
const radio = (name: RegExp) =>
  within(body()).getByRole("radio", { name }) as HTMLElement;

describe("DefaultAccess", () => {
  test("Full saves only after the confirm", () => {
    const onChange = vi.fn();
    render(<DefaultAccess value="ask" onChange={onChange} />);
    fireEvent.click(radio(/Full access/));
    expect(onChange).not.toHaveBeenCalled();
    expect(body().textContent).toContain(
      "New conversations will run tools without asking",
    );
    fireEvent.click(within(body()).getByText("Use Full access"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("full");
    expect(body().querySelector("[data-full-access-confirm]")).toBeNull();
  });

  test("Back saves nothing and leaves Ask selected", () => {
    const onChange = vi.fn();
    render(<DefaultAccess value="ask" onChange={onChange} />);
    fireEvent.click(radio(/Full access/));
    fireEvent.click(within(body()).getByText("Back"));
    expect(onChange).not.toHaveBeenCalled();
    expect(radio(/Ask before/).getAttribute("aria-checked")).toBe("true");
    expect(body().querySelector("[data-full-access-confirm]")).toBeNull();
  });

  test("going back to Ask needs no confirm", () => {
    const onChange = vi.fn();
    render(<DefaultAccess value="full" onChange={onChange} />);
    fireEvent.click(radio(/Ask before/));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("ask");
  });
});
