import { beforeEach, describe, expect, it, vi } from "vitest";

/* #556 AC-1: long-pressing an agent reply offers Copy (its markdown) and
   Share. The sheet is Alert-based like every other confirm in the app. */

const { alertSpy, shareSpy, setStringSpy } = vi.hoisted(() => ({
  alertSpy: vi.fn(),
  shareSpy: vi.fn().mockResolvedValue({ action: "sharedAction" }),
  setStringSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("react-native", () => ({
  Alert: { alert: alertSpy },
  Share: { share: shareSpy },
}));
vi.mock("expo-clipboard", () => ({
  setStringAsync: setStringSpy,
}));

import { replyActionsSheet } from "../src/employees/reply-actions";

beforeEach(() => {
  alertSpy.mockClear();
  shareSpy.mockClear();
  setStringSpy.mockClear();
});

describe("replyActionsSheet", () => {
  it("offers Copy, Share and Cancel", () => {
    replyActionsSheet("# hi");
    const buttons = alertSpy.mock.calls[0]?.[2] as { text: string }[];
    expect(buttons.map((b) => b.text)).toEqual(["Copy", "Share…", "Cancel"]);
  });

  it("Copy writes the reply's markdown verbatim", () => {
    replyActionsSheet("**bold** and `code`");
    const buttons = alertSpy.mock.calls[0]?.[2] as {
      text: string;
      onPress?: () => void;
    }[];
    buttons.find((b) => b.text === "Copy")?.onPress?.();
    expect(setStringSpy).toHaveBeenCalledWith("**bold** and `code`");
  });

  it("Share passes the markdown as the message", () => {
    replyActionsSheet("share me");
    const buttons = alertSpy.mock.calls[0]?.[2] as {
      text: string;
      onPress?: () => void;
    }[];
    buttons.find((b) => b.text === "Share…")?.onPress?.();
    expect(shareSpy).toHaveBeenCalledWith({ message: "share me" });
  });
});
