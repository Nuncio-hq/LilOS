import { describe, expect, it } from "vitest";
import { launchEnv } from "../scripts/launch-env";

/**
 * AC-1 (#837): `app:local` launches the app without Electron-as-Node env.
 * A terminal inside an Electron app (T3 Code, VS Code, …) exports
 * ELECTRON_RUN_AS_NODE; `open` forwards it to LilOS, which then boots as
 * plain Node — no window, no /healthz.
 */
describe("launchEnv (#837)", () => {
  const env = {
    HOME: "/Users/dev",
    PATH: "/usr/bin:/bin",
    LILOS_ENGINE_DEFAULT: "hermes",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    ELECTRON_NO_ASAR: "1",
    NODE_OPTIONS: "--inspect=9229",
  };

  it("drops every ELECTRON_* var, not just ELECTRON_RUN_AS_NODE", () => {
    const clean = launchEnv(env);
    expect(Object.keys(clean).some((k) => k.startsWith("ELECTRON_"))).toBe(
      false,
    );
  });

  it("drops NODE_OPTIONS (agent-harness flag injection)", () => {
    expect(launchEnv(env).NODE_OPTIONS).toBeUndefined();
  });

  it("keeps the vars the app and launchd actually need", () => {
    const clean = launchEnv(env);
    expect(clean.HOME).toBe(env.HOME);
    expect(clean.PATH).toBe(env.PATH);
    expect(clean.LILOS_ENGINE_DEFAULT).toBe(env.LILOS_ENGINE_DEFAULT);
  });

  it("leaves a clean env untouched and does not mutate the input", () => {
    const clean = { HOME: "/Users/dev", PATH: "/usr/bin:/bin" };
    expect(launchEnv(clean)).toEqual(clean);
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});
