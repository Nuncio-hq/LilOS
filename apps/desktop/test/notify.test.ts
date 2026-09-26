/**
 * Issue #32 — the Electron-main side of notifications: a renderer frame is
 * validated against the desktop contract before a real OS notification posts,
 * and clicking it routes the renderer to that exact conversation.
 */
import { describe, expect, it } from "vitest";
import { postDesktopNotification } from "../src/notify";

const fakeDeps = () => {
  const shown: { title: string; body: string }[] = [];
  const clicks: (() => void)[] = [];
  const opened: string[] = [];
  const rejected: string[] = [];
  return {
    shown,
    clicks,
    opened,
    rejected,
    deps: {
      show: (opts: { title: string; body: string }) => {
        shown.push(opts);
        return { onClick: (cb: () => void) => clicks.push(cb) };
      },
      openConversation: (id: string) => opened.push(id),
      onReject: (err: string) => rejected.push(err),
    },
  };
};

describe("AC-1 postDesktopNotification", () => {
  it("posts a valid notification to the OS", () => {
    const { shown, deps } = fakeDeps();
    const ok = postDesktopNotification(
      {
        conversationId: "c1",
        kind: "ask",
        title: "Builder needs your approval",
        body: "git push",
      },
      deps,
    );
    expect(ok).toBe(true);
    expect(shown).toEqual([
      { title: "Builder needs your approval", body: "git push" },
    ]);
  });

  it("drops malformed frames instead of throwing", () => {
    const { shown, rejected, deps } = fakeDeps();
    expect(postDesktopNotification({ title: "no conv" }, deps)).toBe(false);
    expect(postDesktopNotification("nope", deps)).toBe(false);
    expect(
      postDesktopNotification(
        { conversationId: "c1", kind: "bogus", title: "x", body: "" },
        deps,
      ),
    ).toBe(false);
    expect(shown).toEqual([]);
    expect(rejected).toHaveLength(3);
  });
});

describe("AC-2 notification click opens the conversation", () => {
  it("click routes to the notification's conversationId", () => {
    const { clicks, opened, deps } = fakeDeps();
    postDesktopNotification(
      {
        conversationId: "c7",
        kind: "done",
        title: "Builder finished",
        body: "",
      },
      deps,
    );
    expect(clicks).toHaveLength(1);
    clicks[0]();
    expect(opened).toEqual(["c7"]);
  });
});
