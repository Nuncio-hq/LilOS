import type { ExpoSendResult, PushSender } from "./push";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Expo caps each `/push/send` call at 100 tickets. */
const EXPO_CHUNK = 100;

interface ExpoTicket {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * The thin Expo push-service client (#161): one HTTP POST per ≤100-message
 * chunk to `exp.host`. Per-message results mirror the send order so the
 * fan-out can match receipts back to devices — a `DeviceNotRegistered`
 * errorCode is what lets it drop a dead token.
 *
 * Transport failures never throw: every message in the failed chunk comes
 * back as an error result so the caller logs it and moves on (AC-7 — push
 * is best-effort and must never block the relay).
 */
export function createExpoPushSender(options: {
  endpoint?: string;
  fetchImpl?: typeof fetch;
}): PushSender {
  const endpoint = options.endpoint ?? EXPO_PUSH_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (messages) => {
    const results: ExpoSendResult[] = [];
    for (let base = 0; base < messages.length; base += EXPO_CHUNK) {
      const chunk = messages.slice(base, base + EXPO_CHUNK);
      let tickets: ExpoTicket[] | undefined;
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(chunk),
        });
        const body = (await res.json()) as { data?: ExpoTicket[] };
        if (Array.isArray(body?.data) && body.data.length === chunk.length) {
          tickets = body.data;
        } else {
          for (let i = 0; i < chunk.length; i++) {
            results.push({
              index: base + i,
              status: "error",
              errorCode: "BadResponse",
              message: `unexpected push response (HTTP ${res.status})`,
            });
          }
          continue;
        }
      } catch (error) {
        for (let i = 0; i < chunk.length; i++) {
          results.push({
            index: base + i,
            status: "error",
            errorCode: "TransportError",
            message: String(error),
          });
        }
        continue;
      }
      tickets.forEach((ticket, i) => {
        if (ticket.status === "ok") {
          results.push({ index: base + i, status: "ok" });
        } else {
          results.push({
            index: base + i,
            status: "error",
            errorCode: ticket.details?.error,
            message: ticket.message,
          });
        }
      });
    }
    return results;
  };
}
