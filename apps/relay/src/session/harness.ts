import { randomUUID } from "node:crypto";
import {
  HarnessRegisterParams,
  HarnessReportParams,
  type ProfileConnection,
  SystemStatusParams,
} from "@lilos/contracts/app";
import { buildSystemStatus } from "../status";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/** #413: order-insensitive signature of a report's connect rows — a roster
    reported in a different order is not a change worth broadcasting. */
const connectSignature = (rows: ProfileConnection[] | undefined): string =>
  rows === undefined
    ? ""
    : JSON.stringify(
        [...rows].sort((a, b) => a.profile.localeCompare(b.profile)),
      );

/**
 * Moved verbatim out of `../session.ts`'s handle() (#441) — case
 * bodies are byte-identical modulo re-indentation. Returns `false`
 * when `method` belongs to another namespace; `undefined` once handled.
 */
export async function handleHarness(c: RelayCtx): Promise<false | undefined> {
  let { host } = c;
  const { lastHostDisconnectedAt } = c;
  const {
    method,
    peer,
    id,
    params,
    options,
    store,
    rejectedHandshakes,
    logTail,
    log,
    now,
    protocolVersion,
    relayVersion,
    heartbeatFreshMs,
    broadcast,
    requireHost,
    recordRejection,
    respond,
  } = c;
  switch (method) {
    case "harness.register": {
      const parsed = HarnessRegisterParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      // Same handshake rule as session.hello (issue #33): a mismatched
      // harness fails loudly here instead of registering half-spoken.
      if (parsed.data.protocolVersion !== protocolVersion) {
        recordRejection({
          kind: "register",
          claimed: parsed.data.protocolVersion,
          at: now(),
        });
        log(
          `harness.register rejected: spoke protocol ${parsed.data.protocolVersion} v${parsed.data.version}, relay is ${protocolVersion}`,
        );
        throw new RpcError(
          JsonRpcCode.protocolVersionMismatch,
          "protocol_version_mismatch",
          "protocol version mismatch",
          {
            update:
              parsed.data.protocolVersion > protocolVersion
                ? "relay"
                : "harness",
            clientVersion: parsed.data.protocolVersion,
            serverVersion: protocolVersion,
          },
        );
      }
      if (host !== null && host.peer !== peer) {
        log("harness.register rejected: another host is registered");
        throw new RpcError(
          JsonRpcCode.conflict,
          "conflict",
          "an engine host is already registered",
        );
      }
      const wasEmpty = !host;
      if (!host) {
        host = {
          peer,
          hostId: `host_${randomUUID()}`,
          version: parsed.data.version,
          protocolVersion: parsed.data.protocolVersion,
          registeredAt: now(),
        };
      } else {
        host.version = parsed.data.version;
        host.protocolVersion = parsed.data.protocolVersion;
      }
      c.host = host;
      log(`harness.register accepted (${host.hostId} v${host.version})`);
      if (wasEmpty) broadcast("host.changed", { connected: true });
      respond(peer, id, {
        hostId: host.hostId,
        pending: await store.listPendingTurns(),
      });
      return;
    }
    case "harness.report": {
      const parsed = HarnessReportParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      requireHost(peer);
      if (host) {
        if (
          host.engine?.state !== parsed.data.engine.state ||
          host.engine?.detail !== parsed.data.engine.detail
        ) {
          log(
            `engine state ${host.engine?.state ?? "unknown"} -> ${parsed.data.engine.state}${parsed.data.engine.detail ? ` (${parsed.data.engine.detail})` : ""}`,
          );
          /* #482: engine-state flips reach every subscribed client live
             (the phone's Mac-sheet + desktop System status refresh) —
             before this, a dead-backend outage only showed on the next
             status poll. Detail rides the same flip: a new restart
             reason — or its clearing — is the signal too. */
          broadcast("host.changed", {
            connected: true,
            engine: parsed.data.engine,
          });
        }
        host.engine = parsed.data.engine;
        host.lastReportAt = now();
        if (parsed.data.status) {
          /* #413: the DM notice and Settings → Engine read `connect` off
             `system.status` — push the rows live when they change instead
             of leaving surfaces on the next poll. */
          const prev = connectSignature(host.status?.connect);
          host.status = parsed.data.status;
          if (prev !== connectSignature(host.status.connect)) {
            broadcast("connect.changed", {
              connect: host.status.connect,
            });
          }
        }
      }
      respond(peer, id, { ok: true });
      return;
    }
    case "system.status": {
      const parsed = SystemStatusParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      respond(
        peer,
        id,
        buildSystemStatus({
          protocolVersion,
          relayVersion,
          now: now(),
          heartbeatFreshMs,
          host,
          lastHostDisconnectedAt,
          rejected: rejectedHandshakes,
          relayLogTail: (n) => logTail.tail(n),
          logLines: parsed.data.logLines,
          secrets: [options.token],
        }),
      );
      return;
    }
    default:
      return false;
  }
}
