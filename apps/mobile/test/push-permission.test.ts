import { atom } from "nanostores";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* #600's pre-prompt explained the system dialog — but "Not now" left the
   OS state undetermined, and register() re-runs on every online flip and
   foreground, so the alert re-presented forever (on device it stacked
   Alert over Alert). The fix: one answered pre-prompt arms a persisted
   flag; only the Settings "Ask" row can raise it again, and concurrent
   register()s can't double-present. */

const { alertSpy, getPermsSpy, reqPermsSpy } = vi.hoisted(() => ({
  alertSpy: vi.fn(),
  getPermsSpy: vi.fn(),
  reqPermsSpy: vi.fn(),
}));

const asyncStore = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStore.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      asyncStore.set(key, value);
    },
    removeItem: async (key: string) => {
      asyncStore.delete(key);
    },
  },
}));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
  easConfig: null,
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: getPermsSpy,
  requestPermissionsAsync: reqPermsSpy,
  getExpoPushTokenAsync: async () => ({ data: "token" }),
  getLastNotificationResponseAsync: async () => null,
  addNotificationResponseReceivedListener: () => ({ remove: () => {} }),
  setNotificationHandler: () => {},
}));
vi.mock("react-native", () => ({
  Alert: { alert: alertSpy },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("../src/demo/lifecycle", () => ({ $demo: atom(false) }));
vi.mock("../src/link", () => ({ $client: atom(null), $link: atom("offline") }));
vi.mock("../src/paired-macs", () => ({ $phase: atom("app") }));
vi.mock("../src/routes", () => ({
  nav: {
    isReady: () => false,
    addListener: () => ({ remove: () => {} }),
    navigate: vi.fn(),
  },
}));

let requestPushPermission: typeof import("../src/push").requestPushPermission;

type Buttons = { text: string; onPress?: () => void }[];
const press = (label: string) => {
  const buttons = alertSpy.mock.lastCall?.[2] as Buttons;
  buttons.find((b) => b.text === label)?.onPress?.();
};

beforeEach(async () => {
  /* A fresh module per test: `asked`/`prompting` are module state, so a
     re-import is the only clean reset (same trick as the draft-store
     relaunch leg). */
  vi.resetModules();
  ({ requestPushPermission } = await import("../src/push"));
  asyncStore.clear();
  alertSpy.mockReset();
  reqPermsSpy.mockReset();
  reqPermsSpy.mockResolvedValue({ status: "granted" });
  getPermsSpy.mockReset();
  getPermsSpy.mockResolvedValue({ status: "undetermined", canAskAgain: true });
});

describe("push pre-prompt — asked once per device", () => {
  it("auto: 'Not now' arms the flag — a later auto ask stays quiet", async () => {
    alertSpy.mockImplementation((...args: unknown[]) => {
      (args[2] as Buttons).find((b) => b.text === "Not now")?.onPress?.();
    });
    await requestPushPermission();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(asyncStore.get("lilos.push.asked.v1")).toBe("1");
    await requestPushPermission();
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it("manual: the Settings Ask row bypasses the flag", async () => {
    alertSpy.mockImplementation((...args: unknown[]) => {
      (args[2] as Buttons).find((b) => b.text === "Not now")?.onPress?.();
    });
    await requestPushPermission();
    await requestPushPermission({ manual: true });
    expect(alertSpy).toHaveBeenCalledTimes(2);
  });

  it("Continue runs the real iOS ask", async () => {
    alertSpy.mockImplementation((...args: unknown[]) => {
      (args[2] as Buttons).find((b) => b.text === "Continue")?.onPress?.();
    });
    await requestPushPermission();
    expect(reqPermsSpy).toHaveBeenCalledTimes(1);
  });

  it("concurrent calls present a single alert (no stacking)", async () => {
    const first = requestPushPermission(); // alert shown, promise pending
    const second = requestPushPermission(); // refused while prompting
    expect(alertSpy).toHaveBeenCalledTimes(1);
    press("Not now");
    await Promise.all([first, second]);
    // ...and the flag means a third auto call stays quiet too.
    await requestPushPermission();
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });
});
