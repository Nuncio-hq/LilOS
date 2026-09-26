// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewUrl,
} from "../src/components/ai-elements/web-preview";

/* AC-3 (issue #56): the Preview address field must always show the page's
   current URL — after a redirect or agent-driven navigation, not the string
   the human last typed. */
afterEach(cleanup);

const Preview = ({ url, onUrlChange }: { url: string; onUrlChange?: (u: string) => void }) => (
  <WebPreview url={url} onUrlChange={onUrlChange}>
    <WebPreviewNavigation>
      <WebPreviewUrl />
    </WebPreviewNavigation>
  </WebPreview>
);

describe("AC-3 the Preview address field follows the page's real URL", () => {
  it("an externally driven URL (redirect, agent navigation) updates the field", () => {
    const { rerender, getByRole } = render(
      <Preview url="https://example.com/" />,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("https://example.com/");

    // The browser landed somewhere else — the field follows.
    rerender(<Preview url="https://www.example.com/landing" />);
    expect(input.value).toBe("https://www.example.com/landing");
  });

  it("typing a URL still navigates; afterwards the field shows the landed URL", () => {
    const navigated: string[] = [];
    const { rerender, getByRole } = render(
      <Preview url="" onUrlChange={(u) => navigated.push(u)} />,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigated).toEqual(["example.com"]);

    // The page landed on the canonical URL — the field reflects it.
    rerender(<Preview url="https://example.com/" onUrlChange={(u) => navigated.push(u)} />);
    expect(input.value).toBe("https://example.com/");
  });
});
