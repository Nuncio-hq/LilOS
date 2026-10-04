import type { AppClient } from "@lilos/client-runtime";
import type { WelcomeResult } from "@lilos/contracts/app";
import type {
  ModelOption,
  ModelProvider,
  ModelsListResult,
} from "@lilos/contracts/engine";
import { atom } from "nanostores";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  $catalog,
  $catalogUnavailable,
  refreshModelCatalog,
  resetDmStore,
  watchDm,
} from "../src/dm-store";

/* #483: one failed/slow `models.list` must not take model choice away — the
   phone falls back to the catalog the relay cached on `welcome.engineHost`,
   shows a disabled "Models unavailable" chip with retry when even that is
   empty, and re-fetches when the engine host comes back (host.changed),
   not only on socket reconnect. */

const HOST_MODELS: ModelOption[] = [
  {
    id: "fake-large",
    name: "Fake Large",
    provider: "fake",
    efforts: ["low", "high"],
    defaultEffort: "low",
  },
  { id: "fake-small", provider: "fake" },
];
const HOST_PROVIDERS: ModelProvider[] = [{ id: "fake", name: "Fake" }];

const welcomeWith = (
  engineHost?: Partial<NonNullable<WelcomeResult["engineHost"]>>,
) =>
  atom<WelcomeResult | undefined>({
    protocolVersion: 1,
    relayVersion: "test",
    instanceId: "inst-1",
    ...(engineHost === undefined
      ? {}
      : {
          engineHost: { connected: true, ...engineHost },
        }),
  });

type FakeClient = AppClient & {
  emit: (method: string, params: Record<string, unknown>) => void;
  calls: { method: string; params: unknown }[];
};

/** Just the members watchDm touches: state, request, listModels, onEvent. */
const fakeClient = (opts: {
  listModels?: (params?: { refresh?: boolean }) => Promise<ModelsListResult>;
}): FakeClient => {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
  const client = {
    state: atom<"idle" | "connecting" | "ready" | "reconnecting" | "closed">(
      "idle",
    ),
    calls,
    emit: (method: string, params: Record<string, unknown>) => {
      for (const fn of listeners) fn(method, params);
    },
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "asks.list") return { asks: [] };
      if (method === "folders.list") return { folders: [] };
      if (method === "settings.get") return { value: undefined };
      return {};
    },
    listModels: async (params?: { refresh?: boolean }) => {
      calls.push({ method: "models.list", params });
      return await (opts.listModels?.(params) ?? { models: [] });
    },
    onEvent: (
      fn: (method: string, params: Record<string, unknown>) => void,
    ) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return client as unknown as FakeClient;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetDmStore();
});

describe("#483 AC-1 models.list fails or empties -> welcome.engineHost fallback", () => {
  it("a rejected models.list falls back to welcome.engineHost.models", async () => {
    const client = fakeClient({
      listModels: async () => {
        throw new Error("engine_unavailable");
      },
    });
    const welcome = welcomeWith({
      models: HOST_MODELS,
      providers: HOST_PROVIDERS,
      defaultModel: "fake-large",
      defaultProvider: "fake",
    });
    watchDm(client, welcome);
    client.state.set("ready");
    await vi.waitFor(() => expect($catalog.get().models.length).toBe(2));
    expect($catalog.get()).toMatchObject({
      defaultModel: "fake-large",
      defaultProvider: "fake",
    });
    expect($catalog.get().models[0]).toMatchObject({
      id: "fake-large",
      name: "Fake Large",
      provider: "fake",
      defaultEffort: "low",
    });
    expect($catalog.get().providers[0]).toMatchObject({ id: "fake" });
    expect($catalogUnavailable.get()).toBe(false);
  });

  it("an empty models.list answer falls back the same way", async () => {
    const client = fakeClient({
      listModels: async () => ({ models: [] }),
    });
    const welcome = welcomeWith({
      models: HOST_MODELS,
      providers: HOST_PROVIDERS,
      defaultModel: "fake-small",
    });
    watchDm(client, welcome);
    client.state.set("ready");
    await vi.waitFor(() => expect($catalog.get().models.length).toBe(2));
    expect($catalog.get().defaultModel).toBe("fake-small");
    expect($catalogUnavailable.get()).toBe(false);
  });

  it("a slow models.list still shows the welcome catalog meanwhile", async () => {
    let resolve: (r: ModelsListResult) => void = () => {};
    const client = fakeClient({
      listModels: () =>
        new Promise<ModelsListResult>((r) => {
          resolve = r;
        }),
    });
    const welcome = welcomeWith({
      models: HOST_MODELS,
      providers: HOST_PROVIDERS,
      defaultModel: "fake-large",
    });
    watchDm(client, welcome);
    client.state.set("ready");
    await flush();
    /* The relay-cached catalog already renders while the live call hangs —
       the zombie-adapter case (#482) never blanks the chip. */
    expect($catalog.get().models.map((m) => m.id)).toEqual([
      "fake-large",
      "fake-small",
    ]);
    resolve({ models: [{ id: "live-model", provider: "live" }] });
    await vi.waitFor(() =>
      expect($catalog.get().models.map((m) => m.id)).toEqual(["live-model"]),
    );
  });

  it("a live models.list answer wins over the welcome fallback", async () => {
    const client = fakeClient({
      listModels: async () => ({
        models: [{ id: "live-model", provider: "live" }],
        default: "live-model",
      }),
    });
    const welcome = welcomeWith({
      models: HOST_MODELS,
      providers: HOST_PROVIDERS,
    });
    watchDm(client, welcome);
    client.state.set("ready");
    await vi.waitFor(() =>
      expect($catalog.get().models.map((m) => m.id)).toEqual(["live-model"]),
    );
    expect($catalog.get().defaultModel).toBe("live-model");
  });
});

