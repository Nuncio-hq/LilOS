/* Issue #423: every DM action that rejects surfaces one plain toast line
   (AC-1); a failed `messages.list` propagates so the thread renders a
   retryable notice instead of silently missing history (AC-2); the model
   catalog survives a once-only `models.list` failure via the relay's
   hello-time `welcome.engineHost` cache plus bounded retries (AC-3). */
import { RelayError } from "@lilos/client-runtime";
import type { AppMessage, EngineHostStatus } from "@lilos/contracts/app";
import type { ModelsListResult } from "@lilos/contracts/engine";
import { beforeEach, describe, expect, test } from "vitest";
import {
  describeActionError,
  loadThreadHistory,
  toastOnFail,
} from "../src/lib/actions";
import {
  engineDefaultModel,
  engineDefaultProvider,
  engineModels,
  engineProviders,
  loadModelCatalog,
  mergeCatalogSeed,
} from "../src/lib/runtime";
import { toast } from "../src/lib/toast";

const msg = (over: Partial<AppMessage>): AppMessage => ({
  id: "m1",
  channelId: "ch1",
  conversationId: "c1",
  authorId: "user",
  authorKind: "user",
  text: "",
  seq: 1,
  createdAt: 0,
  rewound: false,
  dropped: false,
  removed: false,
  claimed: false,
  ...over,
});

describe("AC-1 describeActionError", () => {
  test("transport failures read as reconnecting, not raw codes", () => {
    for (const code of [
      "not_connected",
      "socket_closed",
      "closed",
      "connect_failed",
      "connect_timeout",
    ]) {
      expect(
        describeActionError(
          "Couldn't stop the turn",
          new RelayError("x", code),
        ),
      ).toBe(
        "Couldn't stop the turn — LilOS is reconnecting; try again in a moment.",
      );
    }
  });

  test("a request timeout reads as no answer", () => {
    expect(
      describeActionError(
        "Couldn't switch the model",
        new RelayError("request conversations.setModel timed out", "timeout"),
      ),
    ).toBe("Couldn't switch the model — the relay didn't answer; try again.");
  });

  test("a relay app error keeps the relay's reason in plain words", () => {
    expect(
      describeActionError(
        "Couldn't rename the session",
        new RelayError("conversation not found", "not_found"),
      ),
    ).toBe("Couldn't rename the session — conversation not found");
  });

  test("engine_unavailable reads as a lost connection, never 'engine host'", () => {
    /* Whatever jargon the wire carries, the toast says the plain thing. */
    for (const message of [
      "no engine host connected",
      "engine host did not answer in time",
      "the engine host is gone",
      "",
    ]) {
      expect(
        describeActionError(
          "Couldn't stop the turn",
          new RelayError(message, "engine_unavailable"),
        ),
      ).toBe(
        "Couldn't stop the turn — LilOS lost its connection to the agent. Try again in a moment.",
      );
    }
  });

  test("'engine host' wording never rides through under another code either", () => {
    expect(
      describeActionError(
        "Couldn't stop the turn",
        new RelayError("the engine host is gone", "engine_error"),
      ),
    ).toBe(
      "Couldn't stop the turn — LilOS lost its connection to the agent. Try again in a moment.",
    );
  });

  test("a bare error code or a stack tail never reaches the toast", () => {
    expect(
      describeActionError(
        "Couldn't archive the session",
        new RelayError("engine_unavailable", "engine_error"),
      ),
    ).toBe("Couldn't archive the session — try again.");
    expect(
      describeActionError(
        "Couldn't X",
        new Error("kaboom\n    at doThing (file.ts:12:3)"),
      ),
    ).toBe("Couldn't X — kaboom");
  });

  test("a non-relay error keeps its message; nothing -> the action alone", () => {
    expect(describeActionError("Couldn't X", new Error("boom"))).toBe(
      "Couldn't X — boom",
    );
    expect(describeActionError("Couldn't X", undefined)).toBe("Couldn't X");
  });

  test("jargon shapes collapse: invalid_params, errno codes, [object Object]", () => {
    /* "invalid params" is a refused request, not toast copy. */
    expect(
      describeActionError(
        "Couldn't rename the session",
        new RelayError("invalid params", "invalid_params"),
      ),
    ).toBe("Couldn't rename the session — try again.");
    /* errno-style reasons (ENOENT/ECONNREFUSED…) are codes, not words. */
    expect(
      describeActionError(
        "Couldn't open the file",
        new Error("ENOENT: no such file or directory, open '/tmp/x/y'"),
      ),
    ).toBe("Couldn't open the file — try again.");
    /* A rejection carrying a bare object never stringifies into the UI. */
    expect(describeActionError("Couldn't X", { weird: true })).toBe(
      "Couldn't X — try again.",
    );
  });
});

describe("AC-1 toastOnFail", () => {
  test("a rejecting action lands a plain-words error toast", async () => {
    toast.set(null);
    toastOnFail(
      "Couldn't archive the session",
      Promise.reject(new RelayError("engine down", "engine_unavailable")),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.get()).toEqual({
      text: "Couldn't archive the session — LilOS lost its connection to the agent. Try again in a moment.",
      error: true,
    });
    toast.set(null);
  });

  test("a resolving action says nothing", async () => {
    toast.set(null);
    toastOnFail("Couldn't archive the session", Promise.resolve());
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.get()).toBeNull();
  });
});

