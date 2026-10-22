import { describe, expect, it } from "vitest";
import { startShell } from "../src/lib/start-shell";

describe("startShell (#827)", () => {
  it("paints the pop-out browser window without waiting for the relay", async () => {
    let booted = false;
    let rendered = false;
    const hung = new Promise<void>(() => {});
    await startShell({
      popout: true,
      boot: () => {
        booted = true;
        return hung;
      },
      render: () => {
        rendered = true;
      },
    });
    expect(rendered).toBe(true);
    expect(booted).toBe(false);
  });

  it("paints the app window only after boot, including when boot throws", async () => {
    let rendered = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = startShell({
      popout: false,
      boot: () => gate,
      render: () => {
        rendered = true;
      },
    });
    await Promise.resolve();
    expect(rendered).toBe(false);
    release();
    await pending;
    expect(rendered).toBe(true);

    rendered = false;
    await startShell({
      popout: false,
      boot: () => Promise.reject(new Error("relay down")),
      render: () => {
        rendered = true;
      },
    });
    expect(rendered).toBe(true);
  });
});
