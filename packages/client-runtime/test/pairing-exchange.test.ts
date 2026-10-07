/* Issue #593 (folded #568): the grant exchange maps each relay refusal to
   its own reason — a wrong code ('unknown'), a dead code ('expired'/'used'),
   and a 429 'throttled' carrying Retry-After — and everything outside the
   protocol stays a plain failure so the phone says "can't reach", never
   "wrong code". Cancel/timeout ride the AbortSignal. */
import { describe, expect, test, vi } from "vitest";
import { exchangePairingGrant, PairingExchangeFailed } from "../src/pairing";

const okBody = {
  deviceId: "dev_1",
  credential: "devcred_abc",
  device: {
    id: "dev_1",
    name: "iPhone",
    credentialHash: "x",
    pairedAt: 1,
    lastSeenAt: 1,
  },
};

const res = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers,
  });

describe("exchangePairingGrant (#593)", () => {
  test("success returns the parsed credential", async () => {
    const fetchImpl = vi.fn(async () => res(200, okBody));
    await expect(
      exchangePairingGrant(
        "http://mac:4577",
        { code: "7K4MQR2X9TBP" },
        {
          fetchImpl,
        },
      ),
    ).resolves.toMatchObject({ deviceId: "dev_1" });
  });

  test.each(["unknown", "expired", "used"] as const)(
    "410 {%s} -> PairingExchangeFailed reason %s",
    async (reason) => {
      const fetchImpl = async () => res(410, { error: reason });
      await expect(
        exchangePairingGrant("http://mac:4577", { code: "X" }, { fetchImpl }),
      ).rejects.toMatchObject({ name: "PairingExchangeFailed", reason });
    },
  );

  test("429 throttled carries the Retry-After header as retryAfterMs", async () => {
    const fetchImpl = async () =>
      res(429, { error: "throttled" }, { "retry-after": "42" });
    try {
      await exchangePairingGrant(
        "http://mac:4577",
        { code: "X" },
        {
          fetchImpl,
        },
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PairingExchangeFailed);
      const err = e as PairingExchangeFailed;
      expect(err.reason).toBe("throttled");
      expect(err.retryAfterMs).toBe(42_000);
    }
  });

  test("429 without Retry-After still reads throttled (retryAfterMs absent)", async () => {
    const fetchImpl = async () => res(429, { error: "throttled" });
    await expect(
      exchangePairingGrant("http://mac:4577", { code: "X" }, { fetchImpl }),
    ).rejects.toMatchObject({ reason: "throttled", retryAfterMs: undefined });
  });

  test("a non-protocol error body (500 page, proxy) is NOT 'unknown'", async () => {
    /* Otherwise a dead Mac's captive-portal/500 would read 'wrong code'. */
    const fetchImpl = async () =>
      new Response("<html>nginx 500</html>", { status: 500 });
    await expect(
      exchangePairingGrant("http://mac:4577", { code: "X" }, { fetchImpl }),
    ).rejects.not.toBeInstanceOf(PairingExchangeFailed);
  });

  test("a malformed 200 payload is a protocol failure, not 'unknown'", async () => {
    const fetchImpl = async () => res(200, { hello: "world" });
    await expect(
      exchangePairingGrant("http://mac:4577", { code: "X" }, { fetchImpl }),
    ).rejects.not.toBeInstanceOf(PairingExchangeFailed);
  });

  test("AC-3 the caller's AbortSignal reaches fetch", async () => {
    const ac = new AbortController();
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBe(ac.signal);
      return new Promise<Response>((_resolve, reject) => {
        ac.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });
    const p = exchangePairingGrant(
      "http://mac:4577",
      { code: "X" },
      {
        fetchImpl,
        signal: ac.signal,
      },
    );
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
