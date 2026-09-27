// @vitest-environment happy-dom
/* Issue #80, ui layer: AC-1 the user's messages carry the same avatar as the
   sidebar footer (one Human identity, high-contrast fallback or image) and
   AC-2 a mid-stream reply renders markdown as it arrives, on the same code
   path as the finished render. */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AgentTurn } from "../src/conversation/turns";
import { Row } from "../src/feed/row";
import { HumanAvatar } from "../src/shell/avatars";
import { Sidebar } from "../src/shell/sidebar";
import type { Employee, Human } from "../src/types";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element.prototype.scrollTo === "undefined") {
  Element.prototype.scrollTo = () => {};
}
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof Element.prototype.getAnimations === "undefined") {
  Element.prototype.getAnimations = () => [];
}
afterEach(cleanup);

const ME: Human = { name: "Oscar", color: "bg-blue-600" };

const EMP: Employee = {
  id: "emp_default",
  name: "Default",
  role: "Builder",
  status: "online",
  profile: "builder",
  model: "fake-large",
  now: "",
  instructions: "",
  respondTo: "me",
};
const emp = (id: string) => (id === EMP.id ? EMP : undefined);

describe("issue #80", () => {
  test("AC-1 the human avatar falls back to a high-contrast initial (white on the person's colour)", () => {
    const { container } = render(<HumanAvatar human={ME} />);
    const fb = container.querySelector('[data-slot="avatar-fallback"]');
    expect(fb?.textContent).toBe("O");
    // white on bg-blue-600 (#2563eb) ≈ 5.17:1 — WCAG AA for normal text.
    expect(fb?.className).toContain("text-white");
    expect(fb?.className).toContain("bg-blue-600");
  });

  test("AC-1 a user message row wears the same avatar the sidebar footer shows", () => {
    // A different identity than the shipped one proves the footer follows the
    // app's `me`, not a hardcoded "O" — on main this row/footer pair diverges.
    const who: Human = { name: "Minh", color: "bg-cyan-600" };
    const whoFor = (id: string) => (id === "user" ? who : undefined);
    const { container } = render(
      <Row from="user" emp={emp} human={whoFor}>
        <p>hello</p>
      </Row>,
    );
    const rowFb = container.querySelector('[data-slot="avatar-fallback"]');
    expect(rowFb?.textContent).toBe("M");
    expect(rowFb?.className).toContain("bg-cyan-600");
    cleanup();
    const side = render(
      <Sidebar
        navOpen
        hiddenWhenClosed={false}
        me={who}
        companyChannels={[]}
        projects={[]}
        folders={[]}
        employees={[]}
        view={{ kind: "dm", id: "" }}
        theme="light"
        isProjectDefaultOpen={() => false}
        onSetTheme={() => {}}
        onCloseNav={() => {}}
        onGoChannel={() => {}}
        onGoDM={() => {}}
        onOpenTickets={() => {}}
        onAddFolder={() => {}}
      />,
    );
    const sideFb = side.container.querySelector(
      '[data-slot="avatar-fallback"]',
    );
    // Same initial + same colour classes on both fallbacks → same person.
    expect(sideFb?.textContent).toBe(rowFb?.textContent);
    expect(sideFb?.className).toContain("bg-cyan-600");
    expect(side.container.textContent).toContain("Minh");
  });

  test("AC-1 a human with an image renders it in the footer too", async () => {
    // base-ui mounts <img> only once the image loads; happy-dom never fires
    // Image.onload, so stub it to complete on src assignment.
    const RealImage = window.Image;
    window.Image = class {
      onload?: () => void;
      onerror?: () => void;
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    } as unknown as typeof window.Image;
    const { container } = render(
      <HumanAvatar human={{ ...ME, image: "/oscar.png" }} />,
    );
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "/oscar.png",
      ),
    );
    cleanup();
    const side = render(
      <Sidebar
        navOpen
        hiddenWhenClosed={false}
        me={{ ...ME, image: "/oscar.png" }}
        companyChannels={[]}
        projects={[]}
        folders={[]}
        employees={[]}
        view={{ kind: "dm", id: "" }}
        theme="light"
        isProjectDefaultOpen={() => false}
        onSetTheme={() => {}}
        onCloseNav={() => {}}
        onGoChannel={() => {}}
        onGoDM={() => {}}
        onOpenTickets={() => {}}
        onAddFolder={() => {}}
      />,
    );
    await waitFor(() =>
      expect(side.container.querySelector("img")?.getAttribute("src")).toBe(
        "/oscar.png",
      ),
    );
    window.Image = RealImage;
  });

  test("AC-2 a mid-stream reply renders the partial chunk as markdown, not raw source", () => {
    // Same string the app puts in `streaming` while phase === "text".
    const partial = "Short answer:\n\n- The contracts already carry `se";
    const { container } = render(
      <AgentTurn
        r={{
          from: EMP.id,
          time: "",
          text: partial,
          streaming: partial,
          live: true,
          phase: "typing",
        }}
        emp={emp}
        last
      />,
    );
    // remend closes the dangling `- ` item and the unclosed backtick —
    // the user sees a bullet + a code span, never raw ` or "- ".
    const streaming = container.querySelector("[data-streaming]");
    expect(streaming).not.toBeNull();
    if (!streaming) {
      throw new Error("no [data-streaming] node");
    }
    expect(streaming.querySelector("li")?.textContent).toContain(
      "The contracts already carry",
    );
    expect(streaming.querySelector("code")?.textContent).toBe("se");
    expect(streaming.textContent).not.toContain("`se");
    expect(streaming.textContent).not.toContain("- The contracts");
    // The caret rides on streamdown's last-child ::after while animating.
    const styled = [...streaming.querySelectorAll("[style]")].find((el) =>
      el.getAttribute("style")?.includes("streamdown-caret"),
    );
    expect(styled).toBeTruthy();
  });

  test("AC-2 the finished render shows the same markdown without the caret", () => {
    const text =
      "Short answer:\n\n- The contracts already carry `seq`, so replay needs no new endpoint.";
    const { container } = render(
      <AgentTurn
        r={{
          from: EMP.id,
          time: "12:00",
          text,
          phase: "done",
        }}
        emp={emp}
        last
      />,
    );
    expect(container.querySelector("[data-streaming]")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("seq");
    expect(container.querySelector("li")?.textContent).toContain(
      "The contracts already carry",
    );
  });
});
