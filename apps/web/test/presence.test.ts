import { describe, expect, it, vi } from "vitest";
import { watchPresence } from "../src/lib/presence";

const bridge = (p: { idleSeconds: number; locked: boolean }) => ({
  current: vi.fn(async () => p),
  onChange: undefined,
});

describe("#561 AC-1 watchPresence — at-the-Mac heartbeats", () => {
  it("reports active on the first tick while the user is typing", async () => {
    const report = vi.fn(async () => {});
    const un = watchPresence({
      bridge: bridge({ idleSeconds: 10, locked: false }),
      report,
      intervalMs: 1000,
    });
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(true));
    un();
  });

  it("a locked screen reports inactive", async () => {
    const report = vi.fn(async () => {});
    const un = watchPresence({
      bridge: bridge({ idleSeconds: 3, locked: true }),
      report,
      intervalMs: 1000,
    });
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(false));
    un();
  });

  it("idle past the window reports inactive", async () => {
    const report = vi.fn(async () => {});
    const un = watchPresence({
      bridge: bridge({ idleSeconds: 400, locked: false }),
      report,
      intervalMs: 1000,
    });
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(false));
    un();
  });

  it("heartbeats while active and flips to inactive on lock", async () => {
    vi.useFakeTimers();
    let p = { idleSeconds: 5, locked: false };
    const report = vi.fn(async () => {});
    const un = watchPresence({
      bridge: {
        current: vi.fn(async () => p),
        onChange: undefined,
      },
      report,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(report).toHaveBeenLastCalledWith(true);
    p = { idleSeconds: 900, locked: true };
    await vi.advanceTimersByTimeAsync(1000);
    expect(report).toHaveBeenLastCalledWith(false);
    un();
    vi.useRealTimers();
  });

  it("no presence bridge → no reports, harmless noop", () => {
    const report = vi.fn(async () => {});
    const un = watchPresence({ bridge: undefined, report });
    un();
    expect(report).not.toHaveBeenCalled();
  });
});