describe('#483 AC-2 no models anywhere -> "Models unavailable" state', () => {
  it("rejected list + no welcome models marks the catalog unavailable", async () => {
    const client = fakeClient({
      listModels: async () => {
        throw new Error("engine_unavailable");
      },
    });
    watchDm(client, welcomeWith({ models: [] }));
    client.state.set("ready");
    await vi.waitFor(() => expect($catalogUnavailable.get()).toBe(true));
    expect($catalog.get().models).toEqual([]);
  });

  it("no welcome at all (engineHost absent) also marks unavailable", async () => {
    const client = fakeClient({
      listModels: async () => ({ models: [] }),
    });
    watchDm(client, welcomeWith());
    client.state.set("ready");
    await vi.waitFor(() => expect($catalogUnavailable.get()).toBe(true));
  });

  it("a retry (refreshModelCatalog) clears the flag when models land", async () => {
    let fail = true;
    const client = fakeClient({
      listModels: async () => {
        if (fail) throw new Error("engine_unavailable");
        return { models: [{ id: "back", provider: "fake" }] };
      },
    });
    const welcome = welcomeWith();
    watchDm(client, welcome);
    client.state.set("ready");
    await vi.waitFor(() => expect($catalogUnavailable.get()).toBe(true));
    fail = false;
    await refreshModelCatalog(client, welcome, { refresh: true });
    expect($catalog.get().models.map((m) => m.id)).toEqual(["back"]);
    expect($catalogUnavailable.get()).toBe(false);
  });
});

describe("#483 AC-3 the catalog refreshes on host.changed, not only reconnect", () => {
  it("host.changed connected:true re-calls models.list and fills the catalog", async () => {
    let fail = true;
    const client = fakeClient({
      listModels: async () => {
        if (fail) throw new Error("engine_unavailable");
        return { models: HOST_MODELS, default: "fake-large" };
      },
    });
    const welcome = welcomeWith({ connected: false });
    watchDm(client, welcome);
    client.state.set("ready");
    await vi.waitFor(() => expect($catalogUnavailable.get()).toBe(true));

    fail = false; // the host came back healthy
    client.emit("host.changed", { connected: true });
    await vi.waitFor(() => expect($catalog.get().models.length).toBe(2));
    expect(client.calls.filter((c) => c.method === "models.list")).toHaveLength(
      2,
    );
    expect($catalogUnavailable.get()).toBe(false);
    expect($catalog.get().defaultModel).toBe("fake-large");
  });

  it("host.changed connected:false does not re-fetch or clear the catalog", async () => {
    const client = fakeClient({
      listModels: async () => ({ models: HOST_MODELS }),
    });
    watchDm(client, welcomeWith({ models: HOST_MODELS }));
    client.state.set("ready");
    await vi.waitFor(() => expect($catalog.get().models.length).toBe(2));
    client.emit("host.changed", { connected: false });
    await flush();
    expect(client.calls.filter((c) => c.method === "models.list")).toHaveLength(
      1,
    );
    expect($catalog.get().models.length).toBe(2);
  });
});

describe("catalog load keeps what already landed", () => {
  it("a failed refresh never clobbers a live catalog", async () => {
    let fail = false;
    const client = fakeClient({
      listModels: async () => {
        if (fail) throw new Error("engine_unavailable");
        return { models: HOST_MODELS };
      },
    });
    const welcome = welcomeWith();
    watchDm(client, welcome);
    client.state.set("ready");
    await vi.waitFor(() => expect($catalog.get().models.length).toBe(2));
    fail = true;
    await refreshModelCatalog(client, welcome);
    expect($catalog.get().models.length).toBe(2);
    expect($catalogUnavailable.get()).toBe(false);
  });

  it("a NEW client (another paired Mac) drops the old catalog first", async () => {
    const clientA = fakeClient({
      listModels: async () => ({ models: HOST_MODELS }),
    });
    watchDm(clientA, welcomeWith());
    clientA.state.set("ready");
    await vi.waitFor(() => expect($catalog.get().models.length).toBe(2));

    /* Pairing to a different Mac creates a new client object; the old
       Mac's models must not ride over — client B has no engine host. */
    const clientB = fakeClient({
      listModels: async () => {
        throw new Error("engine_unavailable");
      },
    });
    watchDm(clientB, welcomeWith({ connected: false }));
    clientB.state.set("ready");
    await vi.waitFor(() => expect($catalogUnavailable.get()).toBe(true));
    expect($catalog.get().models).toHaveLength(0);
  });
});