describe("AC-2 loadThreadHistory", () => {
  test("a rejected messages.list propagates instead of going silent", async () => {
    await expect(
      loadThreadHistory(
        () =>
          Promise.reject(
            new RelayError("relay not connected", "not_connected"),
          ),
        "ch1",
        "c1",
      ),
    ).rejects.toThrow("relay not connected");
  });

  test("pages messages.list until a short page, scoped to the conversation", async () => {
    const full = Array.from({ length: 200 }, (_, i) =>
      msg({ id: `m${i + 1}`, seq: i + 1 }),
    );
    const seen: Record<string, unknown>[] = [];
    const r = await loadThreadHistory(
      (_method, params) => {
        seen.push(params ?? {});
        return Promise.resolve({
          messages: params?.afterSeq === 0 ? full : [],
        });
      },
      "ch1",
      "c1",
    );
    expect(seen.map((p) => p.afterSeq)).toEqual([0, 200]);
    expect(seen[0]).toMatchObject({
      channelId: "ch1",
      conversationId: "c1",
      includeRewound: true,
      includeDropped: true,
    });
    expect(r.messages).toHaveLength(200);
  });

  test("rewound rows leave the visible list and fill the rewind sets", async () => {
    const r = await loadThreadHistory(
      () =>
        Promise.resolve({
          messages: [
            msg({ id: "keep", seq: 1 }),
            msg({
              id: "gone",
              seq: 2,
              rewound: true,
              authorKind: "employee",
              text: "  dropped answer  ",
            }),
            msg({ id: "keep2", seq: 3 }),
          ],
        }),
      "ch1",
      "c1",
    );
    expect(r.messages.map((m) => m.id)).toEqual(["keep", "keep2"]);
    expect(r.rewoundIds.has("gone")).toBe(true);
    expect(r.rewoundTexts.has("dropped answer")).toBe(true);
  });
});

describe("AC-3 loadModelCatalog", () => {
  const host = (models: { id: string; name?: string }[]): EngineHostStatus => ({
    connected: true,
    models,
  });

  beforeEach(() => {
    engineModels.set([]);
    engineProviders.set([]);
    engineDefaultModel.set(undefined);
    engineDefaultProvider.set(undefined);
  });

  test("a failed live list falls back to the hello-time engineHost rows", async () => {
    const ok = await loadModelCatalog(
      () =>
        Promise.reject(new RelayError("no engine host", "engine_unavailable")),
      host([{ id: "m1", name: "M1" }]),
      { retries: 1, retryMs: 0 },
    );
    expect(ok).toBe(true);
    expect(engineModels.get().map((m) => m.id)).toEqual(["m1"]);
  });

  test("a transient failure retries instead of leaving the picker empty", async () => {
    let calls = 0;
    const ok = await loadModelCatalog(
      () =>
        ++calls === 1
          ? Promise.reject<ModelsListResult>(
              new RelayError("request models.list timed out", "timeout"),
            )
          : Promise.resolve<ModelsListResult>({
              models: [{ id: "m9" }],
              default: "m9",
            }),
      undefined,
      { retries: 2, retryMs: 0 },
    );
    expect(calls).toBe(2);
    expect(ok).toBe(true);
    expect(engineModels.get().map((m) => m.id)).toEqual(["m9"]);
    expect(engineDefaultModel.get()).toBe("m9");
  });

  test("a live non-empty answer wins over the hello-time seed", async () => {
    const ok = await loadModelCatalog(
      () =>
        Promise.resolve<ModelsListResult>({
          models: [{ id: "live" }],
          default: "live",
          providers: [{ id: "prov" }],
        }),
      host([{ id: "stale" }]),
      { retries: 0 },
    );
    expect(ok).toBe(true);
    expect(engineModels.get().map((m) => m.id)).toEqual(["live"]);
    expect(engineDefaultModel.get()).toBe("live");
    expect(engineProviders.get().map((p) => p.id)).toEqual(["prov"]);
  });

  test("an answered-empty never blanks an already-known catalog", async () => {
    engineModels.set([{ id: "keep" }]);
    const ok = await loadModelCatalog(
      () => Promise.resolve<ModelsListResult>({ models: [] }),
      undefined,
      { retries: 0 },
    );
    expect(ok).toBe(true);
    expect(engineModels.get().map((m) => m.id)).toEqual(["keep"]);
  });

  test("no source has models -> reports false and the picker stays hidden", async () => {
    const ok = await loadModelCatalog(
      () => Promise.reject<ModelsListResult>(new Error("down")),
      undefined,
      { retries: 1, retryMs: 0 },
    );
    expect(ok).toBe(false);
    expect(engineModels.get()).toEqual([]);
  });

  test("a status poll after an empty hello refreshes the seed (CI: the picker stayed dead until reload)", () => {
    /* The hello-time engineHost predates the first models-carrying
       heartbeat — the status poll is what keeps the seed honest. */
    const seed = mergeCatalogSeed(host([]), {
      capabilities: [{ id: "models", name: "Models" }],
      models: [{ id: "late" }],
      defaultModel: "late",
    });
    expect(seed?.models?.map((m) => m.id)).toEqual(["late"]);
    expect(seed?.defaultModel).toBe("late");
  });

  test("a status block without a field never blanks the seed it had", () => {
    const seed = mergeCatalogSeed(host([{ id: "kept" }]), {
      capabilities: [{ id: "steer", name: "Steer" }],
    });
    expect(seed?.models?.map((m) => m.id)).toEqual(["kept"]);
    /* And a poll without an engine block leaves the seed alone. */
    expect(
      mergeCatalogSeed(host([{ id: "kept" }]), undefined)?.models?.[0]?.id,
    ).toBe("kept");
  });
});
