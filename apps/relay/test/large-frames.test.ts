import { RelayClient } from "@lilos/client-runtime";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { startRelay, wsFactory } from "./helpers";

/**
 * #551: the app socket's frame cap must sit above the largest send the
 * contract allows — Bun.serve's 16 MiB default dropped the socket (1006) on
 * multi-screenshot sends, which the client could only surface as
 * "reconnecting". These tests run a real spawned relay (`bun run
 * src/index.ts`), so they exercise the actual Bun.serve websocket config.
 *
 * The packaged relay (compiled binary, embedded Bun) is re-checked on the
 * same bound by the big-frame leg in `scripts/ci/smoke-bins.sh` — part of
 * `bun run build:harness` in `verify:fast`.
 */

const MiB = 1024 * 1024;
/** Bun.serve's websocket default — the cap the bug lived under. */
const OLD_DEFAULT = 16 * MiB;

/** Canonical base64 (the relay round-trip-checks it) of `bytes` same-valued bytes. */
const imageBytes = (bytes: number) =>
  Buffer.alloc(bytes, 0x89).toString("base64");

const attachment = (bytes: number, name = "shot.png") => ({
  name,
  mimeType: "image/png",
  dataBase64: imageBytes(bytes),
});

async function connectClient(relay: Awaited<ReturnType<typeof startRelay>>) {
  const client = new RelayClient({
    url: relay.url,
    token: relay.token,
    socketFactory: wsFactory().factory,
    autoReconnect: false,
    client: { name: "e2e-large-frames" },
  });
  await client.connect();
  return client;
}

async function dmChannel(client: RelayClient) {
  const { employee } = await client.request<{ employee: { id: string } }>(
    "employees.create",
    { name: "Ada", role: "eng" },
  );
  const { channel } = await client.request<{ channel: { id: string } }>(
    "channels.openDm",
    { employeeId: employee.id },
  );
  return channel;
}

describe("relay large frames (#551)", () => {
  it("AC-3 a ws frame above Bun's old 16 MiB default gets an answer, socket stays up", async () => {
    const relay = await startRelay();
    const client = await connectClient(relay);
    const channel = await dmChannel(client);

    // 2 × 9 MiB decoded → ~25 MB of base64 in one messages.post frame.
    const { message } = await client.request<{
      message: { id: string; attachments?: { sizeBytes: number }[] };
    }>(
      "messages.post",
      {
        channelId: channel.id,
        text: "two big screenshots",
        attachments: [
          attachment(9 * MiB, "a.png"),
          attachment(9 * MiB, "b.png"),
        ],
      },
      60_000,
    );
    expect(message.attachments).toHaveLength(2);
    expect(message.attachments?.[0].sizeBytes).toBe(9 * MiB);

    // The socket survived: a follow-up call answers on it.
    const pong = await client.request<{ ok: boolean; instanceId: string }>(
      "session.ping",
      {},
    );
    expect(pong.ok).toBe(true);
    client.close();
  }, 90_000);

  it("AC-1 the contract max — 10 images × 10 MB — posts in one send", async () => {
    const relay = await startRelay();
    const client = await connectClient(relay);
    const channel = await dmChannel(client);

    const attachments = Array.from(
      { length: MAX_ATTACHMENTS_PER_MESSAGE },
      (_, i) => attachment(MAX_ATTACHMENT_BYTES, `shot-${i}.png`),
    );
    const { message } = await client.request<{
      message: { attachments?: { sizeBytes: number }[] };
    }>(
      "messages.post",
      { channelId: channel.id, text: "ten max-size images", attachments },
      90_000,
    );
    expect(message.attachments).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(
      message.attachments?.every((a) => a.sizeBytes === MAX_ATTACHMENT_BYTES),
    ).toBe(true);

    const pong = await client.request<{ ok: boolean }>("session.ping", {});
    expect(pong.ok).toBe(true);
    client.close();
  }, 120_000);

  it("AC-2 an image over the per-file cap answers attachment_too_large — no socket drop", async () => {
    const relay = await startRelay();
    const client = await connectClient(relay);
    const channel = await dmChannel(client);

    // 13 MiB decoded → ~17.4 MB base64: over the old 16 MiB default AND over
    // the 10 MB per-attachment cap, so the frame must reach validation and
    // come back as a typed refusal — not a transport drop.
    const frameBytes = 4 * Math.ceil((13 * MiB) / 3);
    expect(frameBytes).toBeGreaterThan(OLD_DEFAULT);
    await expect(
      client.request(
        "messages.post",
        {
          channelId: channel.id,
          text: "too big",
          attachments: [attachment(13 * MiB)],
        },
        60_000,
      ),
    ).rejects.toMatchObject({ code: "attachment_too_large" });

    const pong = await client.request<{ ok: boolean }>("session.ping", {});
    expect(pong.ok).toBe(true);
    client.close();
  }, 90_000);
});
